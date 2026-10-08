import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
// How often the supervisor asks whether the server process still exists. It is
// far shorter than the health-probe interval on purpose: an exited server has
// to be replaced in about a second, because that is the window in which a
// client's one and only connect attempt is refused.
const SUPERVISOR_WATCH_MS = 1_000
// A supervisor proves it is alive by refreshing its own state file. A pid alone
// cannot: Windows hands a freed pid to an unrelated process within minutes, so
// `pidAlive(recorded.pid)` answers "some process holds that number", not "the
// supervisor is running" -- and a re-arm that trusts it leaves the MCP server
// watched by nobody while believing it is watched. That is the 2026-10-07
// outage: the supervisor's pid stayed in its state file after it exited, the
// server's re-arm saw a live pid and no-opped for the rest of its life, and
// when the server itself died nothing replaced it.
const SUPERVISOR_STATE_BEAT_MS = 15_000
const SUPERVISOR_STATE_STALE_MS = 60_000

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

function singletonLogFilePath(port) {
    const log = logFilePath()
    return path.join(path.dirname(log), `gm-mcp-http-${port}.log`)
}

// A detached server's stdout and stderr used to be 'ignore', so the one death
// that matters -- a V8 abort, which skips every exit handler and writes to
// stderr -- left no trace at all and the post-mortem had no cause to find.
function spawnSingleton(port) {
    const entry = serverEntryPath()
    const log = singletonLogFilePath(port)
    let fds
    try {
        mkdirSync(path.dirname(log), { recursive: true })
        const fd = openSync(log, 'a')
        fds = [fd, fd]
    } catch {
        fds = null
    }
    const child = spawn(process.execPath, [entry, '--http', '--port', String(port)], {
        cwd: homedir(),
        detached: true,
        stdio: fds ? ['ignore', fds[0], fds[1]] : 'ignore',
        windowsHide: true,
        env: { ...process.env, GM_MCP_TRANSPORT: 'http' },
    })
    child.on('error', (error) => {
        appendDiagnostic('http-singleton-spawn-error', { port, entry, log: fds ? log : null, error: describeError(error) })
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

    // One probe that times out is not proof of death. This box runs GPU jobs,
    // index passes and dispatch storms that hold a busy server past the probe's
    // 1.5 s budget, and the supervisor acts on a null probe as "restart the
    // server" -- so a busy moment used to spawn a duplicate server that then
    // died on EADDRINUSE, logged as a restart of a server that never went away.
    // `http-supervisor-restarted` at 2026-10-07T13:52:44 is one of those: the
    // pid it reports is the server that had been up the whole time. Confirm
    // before treating the port as free.
    const confirmed = await probeHealth(port)
    if (confirmed) {
        appendDiagnostic('http-singleton-probe-false-negative', { port, pid: confirmed.pid ?? null })
        writeSingletonState({ port, pid: confirmed.pid ?? null, url: httpMcpUrl(port), ts: Date.now(), reused: true })
        return { url: httpMcpUrl(port), port, pid: confirmed.pid ?? null, reused: true, version: confirmed.version ?? null }
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

// Keyed by port like the singleton's own state, but in its own file per port:
// a second supervisor on another port must not read this one's pid as its own.
export function supervisorStateFilePath(port = defaultHttpPort()) {
    return path.join(agentplugDir(), `gm-mcp-http-supervisor-${port}.json`)
}

export function supervisorIntervalMs() {
    const seconds = Number((process.env.GM_MCP_HTTP_SUPERVISOR_INTERVAL_SECONDS || '').trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : SUPERVISOR_INTERVAL_MS
}

// Opt-in only: a supervisor is a detached process that outlives the session
// that asked for it, so nothing starts one unless GM_MCP_HTTP_SUPERVISOR=1.
export function supervisorEnabled() {
    return (process.env.GM_MCP_HTTP_SUPERVISOR || '').trim() === '1'
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
        writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch {
    }
}

// "A live pid owns this port" is only half a liveness test; the other half is
// that the pid answered recently. Without the beat, one exited supervisor
// blocks every later re-arm for as long as Windows keeps its pid recycled.
function supervisorRunning(state, now = Date.now()) {
    if (!state?.pid || pidAlive(state.pid) !== true) return false
    return typeof state.ts === 'number' && now - state.ts < SUPERVISOR_STATE_STALE_MS
}

// The server is the only thing that ever starts itself, so a server that dies
// stays dead: nothing on the http registration's path runs gm at all, and a
// session whose client connected once never reconnects. This is the daemon
// guard's counterpart for the durable transport -- a detached sibling that
// only ever polls /health and restarts the server when it stops answering.
export async function ensureHttpSupervisor({ port = defaultHttpPort(), intervalMs = supervisorIntervalMs() } = {}) {
    if (!supervisorEnabled()) return { port, pid: null, started: false, reason: 'disabled' }
    const recorded = readSupervisorState(port)
    if (supervisorRunning(recorded)) {
        return { port, pid: recorded.pid, started: false, reason: 'already-running' }
    }
    const child = spawn(process.execPath, [serverEntryPath(), 'http-supervise', '--port', String(port), '--interval', String(Math.round(intervalMs / 1000))], {
        cwd: homedir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // Inherited by every process this one spawns, so a restarted server
        // does not seed a second supervisor that would race this one.
        env: { ...process.env, GM_MCP_TRANSPORT: 'http', GM_MCP_HTTP_SUPERVISOR: '0' },
    })
    child.on('error', (error) => {
        appendDiagnostic('http-supervisor-spawn-error', { port, entry: serverEntryPath(), error: describeError(error) })
    })
    child.unref()
    appendDiagnostic('http-supervisor-spawned', { port, pid: child.pid ?? null, interval_ms: intervalMs })
    return { port, pid: child.pid ?? null, started: true, reason: 'spawned' }
}

// gm installs nothing that starts at logon or on a timer. Earlier builds did,
// so every supervisor start and `ensure-http` removes what they left behind.
export function autostartScriptPath() {
    const appData = process.env.APPDATA || ''
    if (!appData) return null
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'gm-mcp-http-supervise.vbs')
}

export function supervisorTaskName(port = defaultHttpPort()) {
    return `gm-mcp-http-supervise-${port}`
}

// Removes the logon script and the per-minute task that earlier builds
// installed. Both are gm's own artifacts, so deleting them is the repair.
export function removeHttpAutostart({ port = defaultHttpPort() } = {}) {
    const removed = []
    const target = autostartScriptPath()
    if (target && existsSync(target)) {
        try {
            unlinkSync(target)
            removed.push(target)
        } catch (error) {
            appendDiagnostic('http-autostart-remove-failed', { port, path: target, error: describeError(error) })
        }
    }
    if (process.platform === 'win32') {
        const task = supervisorTaskName(port)
        const result = spawnSync('schtasks', ['/delete', '/tn', task, '/f'], { encoding: 'utf8', windowsHide: true })
        if (!result.error && result.status === 0) removed.push(`task:${task}`)
    }
    if (removed.length) appendDiagnostic('http-autostart-removed', { port, removed })
    return { removed }
}

export async function runHttpSupervisor({ port = defaultHttpPort(), intervalMs = supervisorIntervalMs() } = {}) {
    const recorded = readSupervisorState(port)
    if (recorded?.pid && recorded.pid !== process.pid && supervisorRunning(recorded)) {
        appendDiagnostic('http-supervisor-dup-exit', { port, owner_pid: recorded.pid, pid: process.pid })
        return { port, supervised: false, reason: 'another supervisor owns this port' }
    }
    keepServingOnAsyncFailure()
    logSignalExits()
    removeHttpAutostart({ port })
    writeSupervisorState({ port, pid: process.pid, url: httpMcpUrl(port), ts: Date.now() })
    appendDiagnostic('http-supervisor-start', { port, pid: process.pid, interval_ms: intervalMs })
    let serverPid = null
    let nextProbeAt = 0
    let lastStateBeatAt = Date.now()
    while (true) {
        // A server that exits between probes used to stay dead for the rest of
        // the interval, and Claude Code connects to this port exactly once, when
        // its session starts, and reads a refused connection as a permanent
        // session-long "gm has disconnected". The window in which nothing
        // listens is the whole failure, so it is one watch tick (~1 s), not one
        // poll interval (15 s). The pid is watched between probes because an
        // exit is visible at once; the probe still runs on its interval because
        // a server can keep its pid and stop answering.
        const serverExited = serverPid !== null && pidAlive(serverPid) === false
        try {
            if (Date.now() >= nextProbeAt || serverExited) {
                const health = await probeHealth(port)
                if (health) {
                    serverPid = health.pid ?? serverPid
                } else {
                    const result = await ensureHttpSingleton({ port })
                    appendDiagnostic(result.url ? 'http-supervisor-restarted' : 'http-supervisor-restart-failed', {
                        port,
                        pid: result.pid ?? null,
                        error: result.error ?? null,
                        noticed_by: serverExited ? 'pid-watch' : 'health-probe',
                    })
                    serverPid = result.pid ?? null
                }
                nextProbeAt = Date.now() + intervalMs
            }
            // One throw out of a probe used to leave the loop, return from the
            // supervisor, and exit the process -- supervision over just because
            // a single fetch rejected. A supervisor's only job is to outlive
            // faults, so a round that fails is a round to repeat.
            if (Date.now() - lastStateBeatAt >= SUPERVISOR_STATE_BEAT_MS) {
                const owner = readSupervisorState(port)
                if (owner?.pid && owner.pid !== process.pid) {
                    appendDiagnostic('http-supervisor-superseded', { port, owner_pid: owner.pid, pid: process.pid })
                    return { port, supervised: false, reason: 'another supervisor took this port' }
                }
                writeSupervisorState({ port, pid: process.pid, url: httpMcpUrl(port), ts: Date.now() })
                lastStateBeatAt = Date.now()
            }
        } catch (error) {
            appendDiagnostic('http-supervisor-round-failed', { port, error: describeError(error), server_pid: serverPid })
            nextProbeAt = Date.now() + intervalMs
        }
        await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_WATCH_MS))
    }
}
