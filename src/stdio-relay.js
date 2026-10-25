import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { CONTINUATION_LOGGER, observeRelayedReply, startContinuationMonitor } from './continuation.js'
import { CLIENT_CWD_HEADER } from './request-context.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './mcp-server.js'
import { gitToplevel } from './git-adapter.js'
import { DEFAULT_CODEMODE_TIMEOUT_MS } from './codemode-budget.js'

const RELAY_ERROR_CODE = -32000
const PARSE_ERROR_CODE = -32700
const SSE_CONTENT_TYPE = 'text/event-stream'
const SSE_DATA_PREFIX = 'data:'
const RETRY_DELAYS_MS = [250, 1000, 2000, 4000]
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED'])
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])
const LOCAL_INIT_ID = 'gm-relay-local-init'
const RELAY_BUDGET_MS = (Number(process.env.GM_CODEMODE_TIMEOUT_MS) > 0 ? Number(process.env.GM_CODEMODE_TIMEOUT_MS) : DEFAULT_CODEMODE_TIMEOUT_MS) + 5000
const HEALTH_PROBE_MS = 1500
const RESTART_BUDGET_MS = 8000
// After a failed relay restart (a re-probe for an HTTP server a human started with --http), calls in this window skip the
// health probe and are served in-process. A server that comes back inside the window is picked up once it expires (find9-relay-restart-probe-latency).
const RESTART_COOLDOWN_MS = 30_000
const LOCAL_START_BUDGET_MS = 15000

function within(promise, ms, layer) {
    let timer
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${layer} did not answer within ${ms} ms`)), ms)
    })
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

async function httpLive(url) {
    try {
        const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(HEALTH_PROBE_MS) })
        return response.ok
    } catch {
        return false
    }
}

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
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(line), [CLIENT_CWD_HEADER]: process.cwd() },
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

function portOf(url) {
    try {
        return new URL(url).port || 'default'
    } catch {
        return 'unparsed'
    }
}

function isTransient(error) {
    const code = error?.cause?.code ?? error?.code
    return TRANSIENT_CODES.has(code)
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const remainingMs = (deadline) => Math.max(1, deadline - Date.now())

async function postWithRetry(url, line, method) {
    let failure = null
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt > 0) {
            if (!isTransient(failure)) break
            if (method === 'tools/call' && !NOT_SENT_CODES.has(failure?.cause?.code ?? failure?.code)) break
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

const PRD_ADD_VERB = /^prd[-_]add$/
const PRD_ADD_IN_CODE = /prd[-_]add/

function prdAddWithoutCwd(request) {
    const name = request.params?.name
    const args = request.params?.arguments
    if (name === 'prd_add' || name === 'prd-add') return true
    if (name === 'gm' && PRD_ADD_VERB.test(String(args?.verb ?? ''))) return true
    return name === 'gm_codemode' && typeof args?.code === 'string' && PRD_ADD_IN_CODE.test(args.code)
}

function withDefaultCwd(request, line, defaultCwd) {
    if (!defaultCwd || request?.method !== 'tools/call') return line
    const args = request.params?.arguments
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) return line
    if (args && typeof args.cwd === 'string' && args.cwd.trim()) return line
    if (prdAddWithoutCwd(request)) return line
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
        async handle(request, budgetMs = RELAY_BUDGET_MS) {
            ready ??= within(start(), LOCAL_START_BUDGET_MS, 'in-process fallback start').catch((error) => {
                ready = null
                throw error
            })
            const local = await ready
            if (request.id === undefined || request.id === null) {
                await local.notify(request)
                return null
            }
            if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: (await within(local.exchange({ ...request, id: LOCAL_INIT_ID + '-again' }), budgetMs, 'in-process fallback')).result }
            return within(local.exchange(request), budgetMs, 'in-process fallback')
        },
    }
}

function restartCoolingDown(state) {
    return state.restartFailedAt != null && Date.now() - state.restartFailedAt < RESTART_COOLDOWN_MS
}

async function restartSingleton(recover, state) {
    if (!recover || restartCoolingDown(state)) return null
    const restarted = await within(recover(), RESTART_BUDGET_MS, 'http singleton restart').catch((error) => {
        appendDiagnostic('stdio-relay-restart-failed', { url: state.url, error: describeError(error) })
        return null
    })
    if (restarted) {
        state.url = restarted
        state.restartFailedAt = null
    } else {
        state.restartFailedAt = Date.now()
    }
    return restarted
}

const LIVE_PROBE_TTL_MS = 2_000

async function httpLiveCached(state) {
    const now = Date.now()
    const cached = state.liveProbe
    if (cached && cached.url === state.url && now - cached.at < LIVE_PROBE_TTL_MS) return cached.live
    const live = await httpLive(state.url)
    state.liveProbe = { url: state.url, at: now, live }
    return live
}

async function forwardLine(line, recover, state) {
    let request
    try {
        request = JSON.parse(line)
    } catch (error) {
        const diagnosticId = randomUUID()
        appendDiagnostic('stdio-relay-parse-error', { diagnostic_id: diagnosticId, error: describeError(error) })
        writeFrame(errorFrame(null, PARSE_ERROR_CODE, `gm-mcp relay: frame is not JSON: ${describeError(error)}. Diagnostic id ${diagnosticId} (log ${logFilePath()}, event stdio-relay-parse-error).`))
        return
    }
    const expectsReply = request && typeof request === 'object' && request.id !== undefined && request.id !== null
    if (request?.method === 'initialize') state.initializeParams = request.params
    const outbound = withDefaultCwd(request, line, state.defaultCwd)
    const routedRequest = outbound === line ? request : JSON.parse(outbound)
    const deadline = Date.now() + RELAY_BUDGET_MS
    if (state.local.active() && (restartCoolingDown(state) || (!(await httpLiveCached(state)) && !(await restartSingleton(recover, state))))) return deliverLocal(state, routedRequest, expectsReply, null, deadline)
    let target = state.url
    let { reply, failure } = await within(postWithRetry(target, outbound, request?.method ?? null), remainingMs(deadline), 'http singleton call').catch((error) => ({ reply: null, failure: error }))
    if (!reply) {
        state.liveProbe = null
        const restarted = await restartSingleton(recover, state)
        if (restarted) {
            target = restarted
            ;({ reply, failure } = await within(postWithRetry(target, outbound, request?.method ?? null), remainingMs(deadline), 'http singleton call after restart').catch((error) => ({ reply: null, failure: error })))
        }
    }
    if (!reply) {
        appendDiagnostic('stdio-relay-unreachable', { url: target, method: request?.method ?? null, error: describeError(failure) })
        return deliverLocal(state, routedRequest, expectsReply, failure, deadline)
    }
    if (!expectsReply) return
    for (const frame of framesFromResponse(reply.contentType, reply.text)) {
        observeFrame(frame)
        writeFrame(frame)
    }
}

async function deliverLocal(state, request, expectsReply, relayFailure = null, deadline = Date.now() + RELAY_BUDGET_MS) {
    try {
        const message = await state.local.handle(request, remainingMs(deadline))
        if (!expectsReply || !message) return
        const frame = JSON.stringify(message)
        observeFrame(frame)
        writeFrame(frame)
    } catch (error) {
        const diagnosticId = randomUUID()
        appendDiagnostic('stdio-relay-local-failed', { diagnostic_id: diagnosticId, method: request?.method ?? null, error: describeError(error) })
        if (expectsReply) writeFrame(errorFrame(request.id, RELAY_ERROR_CODE, `gm-mcp relay failed at two layers. gm-mcp runs over stdio, and this session opens no listening port. Layer 1, relay to the HTTP server at ${state.url} (port ${portOf(state.url)}): unreachable (${describeError(relayFailure)}) after ${RETRY_DELAYS_MS.length} retries and one restart. Layer 2, in-process fallback: ${describeError(error)}. Diagnostic id ${diagnosticId} (log ${logFilePath()}, event stdio-relay-local-failed). Next step: relaunch the session to pick up a new bundle, then re-dispatch; reads answered empty during this window were not searched.`))
    }
}

export function serveStdioRelay({ url, recover = null, initializeParams = null }) {
    const state = { url, defaultCwd: launchRootDefault(), initializeParams, local: null }
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
