import { createServer as createHttpServer } from 'node:http'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './mcp-server.js'
import { inflightDispatchCount } from './dispatch.js'
import { keepServingOnAsyncFailure, logSignalExits } from './transport-guard.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { BUNDLE_VERSION } from './bundle-version.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787
export const MCP_PATH = '/mcp'
export const HEALTH_PATH = '/health'

// No idle reaping: a client holds one keep-alive socket for the whole session
// and reuses it minutes later. Node closes such a socket at its
// keepAliveTimeout, and the next POST the client writes to it fails in a way an
// MCP client is allowed to read as a whole-session disconnect -- an idle gap is
// not an error and must not cost the session. Nothing on this server is
// per-connection state, so a socket may stay open as long as its client wants
// it. headersTimeout has to stay above keepAliveTimeout.
export const HTTP_KEEPALIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const HTTP_HEADERS_TIMEOUT_MS = HTTP_KEEPALIVE_TIMEOUT_MS + 60_000

// A client that opens a standalone SSE stream (GET /mcp) must be given one that
// stays open: a 405 there is a status an MCP client may also read as fatal.
// This server has nothing to push, so the stream is heartbeats only. Bounded in
// count and in age so a client that never closes one cannot leak a socket.
const SSE_HEARTBEAT_MS = 15_000
const SSE_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000
const SSE_MAX_OPEN_STREAMS = 64
const HTTP_HEARTBEAT_MS = 5 * 60 * 1000
let openSseStreams = 0

function flagValue(name) {
    const args = process.argv.slice(2)
    const index = args.indexOf(`--${name}`)
    if (index === -1) return undefined
    const next = args[index + 1]
    return next && !next.startsWith('--') ? next : undefined
}

export function httpListenOptions() {
    const port = Number(flagValue('port') ?? process.env.GM_MCP_HTTP_PORT ?? DEFAULT_PORT)
    const host = flagValue('host') ?? process.env.GM_MCP_HTTP_HOST ?? DEFAULT_HOST
    return { port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT, host: host || DEFAULT_HOST }
}

// MCP says a server that cannot serve the version a client asks for answers in
// the version it does. The bundled SDK does the opposite: `initialize` is exempt
// from its `mcp-protocol-version` check, but every later POST -- notifications,
// tools/list, tools/call -- is rejected 400 when the header names a version
// newer than the SDK knows (2026-07-28 is what current Claude Code sends). The
// client therefore connects, then reads as dead: no tool call is ever served.
// Speak the newest version we do support instead of refusing the request.
const SERVED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

const REQUIRED_ACCEPT_TYPES = ['application/json', 'text/event-stream']
const SERVED_ACCEPT_HEADER = REQUIRED_ACCEPT_TYPES.join(', ')

function normalizeProtocolVersion(req) {
    const requested = req.headers['mcp-protocol-version']
    if (typeof requested !== 'string' || SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return
    req.headers['mcp-protocol-version'] = SERVED_PROTOCOL_VERSION
    // The web Request the SDK sees is built from `rawHeaders`, not from the
    // parsed `headers` map, so both have to carry the served version.
    const raw = req.rawHeaders
    if (Array.isArray(raw)) {
        for (let i = 0; i + 1 < raw.length; i += 2) {
            if (typeof raw[i] === 'string' && raw[i].toLowerCase() === 'mcp-protocol-version') raw[i + 1] = SERVED_PROTOCOL_VERSION
        }
    }
    appendDiagnostic('http-protocol-version-normalized', { requested, served: SERVED_PROTOCOL_VERSION })
}

function acceptNamesBothTypes(value) {
    if (typeof value !== 'string') return false
    const lowered = value.toLowerCase()
    return REQUIRED_ACCEPT_TYPES.every((type) => lowered.includes(type))
}

function normalizeAcceptHeader(req) {
    if (acceptNamesBothTypes(req.headers?.accept)) return
    const requested = typeof req.headers?.accept === 'string' ? req.headers.accept : null
    if (req.headers) req.headers.accept = SERVED_ACCEPT_HEADER
    const raw = req.rawHeaders
    if (Array.isArray(raw)) {
        let rewritten = false
        for (let i = 0; i + 1 < raw.length; i += 2) {
            if (typeof raw[i] === 'string' && raw[i].toLowerCase() === 'accept') {
                raw[i + 1] = SERVED_ACCEPT_HEADER
                rewritten = true
            }
        }
        if (!rewritten) raw.push('Accept', SERVED_ACCEPT_HEADER)
    }
    appendDiagnostic('http-accept-normalized', { requested, served: SERVED_ACCEPT_HEADER })
}

function rejectOversizedBody(req, res) {
    if (Number(req.headers['content-length'] || 0) <= MAX_BODY_BYTES) return false
    sendJson(res, 413, { error: `request body exceeds the ${MAX_BODY_BYTES} byte cap` })
    return true
}

// A fresh server and transport per request is the SDK's own stateless shape:
// one shared stateless transport answers its first request and then 500s every
// later one, which would be a worse failure than the stdio drop it replaces.
// Nothing is carried between requests, so a client that vanishes mid-call can
// never leave the server holding state for a session that is gone.
// Every POST body is read here, whatever encoding it arrives in, so a body that
// cannot be read or parsed never reaches the SDK. The SDK turns any body it
// cannot turn into a JSON-RPC message into 400 with JSON-RPC code -32700
// (`Parse error`), and -32700 is the one reply an MCP client is allowed to read
// as a fatal protocol error and turn into a whole-session disconnect -- 46 of
// them are in gm-mcp-server.log, the last one from the server that is listening
// right now. A body we cannot use is answered 202 instead: accepted, nothing to
// read, session intact. Oversized bodies hit the same cap either way.
async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
        chunks.push(chunk)
        size += chunk.length
        if (size > MAX_BODY_BYTES) return { tooLarge: true, size }
    }
    return { buffer: Buffer.concat(chunks) }
}

// A JSON-RPC message is an object carrying `jsonrpc: "2.0"`, or a batch of
// them. Anything else -- a bare object, a bare string, an empty batch -- is what
// makes the SDK answer -32700, so it is answered here instead.
function isJsonRpcMessage(value) {
    if (Array.isArray(value)) return value.length > 0 && value.every(isJsonRpcMessage)
    return Boolean(value) && typeof value === 'object' && value.jsonrpc === '2.0'
}

// A notification is a JSON-RPC message with a `method` and no `id`: the client
// is not asking for anything and there is no reply to send it.
function isJsonRpcNotification(value) {
    if (Array.isArray(value)) return value.length > 0 && value.every(isJsonRpcNotification)
    return Boolean(value) && typeof value === 'object' && value.jsonrpc === '2.0' && typeof value.method === 'string' && value.id === undefined
}

// Answering a notification 202 Accepted is what makes an MCP client open a
// standalone `GET /mcp` SSE stream. The SDK client reads 202 on
// `notifications/initialized` as "accepted, and I will push to you later" and
// immediately calls `_startOrAuthSse`, then waits on that stream for the life of
// the session. This server has nothing to push, so the stream is a bare
// heartbeat -- and it is the session's only long-lived connection. Every time it
// ends (a client-side idle timeout, a reaped socket, any abort) the SDK raises
// `transport.onerror("SSE stream disconnected")` and re-GETs at once; a host
// that counts those errors exhausts its reconnect budget, marks the server
// failed, and never dials again -- every later call answering "has disconnected"
// while this server is provably up and still serving other clients. That is the
// whole dropout, so the notification that opens the stream is answered 200 with
// no body instead: the client's `send()` falls into its "no requests in message
// but got 200 OK" branch, releases the connection, and opens no stream at all.
// Only the status changes, and only for notifications -- a request still gets
// its JSON reply exactly as before.
function answerNotificationsWithOk(res) {
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status, ...rest) => (status === 202 ? writeHead(200, ...rest) : writeHead(status, ...rest))
}

function bodyPreview(buffer) {
    const text = buffer.toString('utf8')
    return text.length > 400 ? `${text.slice(0, 400)}...` : text
}

function rejectUnusableBody(res, event, fields) {
    appendDiagnostic(event, fields)
    sendAccepted(res)
}

function sendAccepted(res) {
    res.writeHead(202, { 'content-length': 0, 'cache-control': 'no-store' })
    res.end()
}

// Nothing here exits, and nothing here answers -32700. A 400 carrying a JSON-RPC
// parse error is the one reply an MCP client is allowed to read as fatal and
// turn into a whole-session disconnect, so every request this server cannot use
// is answered 202 ("accepted, nothing to read") and logged instead. The tool
// surface is unchanged: a well-formed request is served exactly as before.
async function serveMcpRequest(req, res) {
    if (req.method === 'GET') {
        serveSseHeartbeat(req, res)
        return
    }
    // A client terminating its session has nothing to terminate here -- there is
    // no session -- and a 405 is a status a client may read as fatal.
    if (req.method === 'DELETE') {
        sendAccepted(res)
        return
    }
    if (req.method !== 'POST') {
        appendDiagnostic('http-method-refused', { path: MCP_PATH, method: req.method })
        sendJson(res, 405, { error: `POST JSON-RPC to ${MCP_PATH}` }, { allow: 'GET, POST, DELETE' })
        return
    }
    if (rejectOversizedBody(req, res)) return
    // An empty POST is a keepalive or a port probe, not a client sending a
    // broken frame; read it and decide from the bytes either way.
    const read = await readBody(req)
    if (read.tooLarge) {
        sendJson(res, 413, { error: `request body exceeds the ${MAX_BODY_BYTES} byte cap` })
        return
    }
    const buffer = read.buffer ?? Buffer.alloc(0)
    if (buffer.toString('utf8').trim().length === 0) {
        appendDiagnostic('http-empty-body-ignored', { path: MCP_PATH, remote: req.socket?.remotePort ?? null })
        sendAccepted(res)
        return
    }
    let parsedBody
    try {
        parsedBody = JSON.parse(buffer.toString('utf8'))
    } catch (error) {
        rejectUnusableBody(res, 'http-body-unparseable', {
            path: MCP_PATH,
            content_length: req.headers['content-length'] ?? null,
            bytes: buffer.length,
            preview: bodyPreview(buffer),
            error: describeError(error),
        })
        return
    }
    if (!isJsonRpcMessage(parsedBody)) {
        rejectUnusableBody(res, 'http-body-not-jsonrpc', {
            path: MCP_PATH,
            bytes: buffer.length,
            preview: bodyPreview(buffer),
        })
        return
    }
    if (isJsonRpcNotification(parsedBody)) {
        answerNotificationsWithOk(res)
        appendDiagnostic('http-notification-answered-ok', { path: MCP_PATH, bytes: buffer.length })
    }
    normalizeProtocolVersion(req)
    normalizeAcceptHeader(req)
    const mcp = createServer()
    // No session id is ever issued, so there is no session state to expire and
    // none to reap: `validateSession` returns at once for a stateless transport,
    // and a client that arrives holding an Mcp-Session-Id from some earlier
    // build (or from a server on another port) is answered rather than 404'd.
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    })
    transport.onerror = (error) => {
        appendDiagnostic('http-transport-error', { error: describeError(error) })
    }
    res.on('close', () => {
        void transport.close().catch(() => {})
        void mcp.close().catch(() => {})
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, parsedBody)
}

function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body, 'utf8'),
        'cache-control': 'no-store',
        ...extraHeaders,
    })
    res.end(body)
}

// A standalone SSE stream with nothing to say. It exists so a client that opens
// one keeps an open, answered, periodically-written connection instead of being
// told 405, and so a proxy or client that times out silence does not time out
// here. SSE comments (`:`) are invisible to an MCP client, so this carries no
// protocol meaning -- it is only proof the server is still up.
function serveSseHeartbeat(req, res) {
    if (openSseStreams >= SSE_MAX_OPEN_STREAMS) {
        appendDiagnostic('http-sse-refused', { path: MCP_PATH, open: openSseStreams })
        sendJson(res, 503, { error: `too many open ${MCP_PATH} streams` })
        return
    }
    openSseStreams += 1
    appendDiagnostic('http-sse-open', { path: MCP_PATH, open: openSseStreams })
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
    })
    let closed = false
    const stop = () => {
        if (closed) return
        closed = true
        clearInterval(beat)
        clearTimeout(lifetime)
        openSseStreams -= 1
        try {
            res.end()
        } catch {
        }
    }
    const beat = setInterval(() => {
        if (closed) return
        try {
            res.write(`: gm-mcp keepalive ${new Date().toISOString()}\n\n`)
        } catch (error) {
            appendDiagnostic('http-sse-write-failed', { path: MCP_PATH, error: describeError(error) })
            stop()
        }
    }, SSE_HEARTBEAT_MS)
    const lifetime = setTimeout(stop, SSE_MAX_LIFETIME_MS)
    lifetime.unref?.()
    // A client that does open one anyway is told how long to wait before
    // coming back: without it a stream that ends is retried immediately, in a
    // loop, and each retry is another transport error the host is counting.
    res.write(`retry: ${Math.round(SSE_HEARTBEAT_MS / 1000)}\n\n`)
    res.write(`: gm-mcp ${BUNDLE_VERSION} stateless server; no server-initiated messages\n\n`)
    req.on('close', stop)
    res.on('close', stop)
    res.on('error', stop)
}

export function healthPayload(port) {
    return {
        ok: true,
        service: 'gm-mcp',
        version: BUNDLE_VERSION,
        pid: process.pid,
        transport: 'streamable-http',
        path: MCP_PATH,
        host: DEFAULT_HOST,
        port,
    }
}

const LISTEN_FAILURE_REASONS = {
    EADDRINUSE: (host, port) => `another process already holds ${host}:${port}, so the shared server on that port is serving ${MCP_PATH} without this one`,
    EACCES: (host, port) => `this process may not bind ${host}:${port}`,
    EADDRNOTAVAIL: (host) => `${host} is not an address this machine has`,
    ENOTFOUND: (host) => `${host} does not resolve`,
}

export function describeListenFailure(error, host, port) {
    const named = LISTEN_FAILURE_REASONS[error?.code]
    const cause = named ? named(host, port) : describeError(error)
    return `gm-mcp ${BUNDLE_VERSION}: cannot serve http://${host}:${port}${MCP_PATH} -- ${cause}`
}

// Stateless: no session id, so a client that drops its connection and comes
// back is just another request. Nothing here is tied to a client's lifetime,
// which is the whole reason this transport survives what kills stdio.
export async function startHttpServer({ port, host } = {}) {
    keepServingOnAsyncFailure()
    logSignalExits()

    const server = createHttpServer((req, res) => {
        void handleRequest(req, res)
    })
    server.keepAliveTimeout = HTTP_KEEPALIVE_TIMEOUT_MS
    server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS

    let servedRequests = 0
    let lastRequestAt = Date.now()

    async function handleRequest(req, res) {
        const path = (req.url || '/').split('?')[0]
        res.on('error', (error) => {
            appendDiagnostic('http-response-error', { path, error: describeError(error) })
        })
        try {
            if (req.method === 'GET' && path === HEALTH_PATH) {
                sendJson(res, 200, healthPayload(port))
                return
            }
            servedRequests += 1
            lastRequestAt = Date.now()
            if (path !== MCP_PATH) {
                sendJson(res, 404, { error: `no route for ${req.method} ${path}`, mcp_path: MCP_PATH })
                return
            }
            await serveMcpRequest(req, res)
        } catch (error) {
            appendDiagnostic('http-request-failed', { path, method: req.method, error: describeError(error) })
            if (res.headersSent) {
                res.end()
                return
            }
            sendJson(res, 400, { error: describeError(error) })
        }
    }

    server.on('clientError', (_error, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })

    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, host, () => {
                server.removeListener('error', reject)
                resolve()
            })
        })
    } catch (error) {
        process.stderr.write(`${describeListenFailure(error, host, port)}\n`)
        throw error
    }

    // A client that stops talking looks exactly like a server that died from the
    // outside. Say, on a slow loop, that this process is up and how long it has
    // been idle, so "the client dropped the session" and "the server is gone"
    // are never the same log line again.
    const heartbeat = setInterval(() => {
        appendDiagnostic('http-heartbeat', {
            port,
            served_requests: servedRequests,
            idle_ms: Date.now() - lastRequestAt,
            open_sse_streams: openSseStreams,
            dispatches_inflight: inflightDispatchCount(),
        })
    }, HTTP_HEARTBEAT_MS)
    heartbeat.unref?.()

    appendDiagnostic('http-start', { host, port, path: MCP_PATH, pid: process.pid, version: BUNDLE_VERSION })
    console.error(`gm-mcp ${BUNDLE_VERSION}: serving streamable HTTP on http://${host}:${port}${MCP_PATH} (stateless)`)
    return { server, url: `http://${host}:${port}${MCP_PATH}`, port, host }
}
