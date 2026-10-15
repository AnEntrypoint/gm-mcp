import { createInterface } from 'node:readline'
import { appendDiagnostic, describeError } from './server-log.js'

const RELAY_ERROR_CODE = -32000
const PARSE_ERROR_CODE = -32700

function writeFrame(text) {
    const body = text.trim()
    if (body) process.stdout.write(`${body}\n`)
}

function errorFrame(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

// One JSON-RPC body per POST: the stateless HTTP transport answers JSON (or an SSE
// frame stream when it chooses one), and notifications answer 202 with no body.
function framesFromResponse(contentType, text) {
    if (!contentType.includes('text/event-stream')) return [text]
    return text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
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
        for (const frame of framesFromResponse(contentType, text)) writeFrame(frame)
    } catch (error) {
        appendDiagnostic('stdio-relay-forward-failed', { url, method: request?.method ?? null, error: describeError(error) })
        if (expectsReply) writeFrame(errorFrame(request.id, RELAY_ERROR_CODE, `gm-mcp relay: HTTP server at ${url} unreachable: ${describeError(error)}`))
    }
}

// Forwards each stdin frame to the shared HTTP singleton and writes its reply to stdout.
// Starts no watchers and no server: the HTTP process owns those. Requests run concurrently;
// JSON-RPC replies carry their id, so their order on stdout does not matter.
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
    appendDiagnostic('stdio-relay-start', { url, pid: process.pid })
    console.error(`gm-mcp: relaying stdio to ${url}`)
}
