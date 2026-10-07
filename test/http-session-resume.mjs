// Verifies the gm HTTP transport keeps a long-lived client session usable.
// Runs against a throwaway port so the live singleton on 8787 is untouched.
//
//   node test/http-session-resume.mjs [port] [idleSeconds]
//
// Checks, in order:
//   1. initialize + tools/list + tools/call round trip
//   2. an idle gap far longer than node's old 5 s keepAliveTimeout
//   3. the same client still works after that gap (no session expiry, no reap)
//   4. an empty POST is answered 202, never a 400 that a client reads as fatal
//   5. GET is a labelled heartbeat carrying `retry:`, DELETE with an unknown
//      session id is not a 404
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, '..', 'bin', 'gm-mcp-server.js')
const port = Number(process.argv[2] || 8791)
const idleSeconds = Number(process.argv[3] || 20)
const logPath = path.join(mkdtempSync(path.join(tmpdir(), 'gm-mcp-verify-')), 'server.log')

let failures = 0
function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
    if (!ok) failures += 1
}

const child = spawn(process.execPath, [bundle, '--http', '--port', String(port)], {
    cwd: path.join(here, '..'),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: { ...process.env, GM_MCP_LOG_PATH: logPath, GM_MCP_HTTP_SUPERVISOR: '0', GM_MCP_HTTP_SINGLETON: '0' },
})
child.stderr.on('data', () => {})

async function waitForHealth(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
            if (r.ok && (await r.json()).ok === true) return true
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250))
    }
    return false
}

function diagnostics() {
    try {
        return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
        return []
    }
}

try {
    check('server listens on the throwaway port', await waitForHealth(), `port ${port}`)

    const url = `http://127.0.0.1:${port}/mcp`
    const client = new Client({ name: 'gm-http-verify', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(url))
    let transportError = null
    transport.onerror = (e) => { transportError = e }

    await client.connect(transport)
    check('initialize succeeds', client.getServerVersion()?.name === 'gm-mcp', JSON.stringify(client.getServerVersion()))
    check('no session id is issued (stateless)', transport.sessionId === undefined, String(transport.sessionId))

    const tools = await client.listTools()
    check('tools/list answers', tools.tools.map((t) => t.name).includes('gm'), tools.tools.map((t) => t.name).join(','))

    const args = { verb: 'health', cwd: 'C:/dev/gm', session_id: 'verify-http-session' }
    const first = await client.callTool({ name: 'gm', arguments: args })
    check('tools/call answers', !first.isError && JSON.stringify(first).length > 0)

    await new Promise((r) => setTimeout(r, idleSeconds * 1000))

    const second = await client.callTool({ name: 'gm', arguments: args })
    check(`tools/call still answers after ${idleSeconds}s idle`, !second.isError, 'no idle expiry, no session reaping')
    check('no transport error across the idle gap', transportError === null, String(transportError?.message ?? ''))

    const empty = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': '0' },
        body: '',
    })
    check('empty POST is 202, not a fatal 400', empty.status === 202, `status ${empty.status}`)
    check(
        'empty POST is logged, not silently dropped',
        diagnostics().some((d) => d.event === 'http-empty-body-ignored'),
        'http-empty-body-ignored',
    )

    // A client that opens a GET stream anyway (the 0.2.5 client always did) gets
    // a heartbeat, not a 405 it may read as fatal. The `retry:` field is what
    // stops an ended stream from being re-GETted in a hot loop, so assert it.
    const get = await fetch(url, { headers: { accept: 'text/event-stream' } })
    const reader = get.body.getReader()
    const firstChunk = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array())
    await reader.cancel().catch(() => {})
    const retrySeconds = /^retry: (\d+)$/m.exec(firstChunk)?.[1] ?? null
    check(
        'GET is a heartbeat carrying a retry hint, not a fatal 405',
        get.status === 200 && retrySeconds !== null,
        `${get.status} retry=${retrySeconds}s`,
    )

    const del = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': 'stale-session-from-an-old-build' } })
    check('DELETE with an unknown session id is not 404', del.status !== 404, `status ${del.status}`)

    const after = await client.callTool({ name: 'gm', arguments: args })
    check('the original client still works after all of that', !after.isError)

    // The old node default closed an idle keep-alive socket after 5 s, which is
    // a client losing the socket it was about to reuse. Prove one socket can sit
    // idle well past that and still carry a request.
    const idleSocket = await new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port })
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
    })
    const socketSurvived = await new Promise((resolve) => {
        const onGone = () => resolve(false)
        idleSocket.once('close', onGone)
        idleSocket.once('error', onGone)
        setTimeout(async () => {
            idleSocket.removeListener('close', onGone)
            idleSocket.removeListener('error', onGone)
            if (idleSocket.destroyed) return resolve(false)
            const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'idle-socket', version: '1' } } })
            idleSocket.write(`POST ${path.posix.join('/', 'mcp')} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: ${Buffer.byteLength(frame)}\r\n\r\n${frame}`)
            const chunks = []
            const onData = (c) => {
                chunks.push(c)
                if (Buffer.concat(chunks).includes('\r\n\r\n')) {
                    idleSocket.destroy()
                    resolve(Buffer.concat(chunks).toString('utf8').startsWith('HTTP/1.1 200'))
                }
            }
            idleSocket.on('data', onData)
            setTimeout(() => { idleSocket.destroy(); resolve(false) }, 10_000)
        }, 12_000)
    })
    check('a socket idle 12s still carries a request', socketSurvived === true, 'no idle socket reaping')

    await client.close()
} finally {
    child.kill()
}

console.log(failures === 0 ? `\nALL CHECKS PASSED (port ${port}, ${idleSeconds}s idle)` : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
