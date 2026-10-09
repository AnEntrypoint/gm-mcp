import { createServer as createHttpServer } from 'node:http'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './mcp-server.js'
import { keepServingOnAsyncFailure, logSignalExits } from './transport-guard.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { BUNDLE_VERSION } from './bundle-version.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787
export const MCP_PATH = '/mcp'
export const HEALTH_PATH = '/health'

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
async function serveMcpRequest(req, res) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: `stateless transport serves no ${req.method} stream; POST JSON-RPC to ${MCP_PATH}` })
        return
    }
    if (rejectOversizedBody(req, res)) return
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
    await transport.handleRequest(req, res)
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

// Stateless: no session id, so a client that drops its connection and comes
// back is just another request. Nothing here is tied to a client's lifetime,
// which is the whole reason this transport survives what kills stdio.
export async function startHttpServer({ port, host } = {}) {
    keepServingOnAsyncFailure()
    logSignalExits()

    const server = createHttpServer((req, res) => {
        void handleRequest(req, res)
    })

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

    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
            server.removeListener('error', reject)
            resolve()
        })
    })

    appendDiagnostic('http-start', { host, port, path: MCP_PATH, pid: process.pid, version: BUNDLE_VERSION })
    console.error(`gm-mcp ${BUNDLE_VERSION}: serving streamable HTTP on http://${host}:${port}${MCP_PATH} (stateless)`)
    return { server, url: `http://${host}:${port}${MCP_PATH}`, port, host }
}
