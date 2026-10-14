import { agentplugDir } from './paths.js'
import { execFileSync, spawn } from './process-port.js'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pidAlive } from './dispatch.js'
import { portListenerState } from './ports.js'
import { recordChild } from './child-ledger.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { keepServingOnAsyncFailure, logSignalExits } from './transport-guard.js'
import { DEFAULT_HOST, DEFAULT_PORT, HEALTH_PATH, MCP_PATH } from './http-transport.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { compareVersions } from './self-update.js'

const STATE_FILE_NAME = 'gm-mcp-http.json'
const INSTANCE_FILE_PREFIX = 'gm-mcp-http-instance-'
const SUPERVISOR_FILE_PATTERN = /^gm-mcp-http-supervisor-(\d+)\.json$/
const PROBE_TIMEOUT_MS = 1_500
const SWEEP_PROBE_TIMEOUT_MS = 400
const STARTUP_WAIT_MS = 20_000
const STARTUP_POLL_MS = 250
const RETIRE_WAIT_MS = 5_000
const RETIRE_POLL_MS = 200
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

function readStateFile(filePath, port = null) {
    let state
    try {
        state = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
        if (error?.code !== 'ENOENT') appendDiagnostic('singleton-state-corrupt', { file: filePath, error: describeError(error) })
        return null
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        appendDiagnostic('singleton-state-corrupt', { file: filePath, error: 'not a JSON object' })
        return null
    }
    if (port !== null && Number(state.port) !== Number(port)) return null
    return state
}

function writeStateFile(filePath, state) {
    try {
        mkdirSync(path.dirname(filePath), { recursive: true })
        const temporary = `${filePath}.${process.pid}.tmp`
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        renameSync(temporary, filePath)
        return true
    } catch {
        return false
    }
}

function dropFile(filePath) {
    try {
        rmSync(filePath, { force: true })
        return true
    } catch {
        return false
    }
}

function writeSingletonState(state) {
    writeStateFile(stateFilePath(), state)
}

export function recordSingletonState({ port = defaultHttpPort(), pid = null } = {}) {
    writeSingletonState({ port, pid, url: httpMcpUrl(port), ts: Date.now(), reused: true })
}

function dropSingletonState() {
    dropFile(stateFilePath())
}

function dropSingletonStateForPort(port) {
    const recorded = readStateFile(stateFilePath(), null)
    if (Number(recorded?.port) === Number(port)) dropSingletonState()
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
    if (child.pid) recordChild({ pid: child.pid, kind: 'http-server', port, verb: 'ensure-http', note: entry })
    return child.pid ?? null
}

export function instanceFilePath(port = defaultHttpPort()) {
    return path.join(agentplugDir(), `${INSTANCE_FILE_PREFIX}${port}.json`)
}

export function supervisorStateFilePath(port = defaultHttpPort()) {
    return path.join(agentplugDir(), `gm-mcp-http-supervisor-${port}.json`)
}

export function versionBehind(candidate) {
    if (typeof candidate !== 'string' || candidate === '') return false
    return compareVersions(candidate, BUNDLE_VERSION) < 0
}

export function registeredHttpPorts() {
    const ports = new Set()
    let names = []
    try {
        names = readdirSync(agentplugDir())
    } catch {
        names = []
    }
    for (const name of names) {
        if (name.startsWith(INSTANCE_FILE_PREFIX) && name.endsWith('.json')) {
            const port = Number(name.slice(INSTANCE_FILE_PREFIX.length, -'.json'.length))
            if (Number.isInteger(port) && port > 0) ports.add(port)
            continue
        }
        const supervisorName = SUPERVISOR_FILE_PATTERN.exec(name)
        if (supervisorName) {
            const port = Number(supervisorName[1])
            if (Number.isInteger(port) && port > 0) ports.add(port)
        }
    }
    const recorded = readStateFile(stateFilePath(), null)
    const recordedPort = Number(recorded?.port)
    if (Number.isInteger(recordedPort) && recordedPort > 0) ports.add(recordedPort)
    return [...ports].sort((left, right) => left - right)
}

export function recordHttpInstance({ port = defaultHttpPort(), host = DEFAULT_HOST, version = BUNDLE_VERSION, supervisorPid = null } = {}) {
    const file = instanceFilePath(port)
    const state = {
        port,
        host,
        pid: process.pid,
        version,
        entry: launchedEntryPath(),
        supervisor_pid: supervisorPid ?? null,
        ts: Date.now(),
    }
    writeStateFile(file, state)
    process.once('exit', () => {
        const current = readStateFile(file, port)
        if (Number(current?.pid) === process.pid) dropFile(file)
    })
    appendDiagnostic('http-instance-registered', { port, pid: process.pid, version, supervisor_pid: state.supervisor_pid })
    return state
}

export function liveSupervisorPid(port, instance = null, now = Date.now()) {
    const state = readStateFile(supervisorStateFilePath(port), port)
    if (state && Number.isInteger(Number(state.pid)) && pidAlive(state.pid) === true) {
        const interval = Number.isFinite(state.interval_ms) ? state.interval_ms : SUPERVISOR_INTERVAL_MS
        const staleAfter = Math.max(SUPERVISOR_STATE_STALE_MS, interval * 4)
        if (typeof state.ts === 'number' && now - state.ts < staleAfter) return Number(state.pid)
    }
    const recorded = Number(instance?.supervisor_pid)
    if (Number.isInteger(recorded) && recorded > 0 && pidAlive(recorded) === true) return recorded
    return null
}

export function portOwnerPid(port) {
    const state = portListenerState(port)
    if (state.measured !== true || state.hasListener !== true) return null
    return pidAlive(state.ownerPid) === true ? state.ownerPid : null
}

export function portHasListener(port) {
    const state = portListenerState(port)
    return state.measured === true ? state.hasListener : null
}

export function recordedServerPid(instance, supervisor, port = null) {
    const state = port === null ? null : portListenerState(port)
    if (state?.measured === true && state.hasListener === false) return null
    const ownerPid = port === null ? null : portOwnerPid(port)
    for (const candidate of [Number(instance?.pid), Number(supervisor?.server_pid)]) {
        if (!Number.isInteger(candidate) || candidate <= 0) continue
        if (pidAlive(candidate) !== true) continue
        if (ownerPid !== null && ownerPid !== candidate) continue
        return candidate
    }
    return null
}

export function establishedConnectionCount(port) {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    const locals = establishedLocalPorts()
    if (locals === null) return null
    return locals.filter((local) => local === wanted).length
}

function establishedLocalPorts() {
    if (process.platform !== 'win32') {
        const viaSs = establishedLocalPortsViaSs()
        if (viaSs !== null) return viaSs
    }
    return establishedLocalPortsViaNetstat()
}

function localPortOf(address) {
    const match = /[:.](\d+)$/.exec(address ?? '')
    return match === null ? null : Number(match[1])
}

function establishedLocalPortsViaSs() {
    let text = ''
    try {
        text = execFileSync('ss', ['-Htn', 'state', 'established'], {
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
    } catch {
        return null
    }
    const locals = []
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4) continue
        const local = localPortOf(fields[2])
        if (local === null) return null
        locals.push(local)
    }
    return locals
}

function establishedLocalPortsViaNetstat() {
    let text = ''
    try {
        text = execFileSync('netstat', ['-an'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
    } catch {
        return null
    }
    if (!text.includes('ESTABLISHED')) return []
    const localFieldIndex = process.platform === 'win32' ? 1 : 3
    const locals = []
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4 || !/^tcp/i.test(fields[0])) continue
        if (!fields.includes('ESTABLISHED')) continue
        const local = localPortOf(fields[localFieldIndex])
        if (local === null) return null
        locals.push(local)
    }
    return locals.length === 0 ? null : locals
}

export function parentPidOf(pid) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    try {
        if (process.platform === 'win32') {
            const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${wanted}'; if ($p) { $p.ParentProcessId }`], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 15_000,
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            const fields = text.trim().split(/\s+/).filter(Boolean)
            const parsed = Number.parseInt(fields[fields.length - 1] ?? '', 10)
            return Number.isInteger(parsed) && parsed > 0 ? parsed : null
        }
        const text = execFileSync('ps', ['-o', 'ppid=', '-p', String(wanted)], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const parsed = Number.parseInt(text.trim(), 10)
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null
    } catch {
        return null
    }
}

async function retireHttpInstance({ port, pid, reason, version = null }) {
    const target = Number(pid)
    if (!Number.isInteger(target) || target <= 0 || target === process.pid) return false
    appendDiagnostic('http-instance-retire', { port, pid: target, reason, running_version: version, installed_version: BUNDLE_VERSION })
    try {
        process.kill(target)
    } catch (error) {
        appendDiagnostic('http-instance-retire-signal-failed', { port, pid: target, reason, error: describeError(error) })
        return false
    }
    const deadline = Date.now() + RETIRE_WAIT_MS
    while (Date.now() < deadline) {
        if (!(await probeHealth(port, SWEEP_PROBE_TIMEOUT_MS))) break
        await new Promise((resolve) => setTimeout(resolve, RETIRE_POLL_MS))
    }
    if (await probeHealth(port, SWEEP_PROBE_TIMEOUT_MS)) {
        appendDiagnostic('http-instance-retire-refused', { port, pid: target, reason, waited_ms: RETIRE_WAIT_MS })
        return false
    }
    dropInstanceFiles(port)
    appendDiagnostic('http-instance-retired', { port, pid: target, reason })
    return true
}

export function dropInstanceFiles(port) {
    dropFile(instanceFilePath(port))
    dropFile(supervisorStateFilePath(port))
    dropSingletonStateForPort(port)
}

export async function reapDeadHttpInstances() {
    const reaped = []
    for (const port of registeredHttpPorts()) {
        const instance = readStateFile(instanceFilePath(port), port)
        const supervisor = readStateFile(supervisorStateFilePath(port), port)
        if (recordedServerPid(instance, supervisor, port) !== null) continue
        if (await probeHealth(port, SWEEP_PROBE_TIMEOUT_MS)) continue
        dropInstanceFiles(port)
        appendDiagnostic('http-instance-reaped-dead', {
            port,
            instance_pid: instance?.pid ?? null,
            supervisor_pid: supervisor?.pid ?? null,
            recorded_server_pid: supervisor?.server_pid ?? null,
        })
        reaped.push({ port, reason: 'server-dead' })
    }
    return reaped
}

export async function replaceBehindHttpInstances({ now = Date.now() } = {}) {
    const replaced = []
    for (const port of registeredHttpPorts()) {
        const instance = readStateFile(instanceFilePath(port), port)
        const supervisor = readStateFile(supervisorStateFilePath(port), port)
        if (recordedServerPid(instance, supervisor, port) === null) continue
        if (instance === null && supervisor === null) continue
        const health = await probeHealth(port, SWEEP_PROBE_TIMEOUT_MS)
        if (!health) continue
        const pid = Number(health.pid ?? instance?.pid)
        const version = health.version ?? instance?.version ?? null
        if (!versionBehind(version)) continue
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
        const supervisorPid = liveSupervisorPid(port, instance, now)
        const supervisionArmed = supervisorPid !== null || Number(instance?.supervisor_pid ?? 0) > 0
        if (supervisorPid !== null && supervisorPid !== process.pid) {
            try {
                process.kill(supervisorPid)
            } catch {
            }
        }
        const retired = await retireHttpInstance({ port, pid, reason: 'version-behind', version })
        if (!retired) continue
        const started = await ensureHttpSingleton({ port, wait: false, sweep: false })
        if (supervisionArmed) ensureHttpSupervisor({ port, force: true })
        appendDiagnostic('http-instance-replaced', { port, from_version: version, to_version: BUNDLE_VERSION, replaced_pid: pid, started_pid: started?.pid ?? null })
        replaced.push({ port, pid, from_version: version, to_version: BUNDLE_VERSION, started_pid: started?.pid ?? null, reason: 'version-behind' })
    }
    return replaced
}

export async function reapOrphanedHttpInstances({ now = Date.now() } = {}) {
    const reaped = []
    for (const port of registeredHttpPorts()) {
        const instance = readStateFile(instanceFilePath(port), port)
        const pid = Number(instance?.pid)
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
        if (Number(instance.supervisor_pid ?? 0) <= 0) continue
        if (pidAlive(pid) !== true) continue
        if (liveSupervisorPid(port, instance, now) !== null) continue
        const parentPid = parentPidOf(pid)
        if (parentPid === null || pidAlive(parentPid) !== false) continue
        const attached = establishedConnectionCount(port)
        if (attached !== 0) {
            appendDiagnostic('http-instance-orphan-attached', { port, pid, connections: attached, parent_pid: parentPid })
            continue
        }
        const retired = await retireHttpInstance({ port, pid, reason: 'orphaned-no-supervisor-dead-parent' })
        if (retired) reaped.push({ port, pid, reason: 'orphaned' })
    }
    return reaped
}

export const PORT_POOL_FROM = 8787
export const PORT_POOL_TO = 8879

export async function reclaimDeadPortRegistries() {
    const reclaimed = []
    for (const port of registeredHttpPorts()) {
        const instance = readStateFile(instanceFilePath(port), port)
        const supervisor = readStateFile(supervisorStateFilePath(port), port)
        if (recordedServerPid(instance, supervisor, port) !== null) continue
        if (await probeHealth(port, SWEEP_PROBE_TIMEOUT_MS)) continue
        if (portOwnerPid(port) !== null) continue
        dropInstanceFiles(port)
        appendDiagnostic('http-port-reclaimed', { port, instance_pid: instance?.pid ?? null, supervisor_pid: supervisor?.pid ?? null })
        reclaimed.push(port)
    }
    return reclaimed
}

export function portIsFree(port) {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted <= 0) return false
    if (portOwnerPid(wanted) !== null) return false
    const instance = readStateFile(instanceFilePath(wanted), wanted)
    const supervisor = readStateFile(supervisorStateFilePath(wanted), wanted)
    return recordedServerPid(instance, supervisor, wanted) === null
}

export function allocateHttpPort({ preferred = null, from = PORT_POOL_FROM, to = PORT_POOL_TO } = {}) {
    const wanted = Number(preferred ?? defaultHttpPort())
    if (Number.isInteger(wanted) && wanted > 0 && portIsFree(wanted)) return wanted
    for (let port = Math.min(from, to); port <= Math.max(from, to); port += 1) {
        if (portIsFree(port)) return port
    }
    return null
}

export async function sweepHttpInstances(options = {}) {
    const reclaimed = await reclaimDeadPortRegistries()
    const orphaned = await reapOrphanedHttpInstances(options)
    const dead = await reapDeadHttpInstances()
    const replaced = await replaceBehindHttpInstances(options)
    return { dead, replaced, orphaned, reclaimed }
}

export async function ensureHttpSingleton({ port = defaultHttpPort(), timeoutMs = STARTUP_WAIT_MS, wait = true, sweep = true } = {}) {
    if (port === 'auto') {
        await reclaimDeadPortRegistries()
        port = allocateHttpPort({ preferred: defaultHttpPort() }) ?? defaultHttpPort()
    }
    if (sweep) await reapDeadHttpInstances()

    const live = await probeHealth(port)
    if (live && !versionBehind(live.version)) {
        writeSingletonState({ port, pid: live.pid ?? null, url: httpMcpUrl(port), ts: Date.now(), reused: true })
        return { url: httpMcpUrl(port), port, pid: live.pid ?? null, reused: true, version: live.version ?? null }
    }

    if (live) {
        const retired = await retireHttpInstance({ port, pid: live.pid ?? null, reason: 'version-behind', version: live.version ?? null })
        if (!retired) {
            appendDiagnostic('http-singleton-behind-kept', {
                port,
                pid: live.pid ?? null,
                running_version: live.version ?? null,
                installed_version: BUNDLE_VERSION,
            })
            writeSingletonState({ port, pid: live.pid ?? null, url: httpMcpUrl(port), ts: Date.now(), reused: true })
            return { url: httpMcpUrl(port), port, pid: live.pid ?? null, reused: true, version: live.version ?? null }
        }
    }

    const recorded = readStateFile(stateFilePath(), port)
    if (recorded?.pid && pidAlive(recorded.pid) === true) {
        const late = await waitForHealth(port, 5_000)
        if (late) {
            return { url: httpMcpUrl(port), port, pid: late.pid ?? recorded.pid, reused: true, version: late.version ?? null }
        }
        const retired = await retireHttpInstance({ port, pid: recorded.pid, reason: 'unresponsive-recorded-pid' })
        appendDiagnostic('http-singleton-unresponsive', {
            port,
            recorded_pid: recorded.pid,
            retired,
            note: 'a live pid holds the port but answers no health check',
        })
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

export function supervisorIntervalMs() {
    const seconds = Number((process.env.GM_MCP_HTTP_SUPERVISOR_INTERVAL_SECONDS || '').trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : SUPERVISOR_INTERVAL_MS
}

export function supervisorEnabled() {
    const value = envValue('GM_MCP_HTTP_SUPERVISOR')
    return !(value !== null && OFF_VALUES.has(value))
}

function readSupervisorState(port) {
    return readStateFile(supervisorStateFilePath(port), port)
}

function writeSupervisorState(state) {
    writeStateFile(supervisorStateFilePath(state?.port), state)
}

function supervisorRunning(state, now = Date.now()) {
    if (!state?.pid || pidAlive(state.pid) !== true) return false
    const interval = Number.isFinite(state.interval_ms) ? state.interval_ms : SUPERVISOR_INTERVAL_MS
    const staleAfter = Math.max(SUPERVISOR_STATE_STALE_MS, interval * 4)
    return typeof state.ts === 'number' && now - state.ts < staleAfter
}

export function ensureHttpSupervisor({ port = defaultHttpPort(), intervalMs = supervisorIntervalMs(), force = false } = {}) {
    if (!force && !supervisorEnabled()) return { port, pid: null, started: false, reason: 'disabled' }
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
    if (child.pid) recordChild({ pid: child.pid, kind: 'http-supervisor', port, verb: 'http-supervise', note: entry })
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
        await sweepHttpInstances()
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
