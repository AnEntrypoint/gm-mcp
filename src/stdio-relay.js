import { createInterface } from 'node:readline'
import { appendDiagnostic, describeError } from './server-log.js'
import { CONTINUATION_LOGGER, observeRelayedReply, startContinuationMonitor } from './continuation.js'

const RELAY_ERROR_CODE = -32000
const PARSE_ERROR_CODE = -32700
const SSE_CONTENT_TYPE = 'text/event-stream'
const SSE_DATA_PREFIX = 'data:'

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

async function forwardLine(url, line) {
    let request
    try {
        request = JSON.parse(line)
    } catch (error) {
        writeFrame(errorFrame(null, PARSE_ERROR_CODE, `gm-mcp relay: frame is not JSON: ${describeError(error)}`))
        return
    }
    const expectsReply = request && typeof request === 'object' && request.id !== undefined && request.id !== null
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: line,
        })
        const contentType = response.headers.get('content-type') || ''
        const text = await response.text()
        if (!expectsReply) return
        for (const frame of framesFromResponse(contentType, text)) {
            observeFrame(frame)
            writeFrame(frame)
        }
    } catch (error) {
        appendDiagnostic('stdio-relay-forward-failed', { url, method: request?.method ?? null, error: describeError(error) })
        if (expectsReply) writeFrame(errorFrame(request.id, RELAY_ERROR_CODE, `gm-mcp relay: HTTP server at ${url} unreachable: ${describeError(error)}`))
    }
}

export function serveStdioRelay({ url }) {
    let inFlight = 0
    let inputClosed = false
    const finishIfDone = () => {
        if (inputClosed && inFlight === 0) process.exit(0)
    }
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
    input.on('line', (line) => {
        if (!line.trim()) return
        inFlight += 1
        forwardLine(url, line).finally(() => {
            inFlight -= 1
            finishIfDone()
        })
    })
    input.on('close', () => {
        inputClosed = true
        finishIfDone()
    })
    startContinuationMonitor(emitContinuation)
    appendDiagnostic('stdio-relay-start', { url, pid: process.pid, logger: CONTINUATION_LOGGER })
    console.error(`gm-mcp: connected, serving on stdio, relaying to ${url}`)
}
