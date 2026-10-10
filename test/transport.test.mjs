import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { startHttpServer, httpListenOptions, DEFAULT_PORT, MCP_PATH } from '../src/http-transport.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUARD_PATH = path.join(HERE, '..', 'src', 'transport-guard.js')
const GUARD_LOG_PATH = path.join(os.tmpdir(), `gm-mcp-transport-test-${process.pid}.log`)

let passed = 0
function test(name, fn) {
    try {
        fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

async function testAsync(name, fn) {
    try {
        await fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

function runNode(args, timeoutMs = 30_000) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            cwd: HERE,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GM_MCP_LOG_PATH: GUARD_LOG_PATH },
            windowsHide: true,
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (d) => { out += d.toString() })
        child.stderr.on('data', (d) => { err += d.toString() })
        const timer = setTimeout(() => child.kill(), timeoutMs)
        child.on('exit', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal, out, err })
        })
    })
}

await testAsync('a stdout EPIPE does not take the server down', async () => {
    const script = [
        `import { installStdioGuards } from ${JSON.stringify(pathToFileURL(GUARD_PATH).href)}`,
        'installStdioGuards()',
        "process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))",
        "process.stdin.emit('end')",
        "setTimeout(() => { process.stderr.write('STILL-UP\\n'); process.exit(0) }, 500)",
    ].join('\n')
    const result = await runNode(['--input-type=module', '-e', script])
    assert.match(result.err, /STILL-UP/)
    assert.equal(result.code, 0)
})

await testAsync('a stdout EPIPE is recorded once, not silently swallowed', async () => {
    const script = [
        `import { installStdioGuards } from ${JSON.stringify(pathToFileURL(GUARD_PATH).href)}`,
        'installStdioGuards()',
        "process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))",
        "setTimeout(() => process.exit(0), 400)",
    ].join('\n')
    await runNode(['--input-type=module', '-e', script])
    const text = readFileSync(GUARD_LOG_PATH, 'utf8')
    assert.match(text, /stdout-pipe-gone/)
    assert.match(text, /stdin-ended|stdout-pipe-gone/)
})

test('the HTTP transport defaults to the documented localhost port', () => {
    const options = httpListenOptions()
    assert.equal(options.port, DEFAULT_PORT)
    assert.equal(options.host, '127.0.0.1')
})

await testAsync('the HTTP transport answers request after request', async () => {
    const started = await startHttpServer({ port: 0, host: '127.0.0.1' })
    const port = started.server.address().port
    const base = `http://127.0.0.1:${port}`
    try {
        const health = await fetch(`${base}/health`)
        assert.equal(health.status, 200)
        const healthBody = await health.json()
        assert.equal(healthBody.ok, true)
        assert.equal(healthBody.transport, 'streamable-http')

        let id = 0
        const rpc = async (method, params) => {
            const response = await fetch(`${base}${MCP_PATH}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
            })
            return { status: response.status, body: await response.json() }
        }
        const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
        assert.equal(init.status, 200)
        assert.equal(init.body.result.serverInfo.name, 'gm-mcp')

        const first = await rpc('tools/list', {})
        assert.equal(first.status, 200)
        assert.deepEqual(first.body.result.tools.map((t) => t.name).sort(), ['gm', 'gm_instruction', 'gm_result'])

        const second = await rpc('tools/list', {})
        assert.equal(second.status, 200)
        assert.equal(second.body.result.tools.length, 3)

        const missing = await fetch(`${base}/nope`)
        assert.equal(missing.status, 404)
    } finally {
        started.server.close()
    }
})

test('a served request path is the documented one', () => {
    assert.equal(MCP_PATH, '/mcp')
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
