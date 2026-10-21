import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lastTableError, readProcessTableAsync } from '../src/process-table.js'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUILT_BUNDLE = path.join(repoRoot, 'bin', 'gm-mcp-server.js')
const STARTUP_BUDGET_MS = 30000
const HANDOVER_BUDGET_MS = 60000
const REFUSAL = 'refusing to start a second standalone server'
const READY_LINE = 'serving on stdio'
const RELAY_LINE = 'relaying to'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, budgetMs, intervalMs) {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
        const value = await predicate()
        if (value) return value
        await sleep(intervalMs)
    }
    return null
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port
            probe.close(() => resolve(port))
        })
    })
}

function bumpBundle(text) {
    const match = /var BUNDLE_VERSION = "([^"]+)";/.exec(text)
    if (!match) throw new Error('bundle has no BUNDLE_VERSION banner')
    const parts = match[1].split('.').map(Number)
    const next = parts.slice(0, 2).concat([parts[2] + 1]).join('.')
    return text.replace(match[0], 'var BUNDLE_VERSION = "' + next + '";')
}

function makeScenario(scratch, name) {
    const dir = path.join(scratch, name)
    const bundleDir = path.join(dir, 'bundle')
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'agentplug'), { recursive: true })
    const bundlePath = path.join(bundleDir, 'gm-mcp-server.js')
    fs.copyFileSync(BUILT_BUNDLE, bundlePath)
    return { dir, bundleDir, bundlePath, original: fs.readFileSync(bundlePath, 'utf8') }
}

function inheritedEnv() {
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('GM_MCP_') && !key.startsWith('AGENTPLUG_')) env[key] = value
    }
    return env
}

function scenarioEnv(dir, port, extra) {
    return Object.assign(inheritedEnv(), {
        HOME: path.join(dir, 'home'),
        USERPROFILE: path.join(dir, 'home'),
        GM_TOOLS_DIR: path.join(dir, 'tools'),
        AGENTPLUG_HOME: path.join(dir, 'agentplug'),
        GM_MCP_LOG_PATH: path.join(dir, 'diagnostics.log'),
        GM_MCP_HTTP_PORT: String(port),
        GM_MCP_SELF_UPDATE: '0',
        GM_MCP_NO_SELF_UPDATE: '1',
        GM_MCP_DEV_SYNC: '0',
        GM_MCP_LEAK_WATCH: '0',
        GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS: '1',
    }, extra)
}

function startClient(bundlePath, env, cwd) {
    const child = spawn(process.execPath, [bundlePath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const client = { child, stderr: '', replies: new Map(), buffer: '', exit: null }
    child.stdin.on('error', () => {})
    child.stderr.on('data', (chunk) => { client.stderr += chunk })
    child.stdout.on('data', (chunk) => {
        client.buffer += chunk
        let at = client.buffer.indexOf('\n')
        while (at >= 0) {
            const line = client.buffer.slice(0, at).trim()
            client.buffer = client.buffer.slice(at + 1)
            if (line !== '') {
                try {
                    const frame = JSON.parse(line)
                    if (frame.id !== undefined) client.replies.set(frame.id, frame)
                } catch {
                }
            }
            at = client.buffer.indexOf('\n')
        }
    })
    child.on('exit', (code, signal) => { client.exit = { code, signal } })
    client.send = (frame) => child.stdin.write(JSON.stringify(frame) + '\n')
    return client
}

async function roundTrip(client, id, method) {
    const frame = { jsonrpc: '2.0', id, method }
    if (method === 'initialize') {
        frame.params = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-handover-witness', version: '0.0.0' } }
    }
    client.send(frame)
    return waitFor(async () => client.replies.get(id) ?? null, 10000, 50)
}

async function gmProcesses(bundleDir) {
    const table = await readProcessTableAsync()
    if (table.length === 0 && lastTableError()) console.log('process table read failed: ' + lastTableError())
    const rows = []
    for (const row of table) {
        const args = String(row.command || '')
        if (!args.includes(bundleDir)) continue
        const kind = args.includes(' http-supervise') ? 'supervisor' : args.includes(' --http') ? 'server' : 'client'
        rows.push({ pid: Number(row.pid), kind })
    }
    return rows
}

const pidsOf = (rows, kind) => rows.filter((row) => row.kind === kind).map((row) => row.pid).sort((a, b) => a - b)
const countKinds = (rows) => ['client', 'server', 'supervisor'].map((kind) => kind + '=' + pidsOf(rows, kind).length).join(' ')
const standaloneStderr = (client) => client.stderr.split('\n').some((line) => line.includes(READY_LINE) && !line.includes(RELAY_LINE))

function closeClients(clients) {
    for (const client of clients) {
        try { client.child.stdin.end() } catch {
        }
    }
}

function killUnder(bundleDir) {
    for (const row of gmProcesses(bundleDir)) {
        try { process.kill(row.pid, 'SIGKILL') } catch {
        }
    }
}

async function relayScenario(scratch, expect) {
    const sc = makeScenario(scratch, 'relay')
    const env = scenarioEnv(sc.dir, await freePort(), {})
    const clients = []
    try {
        const a = startClient(sc.bundlePath, env, sc.dir)
        clients.push(a)
        const relayA = await waitFor(async () => a.stderr.includes(RELAY_LINE), STARTUP_BUDGET_MS, 100)
        expect('relay: the first client relays to the singleton it starts', Boolean(relayA))
        const b = startClient(sc.bundlePath, env, sc.dir)
        clients.push(b)
        const relayB = await waitFor(async () => b.stderr.includes(RELAY_LINE), STARTUP_BUDGET_MS, 100)
        expect('relay: the second client relays to the same singleton', Boolean(relayB))
        const settled = await waitFor(async () => {
            const rows = gmProcesses(sc.bundleDir)
            return pidsOf(rows, 'server').length === 1 && pidsOf(rows, 'supervisor').length === 1 ? rows : null
        }, STARTUP_BUDGET_MS, 250)
        const beforeRows = settled ?? gmProcesses(sc.bundleDir)
        expect('relay: before the change, 2 clients, 1 singleton, 1 supervisor', countKinds(beforeRows) === 'client=2 server=1 supervisor=1', countKinds(beforeRows))
        const beforeInit = (await roundTrip(a, 1, 'initialize')) && (await roundTrip(a, 2, 'ping'))
        expect('relay: client a answers initialize and ping through the singleton', Boolean(beforeInit))

        await sleep(1500)
        fs.writeFileSync(sc.bundlePath, bumpBundle(sc.original))
        const oldServer = pidsOf(beforeRows, 'server')[0]
        const handed = await waitFor(async () => {
            const rows = gmProcesses(sc.bundleDir)
            const servers = pidsOf(rows, 'server')
            return servers.length === 1 && servers[0] !== oldServer ? rows : null
        }, HANDOVER_BUDGET_MS, 250)
        const afterRows = handed ?? gmProcesses(sc.bundleDir)
        expect('relay: the singleton is handed to a new process', Boolean(handed), countKinds(afterRows))
        expect('relay: the process count is unchanged across the bundle change', countKinds(afterRows) === countKinds(beforeRows), countKinds(afterRows))
        expect('relay: both client processes keep their pids', JSON.stringify(pidsOf(afterRows, 'client')) === JSON.stringify(pidsOf(beforeRows, 'client')))
        const pingA = await roundTrip(a, 3, 'ping')
        const pingB = await roundTrip(b, 3, 'ping')
        expect('relay: both clients are still answered after the change', Boolean(pingA && pingB))
        expect('relay: no client fell back to a standalone server', !standaloneStderr(a) && !standaloneStderr(b))
    } finally {
        closeClients(clients)
        killUnder(sc.bundleDir)
    }
}

async function standaloneScenario(scratch, expect) {
    const sc = makeScenario(scratch, 'standalone')
    const env = scenarioEnv(sc.dir, await freePort(), { GM_MCP_NO_HTTP_SINGLETON: '1' })
    const clients = []
    try {
        const a = startClient(sc.bundlePath, env, sc.dir)
        const b = startClient(sc.bundlePath, env, sc.dir)
        clients.push(a, b)
        const ready = await waitFor(async () => a.stderr.includes(READY_LINE) && b.stderr.includes(READY_LINE), STARTUP_BUDGET_MS, 100)
        expect('standalone: both clients start a standalone stdio server', Boolean(ready))
        const beforeRows = gmProcesses(sc.bundleDir)
        expect('standalone: before the change, exactly 2 client processes', countKinds(beforeRows) === 'client=2 server=0 supervisor=0', countKinds(beforeRows))
        const beforeInit = (await roundTrip(a, 1, 'initialize')) && (await roundTrip(b, 1, 'initialize'))
        expect('standalone: both answer initialize before the change', Boolean(beforeInit))

        await sleep(1500)
        fs.writeFileSync(sc.bundlePath, bumpBundle(sc.original))
        const notified = await waitFor(async () => a.stderr.includes('restart required') && b.stderr.includes('restart required'), HANDOVER_BUDGET_MS, 250)
        expect('standalone: each client is told the installed bundle is newer and that a relaunch serves it', Boolean(notified))
        await sleep(2000)
        const afterRows = gmProcesses(sc.bundleDir)
        expect('standalone: the process count is unchanged across the bundle change', countKinds(afterRows) === countKinds(beforeRows), countKinds(afterRows))
        expect('standalone: no client is replaced, so the pids are the same', JSON.stringify(pidsOf(afterRows, 'client')) === JSON.stringify(pidsOf(beforeRows, 'client')))
        const pingA = await roundTrip(a, 2, 'ping')
        const pingB = await roundTrip(b, 2, 'ping')
        expect('standalone: both clients keep answering on their original process', Boolean(pingA && pingB))
        const logText = fs.existsSync(path.join(sc.dir, 'diagnostics.log')) ? fs.readFileSync(path.join(sc.dir, 'diagnostics.log'), 'utf8') : ''
        expect('standalone: the change is recorded as no-handover', logText.includes('bundle-stale-no-handover'))
    } finally {
        closeClients(clients)
        killUnder(sc.bundleDir)
    }
}

async function refusalScenario(scratch, expect) {
    const port = await freePort()
    const blocker = net.createServer((socket) => socket.destroy())
    await new Promise((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(port, '127.0.0.1', resolve)
    })
    const sc = makeScenario(scratch, 'refusal')
    const client = startClient(sc.bundlePath, scenarioEnv(sc.dir, port, {}), sc.dir)
    try {
        const exited = await waitFor(async () => client.exit, STARTUP_BUDGET_MS + 20000, 200)
        const tail = (text) => String(text).slice(-400).split('\n').join(' | ')
        const logPath = path.join(sc.dir, 'diagnostics.log')
        const log = fs.existsSync(logPath) ? tail(fs.readFileSync(logPath, 'utf8')) : 'no log'
        expect('refusal: the client exits when no singleton answers and none can start', Boolean(exited) && exited.code !== 0, (exited ? 'exit code ' + exited.code : 'still running') + ' stderr: ' + tail(client.stderr) + ' log: ' + log)
        expect('refusal: stderr says it refused to start a second standalone server', client.stderr.includes(REFUSAL))
        expect('refusal: no standalone stdio server was started', !standaloneStderr(client))
    } finally {
        closeClients([client])
        killUnder(sc.bundleDir)
        blocker.close()
    }
}

async function main() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-handover-witness-'))
    const outcomes = []
    const expect = (label, ok, detail) => {
        outcomes.push(Boolean(ok))
        console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : ' -- ' + detail))
    }
    try {
        await relayScenario(scratch, expect)
        await standaloneScenario(scratch, expect)
        await refusalScenario(scratch, expect)
    } catch (error) {
        expect('witness ran to completion', false, String((error && error.stack) || error).split('\n').slice(0, 3).join(' | '))
    }
    const passed = outcomes.filter(Boolean).length
    const ok = outcomes.length > 0 && passed === outcomes.length
    if (ok) fs.rmSync(scratch, { recursive: true, force: true })
    else console.log('scratch kept for diagnosis: ' + scratch)
    console.log('checks ' + passed + '/' + outcomes.length)
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
    process.exitCode = ok ? 0 : 1
}

await main()
