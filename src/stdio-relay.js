import { createInterface } from 'node:readline'
import { request as httpRequest } from 'node:http'
import { appendDiagnostic, describeError } from './server-log.js'
import { CONTINUATION_LOGGER, observeRelayedReply, startContinuationMonitor } from './continuation.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './mcp-server.js'
import { gitToplevel } from './git-adapter.js'

const RELAY_ERROR_CODE = -32000
const PARSE_ERROR_CODE = -32700
const SSE_CONTENT_TYPE = 'text/event-stream'
const SSE_DATA_PREFIX = 'data:'
const RETRY_DELAYS_MS = [250, 1000]
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED'])
const LOCAL_INIT_ID = 'gm-relay-local-init'

function writeFrame(text) {
    const body = text.trim()
    if (body) process.stdout.write(`${body}\n`)
}

function errorFrame(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

function framesFromResponse(contentType, text) {
    if (!contentType.includes(SSE_CONTENT_TYPE)) return [text]
    return text.split('\n').filter((line) => line.startsWith(SSE_DATA_PREFIX)).map((line) => line.slice(SSE_DATA_PREFIX.length).trim()).filter(Boolean)
}

function observeFrame(frame) {
    let message
    try {
        message = JSON.parse(frame)
    } catch {
        return
    }
    for (const item of message?.result?.content ?? []) {
        if (item?.type === 'text') observeRelayedReply(item.text)
    }
}

function emitContinuation(params) {
    writeFrame(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params }))
}

function post(url, line) {
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(line) },
        }, (response) => {
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () => resolve({ contentType: String(response.headers['content-type'] || ''), text: Buffer.concat(chunks).toString('utf8') }))
            response.on('error', reject)
        })
        request.on('error', reject)
        request.end(line)
    })
}

function isTransient(error) {
    const code = error?.cause?.code ?? error?.code
    return TRANSIENT_CODES.has(code)
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function postWithRetry(url, line, method) {
    let failure = null
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt > 0) {
            if (!isTransient(failure)) break
            await pause(RETRY_DELAYS_MS[attempt - 1])
        }
        try {
            return { reply: await post(url, line), failure: null }
        } catch (error) {
            failure = error
            appendDiagnostic('stdio-relay-forward-failed', { url, method, attempt, error: describeError(error) })
        }
    }
    return { reply: null, failure }
}

function launchRootDefault() {
    const launched = process.cwd()
    try {
        return gitToplevel(launched) === launched ? launched : null
    } catch {
        return null
    }
}

function withDefaultCwd(request, line, defaultCwd) {
    if (!defaultCwd || request?.method !== 'tools/call') return line
    const args = request.params?.arguments
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) return line
    if (args && typeof args.cwd === 'string' && args.cwd.trim()) return line
    return JSON.stringify({ ...request, params: { ...request.params, arguments: { ...(args ?? {}), cwd: defaultCwd } } })
}

function createLocalFallback(initializeParams) {
    const pending = new Map()
    let ready = null
    const start = async () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        clientSide.onmessage = (message) => {
            const waiter = message?.id !== undefined ? pending.get(message.id) : undefined
            if (waiter) {
                pending.delete(message.id)
                waiter(message)
                return
            }
            if (message?.id === undefined) writeFrame(JSON.stringify(message))
        }
        await createServer().connect(serverSide)
        await clientSide.start()
        const exchange = (message) => new Promise((resolve) => {
            pending.set(message.id, resolve)
            clientSide.send(message)
        })
        await exchange({ jsonrpc: '2.0', id: LOCAL_INIT_ID, method: 'initialize', params: initializeParams() })
        await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        appendDiagnostic('stdio-relay-local-fallback', { pid: process.pid })
        console.error('gm-mcp: HTTP relay unreachable after retries; serving this session in-process over the spool')
        return { exchange, notify: (message) => clientSide.send(message) }
    }
    return {
        active: () => ready !== null,
        async handle(request) {
            ready ??= start()
            const local = await ready
            if (request.id === undefined || request.id === null) {
                await local.notify(request)
                return null
            }
            if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: (await local.exchange({ ...request, id: LOCAL_INIT_ID + '-again' })).result }
            return local.exchange(request)
        },
    }
}

async function forwardLine(line, recover, state) {
    let request
    try {
        request = JSON.parse(line)
    } catch (error) {
        writeFrame(errorFrame(null, PARSE_ERROR_CODE, `gm-mcp relay: frame is not JSON: ${describeError(error)}`))
        return
    }
    const expectsReply = request && typeof request === 'object' && request.id !== undefined && request.id !== null
    if (request?.method === 'initialize') state.initializeParams = request.params
    const outbound = withDefaultCwd(request, line, state.defaultCwd)
    const routedRequest = outbound === line ? request : JSON.parse(outbound)
    if (state.local.active()) return deliverLocal(state, routedRequest, expectsReply)
    let target = state.url
    let { reply, failure } = await postWithRetry(target, outbound, request?.method ?? null)
    if (!reply && recover) {
        const restarted = await recover().catch(() => null)
        if (restarted) {
            target = restarted
            state.url = restarted
            ;({ reply, failure } = await postWithRetry(target, outbound, request?.method ?? null))
        }
    }
    if (!reply) {
        appendDiagnostic('stdio-relay-unreachable', { url: target, method: request?.method ?? null, error: describeError(failure) })
        return deliverLocal(state, routedRequest, expectsReply, failure)
    }
    if (!expectsReply) return
    for (const frame of framesFromResponse(reply.contentType, reply.text)) {
        observeFrame(frame)
        writeFrame(frame)
    }
}

async function deliverLocal(state, request, expectsReply, relayFailure = null) {
    try {
        const message = await state.local.handle(request)
        if (!expectsReply || !message) return
        const frame = JSON.stringify(message)
        observeFrame(frame)
        writeFrame(frame)
    } catch (error) {
        appendDiagnostic('stdio-relay-local-failed', { method: request?.method ?? null, error: describeError(error) })
        if (expectsReply) writeFrame(errorFrame(request.id, RELAY_ERROR_CODE, `gm-mcp relay: HTTP server ${state.url} unreachable (${describeError(relayFailure)}) after ${RETRY_DELAYS_MS.length} retries and a restart, and the in-process fallback failed (${describeError(error)})`))
    }
}

export function serveStdioRelay({ url, recover = null }) {
    const state = { url, defaultCwd: launchRootDefault(), initializeParams: null, local: null }
    state.local = createLocalFallback(() => state.initializeParams ?? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gm-mcp-relay', version: '0' } })
    let inFlight = 0
    let inputClosed = false
    const finishIfDone = () => {
        if (inputClosed && inFlight === 0) process.exit(0)
    }
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
    input.on('line', (line) => {
        if (!line.trim()) return
        inFlight += 1
        forwardLine(line, recover, state).finally(() => {
            inFlight -= 1
            finishIfDone()
        })
    })
    input.on('close', () => {
        inputClosed = true
        finishIfDone()
    })
    startContinuationMonitor(emitContinuation)
    appendDiagnostic('stdio-relay-start', { url, pid: process.pid, logger: CONTINUATION_LOGGER, default_cwd: state.defaultCwd })
    console.error(`gm-mcp: connected, serving on stdio, relaying to ${url}`)
}
