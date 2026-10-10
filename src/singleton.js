import { agentplugDir } from './paths.js'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pidAlive } from './dispatch.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { keepServingOnAsyncFailure, logSignalExits } from './transport-guard.js'
import { DEFAULT_HOST, DEFAULT_PORT, HEALTH_PATH, MCP_PATH } from './http-transport.js'

const STATE_FILE_NAME = 'gm-mcp-http.json'
const PROBE_TIMEOUT_MS = 1_500
const STARTUP_WAIT_MS = 20_000
const STARTUP_POLL_MS = 250
const SUPERVISOR_INTERVAL_MS = 15_000
const SUPERVISOR_STATE_STALE_MS = 60_000
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

function stateFilePath() {
    return path.join(agentplugDir(), STATE_FILE_NAME)
}

export function defaultHttpPort() {
    const fromEnv = Number((process.env.GM_MCP_HTTP_PORT || '').trim())
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT
}

export function httpMcpUrl(port = defaultHttpPort()) {
    return `http://${DEFAULT_HOST}:${port}${MCP_PATH}`
}

function healthUrl(port = defaultHttpPort()) {
    return `http://${DEFAULT_HOST}:${port}${HEALTH_PATH}`
}

function envValue(name) {
    const raw = (process.env[name] || '').trim().toLowerCase()
    return raw === '' ? null : raw
}

export function httpSingletonEnabled() {
    for (const name of ['GM_MCP_NO_HTTP_SINGLETON', 'GM_MCP_HTTP_SINGLETON_OFF']) {
        const value = envValue(name)
        if (value !== null && !OFF_VALUES.has(value)) return false
    }
    const legacy = envValue('GM_MCP_HTTP_SINGLETON')
    return !(legacy !== null && OFF_VALUES.has(legacy))
}

export function launchedEntryPath() {
    const argv1 = process.argv[1]
    if (argv1 && /\.(mjs|cjs|js)$/i.test(argv1) && existsSync(argv1)) return path.resolve(argv1)
    return fileURLToPath(import.meta.url)
}

function readSingletonState(port = defaultHttpPort()) {
    try {
        const state = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
        if (state?.port !== port) return null
        return state
    } catch {
        return null
    }
}

function writeSingletonState(state) {
    try {
        mkdirSync(path.dirname(stateFilePath()), { recursive: true })
        writeFileSync(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch {
    }
}

function dropSingletonState() {
    try {
        rmSync(stateFilePath(), { force: true })
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

export async function waitForHealth(port, timeoutMs, excludePid = null) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const health = await probeHealth(port)
        if (health && (excludePid === null || health.pid !== excludePid)) return health
        await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS))
    }
    return null
}

function childStdio() {
    try {
        const file = logFilePath()
        mkdirSync(path.dirname(file), { recursive: true })
        const fd = openSync(file, 'a')
        return { stdio: ['ignore', fd, fd], fd }
    } catch {
        return { stdio: 'ignore', fd: null }
    }
}

export function spawnServerProcess({ port = defaultHttpPort(), host = DEFAULT_HOST } = {}) {
    const entry = launchedEntryPath()
    const { stdio, fd } = childStdio()
    const child = spawn(process.execPath, [entry, '--http', '--port', String(port), '--host', String(host)], {
        cwd: homedir(),
        detached: true,
        stdio,
        windowsHide: true,
        env: { ...process.env, GM_MCP_TRANSPORT: 'http', GM_MCP_HTTP_SINGLETON: '0' },
    })
    if (fd !== null) closeSync(fd)
    child.on('error', (error) => {
        appendDiagnostic('http-singleton-spawn-error', { port, entry, error: describeError(error) })
    })
    child.unref()
    return child.pid ?? null
}

export async function ensureHttpSingleton({ port = defaultHttpPort(), timeoutMs = STARTUP_WAIT_MS, wait = true } = {}) {
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
        appendDiagnostic('http-singleton-unresponsive', { port, recorded_pid: recorded.pid, note: 'a live pid holds the port but answers no health check' })
    }
    dropSingletonState()

    const pid = spawnServerProcess({ port })
    if (!wait) {
        appendDiagnostic('http-singleton-spawned', { port, pid, entry: launchedEntryPath(), awaited: false })
        return { url: null, port, pid, reused: false, spawned: true, pending: true, version: null }
    }

    const health = await waitForHealth(port, timeoutMs)
    if (!health) {
        appendDiagnostic('http-singleton-start-failed', { port, spawned_pid: pid, entry: launchedEntryPath() })
        return { url: null, port, pid, reused: false, spawned: Boolean(pid), error: `no healthy gm-mcp HTTP server on port ${port} after ${timeoutMs} ms` }
    }
    writeSingletonState({ port, pid: health.pid ?? pid, url: httpMcpUrl(port), ts: Date.now(), reused: false })
    appendDiagnostic('http-singleton-started', { port, pid: health.pid ?? pid, entry: launchedEntryPath() })
    return { url: httpMcpUrl(port), port, pid: health.pid ?? pid, reused: false, version: health.version ?? null }
}

export function supervisorStateFilePath(port = defaultHttpPort()) {
    return path.join(agentplugDir(), `gm-mcp-http-supervisor-${port}.json`)
}

export function supervisorIntervalMs() {
    const seconds = Number((process.env.GM_MCP_HTTP_SUPERVISOR_INTERVAL_SECONDS || '').trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : SUPERVISOR_INTERVAL_MS
}

export function supervisorEnabled() {
    const value = envValue('GM_MCP_HTTP_SUPERVISOR')
    return !(value !== null && OFF_VALUES.has(value))
}

function readSupervisorState(port) {
    try {
        const state = JSON.parse(readFileSync(supervisorStateFilePath(port), 'utf8'))
        return state?.port === port ? state : null
    } catch {
        return null
    }
}

function writeSupervisorState(state) {
    const file = supervisorStateFilePath(state?.port)
    try {
        mkdirSync(path.dirname(file), { recursive: true })
        const temporary = `${file}.${process.pid}.tmp`
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        renameSync(temporary, file)
    } catch {
    }
}

function supervisorRunning(state, now = Date.now()) {
    if (!state?.pid || pidAlive(state.pid) !== true) return false
    const interval = Number.isFinite(state.interval_ms) ? state.interval_ms : SUPERVISOR_INTERVAL_MS
    const staleAfter = Math.max(SUPERVISOR_STATE_STALE_MS, interval * 4)
    return typeof state.ts === 'number' && now - state.ts < staleAfter
}

export function ensureHttpSupervisor({ port = defaultHttpPort(), intervalMs = supervisorIntervalMs() } = {}) {
    if (!supervisorEnabled()) return { port, pid: null, started: false, reason: 'disabled' }
    const recorded = readSupervisorState(port)
    if (supervisorRunning(recorded)) return { port, pid: recorded.pid, started: false, reason: 'already-running' }

    const entry = launchedEntryPath()
    const { stdio, fd } = childStdio()
    const child = spawn(process.execPath, [entry, 'http-supervise', '--port', String(port), '--interval', String(Math.round(intervalMs / 1000))], {
        cwd: homedir(),
        detached: true,
        stdio,
        windowsHide: true,
        env: { ...process.env, GM_MCP_HTTP_SUPERVISOR: '0' },
    })
    if (fd !== null) closeSync(fd)
    child.on('error', (error) => {
        appendDiagnostic('http-supervisor-spawn-error', { port, entry, error: describeError(error) })
    })
    child.unref()
    appendDiagnostic('http-supervisor-spawned', { port, pid: child.pid ?? null, interval_ms: intervalMs })
    return { port, pid: child.pid ?? null, started: true, reason: 'spawned' }
}

export async function runHttpSupervisor({ port = defaultHttpPort(), intervalMs = supervisorIntervalMs() } = {}) {
    const recorded = readSupervisorState(port)
    if (supervisorRunning(recorded)) {
        appendDiagnostic('http-supervisor-dup-exit', { port, owner_pid: recorded.pid, pid: process.pid })
        return { port, supervised: false, reason: 'another supervisor owns this port' }
    }

    keepServingOnAsyncFailure()
    logSignalExits()
    appendDiagnostic('http-supervisor-start', { port, pid: process.pid, interval_ms: intervalMs })

    let serverPid = null
    for (;;) {
        writeSupervisorState({ port, pid: process.pid, ts: Date.now(), interval_ms: intervalMs, server_pid: serverPid })
        const health = await probeHealth(port)
        if (health) {
            serverPid = health.pid ?? serverPid
        } else if (await probeHealth(port)) {
            appendDiagnostic('http-singleton-probe-false-negative', { port, pid: serverPid })
        } else {
            const previousPid = serverPid
            const started = await ensureHttpSingleton({ port })
            serverPid = started.pid ?? previousPid
            appendDiagnostic(started.url ? 'http-supervisor-restarted' : 'http-supervisor-restart-failed', {
                port,
                pid: started.pid ?? null,
                previous_pid: previousPid,
                error: started.error ?? null,
            })
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
}

export function ensureHttpSingletonInBackground(options = {}) {
    if (!httpSingletonEnabled()) return null
    return ensureHttpSingleton(options)
        .then((result) => {
            if (result.url || result.pending) return result
            appendDiagnostic('http-singleton-seed-unavailable', { port: result.port, error: result.error ?? null })
            return result
        })
        .catch((error) => {
            appendDiagnostic('http-singleton-seed-failed', { port: options.port ?? defaultHttpPort(), error: describeError(error) })
        })
}
