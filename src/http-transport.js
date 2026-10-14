import { createServer as createHttpServer } from 'node:http'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './mcp-server.js'
import { keepServingOnAsyncFailure, logSignalExits } from './transport-guard.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { flagValue } from './argv.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787
export const MCP_PATH = '/mcp'
export const HEALTH_PATH = '/health'

export function httpListenOptions() {
    const port = Number(flagValue('port') ?? process.env.GM_MCP_HTTP_PORT ?? DEFAULT_PORT)
    const host = flagValue('host') ?? process.env.GM_MCP_HTTP_HOST ?? DEFAULT_HOST
    return { port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT, host: host || DEFAULT_HOST }
}

const SERVED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

function normalizeProtocolVersion(req) {
    const requested = req.headers['mcp-protocol-version']
    if (typeof requested !== 'string' || SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return
    req.headers['mcp-protocol-version'] = SERVED_PROTOCOL_VERSION
    const rawHeaders = req.rawHeaders
    if (Array.isArray(rawHeaders)) {
        for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
            if (typeof rawHeaders[i] === 'string' && rawHeaders[i].toLowerCase() === 'mcp-protocol-version') rawHeaders[i + 1] = SERVED_PROTOCOL_VERSION
        }
    }
    appendDiagnostic('http-protocol-version-normalized', { requested, served: SERVED_PROTOCOL_VERSION })
}

function rejectOversizedBody(req, res) {
    if (Number(req.headers['content-length'] || 0) <= MAX_BODY_BYTES) return false
    sendJson(res, 413, { error: `request body exceeds the ${MAX_BODY_BYTES} byte cap` })
    return true
}

async function readCappedJsonBody(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
        total += chunk.length
        if (total > MAX_BODY_BYTES) return { tooLarge: true }
        chunks.push(chunk)
    }
    try {
        return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
        return { malformed: true }
    }
}

function sendJsonRpcError(res, status, code, message) {
    sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null })
}

async function serveStatelessMcpRequest(req, res) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: `stateless transport serves no ${req.method} stream; POST JSON-RPC to ${MCP_PATH}` })
        return
    }
    if (rejectOversizedBody(req, res)) return
    const read = await readCappedJsonBody(req)
    if (read.tooLarge) {
        res.setHeader('connection', 'close')
        sendJson(res, 413, { error: `request body exceeds the ${MAX_BODY_BYTES} byte cap` })
        return
    }
    if (read.malformed) {
        sendJsonRpcError(res, 400, -32700, 'Parse error: request body is not JSON')
        return
    }
    normalizeProtocolVersion(req)
    const mcp = createServer()
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
    await transport.handleRequest(req, res, read.body)
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body, 'utf8'),
        'cache-control': 'no-store',
    })
    res.end(body)
}

function healthPayload(port) {
    const bundle = typeof healthExtras === 'function' ? healthExtras() : null
    return {
        ok: true,
        service: 'gm-mcp',
        version: BUNDLE_VERSION,
        pid: process.pid,
        transport: 'streamable-http',
        path: MCP_PATH,
        host: DEFAULT_HOST,
        port,
        bundle,
    }
}

let healthExtras = null

export function setHealthExtras(fn) {
    healthExtras = typeof fn === 'function' ? fn : null
}

async function handleRequest(req, res, port) {
    const path = (req.url || '/').split('?')[0]
    res.on('error', (error) => {
        appendDiagnostic('http-response-error', { path, error: describeError(error) })
    })
    try {
        if (req.method === 'GET' && path === HEALTH_PATH) {
            sendJson(res, 200, healthPayload(port))
            return
        }
        if (path !== MCP_PATH) {
            sendJson(res, 404, { error: `no route for ${req.method} ${path}`, mcp_path: MCP_PATH })
            return
        }
        await serveStatelessMcpRequest(req, res)
    } catch (error) {
        appendDiagnostic('http-request-failed', { path, method: req.method, error: describeError(error) })
        if (res.headersSent) {
            res.end()
            return
        }
        sendJson(res, 400, { error: describeError(error) })
    }
}

async function listenWithRetry(server, { port, host, listenHandle, listenRetryMs }) {
    const listenOptions = listenHandle ? { handle: listenHandle } : { port, host }
    const retryDeadline = Date.now() + Math.max(0, listenRetryMs)
    for (;;) {
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject)
                server.listen(listenOptions, () => {
                    server.removeListener('error', reject)
                    resolve()
                })
            })
            return
        } catch (error) {
            const retryable = error?.code === 'EADDRINUSE' && Date.now() < retryDeadline
            appendDiagnostic('http-listen-failed', {
                host,
                port,
                adopted_handle: Boolean(listenHandle),
                code: error?.code ?? null,
                retrying: retryable,
                error: describeError(error),
            })
            if (!retryable) throw error
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
    }
}

function announceAdoption(listenHandle, host, port) {
    if (!listenHandle) return
    try {
        process.send({ type: 'gm-mcp-handover-ready', pid: process.pid, version: BUNDLE_VERSION })
    } catch {
    }
    appendDiagnostic('http-start-adopted', { host, port, path: MCP_PATH, pid: process.pid, version: BUNDLE_VERSION })
}

export async function startHttpServer({ port, host, listenHandle = null, listenRetryMs = 0 } = {}) {
    keepServingOnAsyncFailure()
    logSignalExits()
    const server = createHttpServer((req, res) => {
        void handleRequest(req, res, port)
    })
    server.on('clientError', (_error, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    await listenWithRetry(server, { port, host, listenHandle, listenRetryMs })
    announceAdoption(listenHandle, host, port)
    appendDiagnostic('http-start', { host, port, path: MCP_PATH, pid: process.pid, version: BUNDLE_VERSION })
    console.error(`gm-mcp ${BUNDLE_VERSION}: serving streamable HTTP on http://${host}:${port}${MCP_PATH} (stateless)`)
    return { server, url: `http://${host}:${port}${MCP_PATH}`, port, host }
}
