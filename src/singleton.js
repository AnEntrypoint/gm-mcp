import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pidAlive } from './dispatch.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { DEFAULT_HOST, DEFAULT_PORT, HEALTH_PATH, MCP_PATH } from './http-transport.js'

const STATE_FILE_NAME = 'gm-mcp-http.json'
const PROBE_TIMEOUT_MS = 1_500
const STARTUP_WAIT_MS = 20_000
const STARTUP_POLL_MS = 250

function agentplugDir() {
    const override = (process.env.AGENTPLUG_HOME || '').trim()
    return override ? path.resolve(override) : path.join(homedir(), '.agentplug')
}

export function stateFilePath() {
    return path.join(agentplugDir(), STATE_FILE_NAME)
}

export function defaultHttpPort() {
    const fromEnv = Number((process.env.GM_MCP_HTTP_PORT || '').trim())
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT
}

export function httpMcpUrl(port = defaultHttpPort()) {
    return `http://${DEFAULT_HOST}:${port}${MCP_PATH}`
}

export function healthUrl(port = defaultHttpPort()) {
    return `http://${DEFAULT_HOST}:${port}${HEALTH_PATH}`
}

// The entry point this process was started from, so a spawned singleton is the
// same bundle the client already trusts rather than whatever resolves first.
export function serverEntryPath() {
    const argv1 = process.argv[1]
    if (argv1 && /\.(mjs|cjs|js)$/i.test(argv1) && existsSync(argv1)) return path.resolve(argv1)
    return fileURLToPath(import.meta.url)
}

export function readSingletonState(port = defaultHttpPort()) {
    try {
        const state = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
        if (state?.port !== port) return null
        return state
    } catch {
        return null
    }
}

export function writeSingletonState(state) {
    try {
        mkdirSync(path.dirname(stateFilePath()), { recursive: true })
        writeFileSync(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch {
    }
}

export async function probeHealth(port, timeoutMs = PROBE_TIMEOUT_MS) {
    try {
        const response = await fetch(healthUrl(port), { signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) return null
        const payload = await response.json()
        return payload?.ok === true ? payload : null
    } catch {
        return null
    }
}

async function waitForHealth(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const health = await probeHealth(port)
        if (health) return health
        await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS))
    }
    return null
}

function spawnSingleton(port) {
    const entry = serverEntryPath()
    const child = spawn(process.execPath, [entry, '--http', '--port', String(port)], {
        cwd: homedir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, GM_MCP_TRANSPORT: 'http' },
    })
    child.on('error', (error) => {
        appendDiagnostic('http-singleton-spawn-error', { port, entry, error: describeError(error) })
    })
    child.unref()
    return child.pid ?? null
}

// One shared server per machine, keyed by port. The health probe is the
// authority -- a stale state file naming a dead pid means the port is free,
// so the next caller starts a fresh one instead of trusting the file.
export async function ensureHttpSingleton({ port = defaultHttpPort(), timeoutMs = STARTUP_WAIT_MS } = {}) {
    const live = await probeHealth(port)
    if (live) {
        writeSingletonState({ port, pid: live.pid ?? null, url: httpMcpUrl(port), ts: Date.now(), reused: true })
        return { url: httpMcpUrl(port), port, pid: live.pid ?? null, reused: true, version: live.version ?? null }
    }

    const recorded = readSingletonState(port)
    if (recorded?.pid && pidAlive(recorded.pid) === true) {
        const late = await waitForHealth(port, 5_000)
        if (late) {
            return { url: httpMcpUrl(port), port, pid: late.pid ?? recorded.pid, reused: true, version: late.version ?? null }
        }
    }

    const pid = spawnSingleton(port)
    const health = await waitForHealth(port, timeoutMs)
    if (!health) {
        appendDiagnostic('http-singleton-start-failed', { port, spawned_pid: pid, entry: serverEntryPath() })
        return { url: null, port, pid, reused: false, error: `no healthy gm-mcp HTTP server on port ${port} after ${timeoutMs} ms` }
    }
    writeSingletonState({ port, pid: health.pid ?? pid, url: httpMcpUrl(port), ts: Date.now(), reused: false })
    appendDiagnostic('http-singleton-started', { port, pid: health.pid ?? pid, entry: serverEntryPath() })
    return { url: httpMcpUrl(port), port, pid: health.pid ?? pid, reused: false, version: health.version ?? null }
}
