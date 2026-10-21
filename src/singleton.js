import { isPlainObject } from './plain-object.js';
import { agentplugDir } from './paths.js'
import { execFile, spawn } from './process-port.js'
import { classifyGmServerCommand } from './gm-cmdline.js'
import { readProcessTableAsync } from './process-table.js'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pidAlive } from './dispatch.js'
import { portListenerState } from './ports.js'
import { recordChild } from './child-ledger.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { keepServingOnAsyncFailure, logSignalExits } from './transport-guard.js'
import { hiddenDetachedOptions } from './hidden-spawn.js'
import { DEFAULT_HOST, DEFAULT_PORT, HEALTH_PATH, MCP_PATH } from './http-transport.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { compareVersions } from './self-update.js'
import { measuredMs } from './timestamp.js'

const STATE_FILE_NAME = 'gm-mcp-http.json'
const INSTANCE_FILE_PREFIX = 'gm-mcp-http-instance-'
const SUPERVISOR_FILE_PATTERN = /^gm-mcp-http-supervisor-(\d+)\.json$/
const PROBE_TIMEOUT_MS = 1_500
const SWEEP_PROBE_TIMEOUT_MS = 400
const STARTUP_WAIT_MS = 20_000
const STARTUP_POLL_MS = 250
const RETIRE_WAIT_MS = 5_000
const RETIRE_POLL_MS = 200
const RETIRE_KILL_WAIT_MS = 3_000
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
    return true
}

export function launchedEntryPath() {
    const argv1 = process.argv[1]
    if (argv1 && /\.(mjs|cjs|js)$/i.test(argv1) && existsSync(argv1)) return path.resolve(argv1)
    return fileURLToPath(import.meta.url)
}

// The entry the HTTP singleton and its supervisor are spawned from. The deployed bundle is the release-channel
// copy whose check keeps it current and hands over to the newer build, so a singleton is started from it whenever
// it exists. A singleton started from a repo checkout would never receive a release.
export function serverEntryPath() {
    const deployed = path.join(homedir(), '.gm-tools', 'gm-mcp-server.mjs')
    if (existsSync(deployed)) return deployed
    return launchedEntryPath()
}

function readStateFile(filePath, port = null) {
    let state
    try {
        state = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
        if (error?.code !== 'ENOENT') appendDiagnostic('singleton-state-corrupt', { file: filePath, error: describeError(error) })
        return null
    }
    if (!isPlainObject(state)) {
        appendDiagnostic('singleton-state-corrupt', { file: filePath, error: 'not a JSON object' })
        return null
    }
    if (port !== null && Number(state.port) !== Number(port)) return null
    return state
}

function writeStateFile(filePath, state) {
    try {
        mkdirSync(path.dirname(filePath), { recursive: true })
        const tempPath = `${filePath}.${process.pid}.tmp`
        writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        renameSync(tempPath, filePath)
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

function isSharedRecordPort(port) {
    return Number(port) === DEFAULT_PORT
}

function writeSingletonState(state) {
    if (!isSharedRecordPort(state?.port)) return
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
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(healthUrl(port), { signal: controller.signal })
        if (!response.ok) return null
        const payload = await response.json()
        return payload?.ok === true ? payload : null
    } catch {
        return null
    } finally {
        clearTimeout(deadline)
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
    const entry = serverEntryPath()
    const { stdio, fd } = childStdio()
    const env = { ...process.env, GM_MCP_TRANSPORT: 'http', GM_MCP_NO_HTTP_SINGLETON: '1' }
    delete env.GM_MCP_HANDOVER
    const child = spawn(process.execPath, [entry, '--http', '--port', String(port), '--host', String(host)], {
        cwd: homedir(),
        ...hiddenDetachedOptions({ stdio }),
        env,
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

export async function portOwnerPid(port) {
    const state = await portListenerState(port)
    if (state.measured !== true || state.hasListener !== true) return null
    return pidAlive(state.ownerPid) === true ? state.ownerPid : null
}

export async function portHasListener(port) {
    const state = await portListenerState(port)
    return state.measured === true ? state.hasListener : null
}

export async function recordedServerPid(instance, supervisor, port = null) {
    const state = port === null ? null : await portListenerState(port)
    if (state?.measured === true && state.hasListener === false) return null
    const ownerPid = port === null ? null : await portOwnerPid(port)
    for (const candidate of [Number(instance?.pid), Number(supervisor?.server_pid)]) {
        if (!Number.isInteger(candidate) || candidate <= 0) continue
        if (pidAlive(candidate) !== true) continue
        if (ownerPid !== null && ownerPid !== candidate) continue
        return candidate
    }
    return null
}

export async function holderIsOwn(port, pid) {
    return (await recordedServerPid(readStateFile(instanceFilePath(port), port), readStateFile(supervisorStateFilePath(port), port), port)) === Number(pid)
}

export async function establishedConnectionCount(port) {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    const locals = await establishedLocalPorts()
    if (locals === null) return null
    return locals.filter((local) => local === wanted).length
}

const execFileAsync = promisify(execFile)

async function execFileText(file, args, options) {
    try {
        return (await execFileAsync(file, args, { encoding: 'utf8', ...options })).stdout
    } catch {
        return null
    }
}

async function establishedLocalPorts() {
    if (process.platform !== 'win32') {
        const viaSs = await establishedLocalPortsViaSs()
        if (viaSs !== null) return viaSs
    }
    else {
        const viaPowerShell = await establishedLocalPortsViaGetNetTCPConnection()
        if (viaPowerShell !== null) return viaPowerShell
    }
    return establishedLocalPortsViaNetstat()
}

// Get-NetTCPConnection filters on the State enum, so the result does not depend on the OS display language (netstat prints localized state names).
async function establishedLocalPortsViaGetNetTCPConnection() {
    const script = 'Get-NetTCPConnection -State Established -ErrorAction Stop | ForEach-Object { $_.LocalPort }'
    const text = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (text === null) return null
    const locals = []
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        const port = Number(trimmed)
        if (!Number.isInteger(port) || port <= 0) return null
        locals.push(port)
    }
    return locals.length === 0 ? null : locals
}

function localPortOf(address) {
    const match = /[:.](\d+)$/.exec(address ?? '')
    return match === null ? null : Number(match[1])
}

async function establishedLocalPortsViaSs() {
    const text = await execFileText('ss', ['-Htn', 'state', 'established'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (text === null) return null
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

async function establishedLocalPortsViaNetstat() {
    const text = await execFileText('netstat', ['-an'], { windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (text === null) return null
    return netstatEstablishedLocalPorts(text, process.platform === 'win32')
}

const WINDOWS_WILDCARD_FOREIGN = /^(0\.0\.0\.0|\[::\]):0$/
const WINDOWS_NON_ESTABLISHED_STATE = /^(LISTEN|TIME_WAIT|CLOSE_WAIT|SYN_|FIN_|LAST_ACK|CLOSING|CLOSED|DELETE)/i

export function netstatEstablishedLocalPorts(text, win) {
    if (!win && !text.includes('ESTABLISHED')) return []
    const localFieldIndex = win ? 1 : 3
    const locals = []
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4 || !/^tcp/i.test(fields[0])) continue
        if (win) {
            // The state column is localized on non-English Windows. A state that is neither ESTABLISHED nor a known
            // English non-established state cannot be classified, so the whole read is unknown (null), not a guess.
            if (WINDOWS_WILDCARD_FOREIGN.test(fields[2])) continue
            if (/^ESTABLISHED$/i.test(fields[3])) { /* kept below */ }
            else if (WINDOWS_NON_ESTABLISHED_STATE.test(fields[3])) continue
            else return null
        } else if (!fields.includes('ESTABLISHED')) {
            continue
        }
        const local = localPortOf(fields[localFieldIndex])
        if (local === null) return null
        locals.push(local)
    }
    return locals.length === 0 ? null : locals
}

// Windows parent pids come from one process-table snapshot shared by a reap pass (TTL 5 s), not one
// PowerShell Get-CimInstance cold start per pid: N candidates cost one powershell.exe spawn, not N.
const WINDOWS_PARENT_SNAPSHOT_TTL_MS = 5_000
let windowsParentSnapshot = null

async function windowsParentPidOf(wanted) {
    const now = Date.now()
    if (windowsParentSnapshot === null || now - windowsParentSnapshot.at > WINDOWS_PARENT_SNAPSHOT_TTL_MS) {
        windowsParentSnapshot = { at: now, rows: await readProcessTableAsync() }
    }
    const row = windowsParentSnapshot.rows.find((entry) => Number(entry.pid) === wanted)
    const parsed = Number(row?.ppid)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function parentPidOf(pid) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    if (process.platform === 'win32') return windowsParentPidOf(wanted)
    const text = await execFileText('ps', ['-o', 'ppid=', '-p', String(wanted)], {
        windowsHide: true,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (text === null) return null
    const parsed = Number.parseInt(text.trim(), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function signalRetiredPid(port, pid, reason, signal) {
    try {
        process.kill(pid, signal)
    } catch (error) {
        appendDiagnostic('http-instance-retire-signal-failed', { port, pid, reason, signal, error: describeError(error) })
    }
}

async function retireWaitGone(port, pid, waitMs) {
    const deadline = Date.now() + waitMs
    for (;;) {
        const gone = pidAlive(pid) !== true && !(await probeHealth(port, SWEEP_PROBE_TIMEOUT_MS))
        if (gone || Date.now() >= deadline) return gone
        await new Promise((resolve) => setTimeout(resolve, RETIRE_POLL_MS))
    }
}

async function retireHttpInstance({ port, pid, reason, version = null }) {
    const target = Number(pid)
    if (!Number.isInteger(target) || target <= 0 || target === process.pid) return false
    appendDiagnostic('http-instance-retire', { port, pid: target, reason, running_version: version, installed_version: BUNDLE_VERSION })
    signalRetiredPid(port, target, reason, 'SIGTERM')
    if (!(await retireWaitGone(port, target, RETIRE_WAIT_MS))) {
        appendDiagnostic('http-instance-retire-escalated', { port, pid: target, reason, from: 'SIGTERM', to: 'SIGKILL' })
        signalRetiredPid(port, target, reason, 'SIGKILL')
        if (!(await retireWaitGone(port, target, RETIRE_KILL_WAIT_MS))) {
            appendDiagnostic('http-instance-retire-refused', { port, pid: target, reason, waited_ms: RETIRE_WAIT_MS + RETIRE_KILL_WAIT_MS })
            return false
        }
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
        if (await recordedServerPid(instance, supervisor, port) !== null) continue
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
        if (await recordedServerPid(instance, supervisor, port) === null) continue
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
        const parentPid = await parentPidOf(pid)
        if (parentPid === null || pidAlive(parentPid) !== false) continue
        const attached = await establishedConnectionCount(port)
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
        if (await recordedServerPid(instance, supervisor, port) !== null) continue
        if (await probeHealth(port, SWEEP_PROBE_TIMEOUT_MS)) continue
        if (await portOwnerPid(port) !== null) continue
        dropInstanceFiles(port)
        appendDiagnostic('http-port-reclaimed', { port, instance_pid: instance?.pid ?? null, supervisor_pid: supervisor?.pid ?? null })
        reclaimed.push(port)
    }
    return reclaimed
}

export async function portIsFree(port) {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted <= 0) return false
    if (await portOwnerPid(wanted) !== null) return false
    const instance = readStateFile(instanceFilePath(wanted), wanted)
    const supervisor = readStateFile(supervisorStateFilePath(wanted), wanted)
    return await recordedServerPid(instance, supervisor, wanted) === null
}

export async function allocateHttpPort({ preferred = null, from = PORT_POOL_FROM, to = PORT_POOL_TO } = {}) {
    const wanted = Number(preferred ?? defaultHttpPort())
    if (Number.isInteger(wanted) && wanted > 0 && await portIsFree(wanted)) return wanted
    for (let port = Math.min(from, to); port <= Math.max(from, to); port += 1) {
        if (await portIsFree(port)) return port
    }
    return null
}

export async function listHttpSupervisors({ processes = null, platform = process.platform } = {}) {
    const table = Array.isArray(processes) ? processes : await readProcessTableAsync({ platform })
    const rows = []
    for (const row of table) {
        const info = classifyGmServerCommand(row.command, { entryPath: launchedEntryPath() })
        if (info === null || info.transport !== 'supervisor' || info.port === null) continue
        const pid = Number(row.pid)
        if (!Number.isInteger(pid) || pid <= 0) continue
        const ppid = Number(row.ppid)
        rows.push({
            pid,
            ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
            port: info.port,
            started_at: measuredMs(row.started_at),
            command: row.command,
        })
    }
    return rows
}

export function supervisorToKeep(group, state = null, now = Date.now()) {
    const freshClaimPid = Number(state?.pid)
    if (Number.isInteger(freshClaimPid) && freshClaimPid > 0 && supervisorRunning(state, now) && group.some((row) => row.pid === freshClaimPid)) return freshClaimPid
    const timed = group.filter((row) => Number.isFinite(row.started_at)).sort((left, right) => right.started_at - left.started_at)
    if (timed.length === 0) return null
    const tiedAtSecond = timed.length > 1 && timed[1].started_at === timed[0].started_at
    if (tiedAtSecond) return null
    return timed[0].pid
}

function signalSupervisorPid(pid) {
    try {
        process.kill(Number(pid))
        return true
    } catch {
        return false
    }
}

function dupeReapEnabled() {
    const value = envValue('GM_MCP_HTTP_SUPERVISOR_DUPE_REAP')
    return !(value !== null && OFF_VALUES.has(value))
}

export async function retireDuplicateHttpSupervisors({ processes = null, now = Date.now(), signalPid = signalSupervisorPid, dryRun = false, platform = process.platform } = {}) {
    if (!dupeReapEnabled()) return []
    const rows = await listHttpSupervisors({ processes, platform })
    const retired = []
    for (const port of [...new Set(rows.map((row) => row.port))].sort((left, right) => left - right)) {
        const group = rows.filter((row) => row.port === port)
        if (group.length < 2) continue
        const state = readStateFile(supervisorStateFilePath(port), port)
        const keepPid = supervisorToKeep(group, state, now)
        if (keepPid === null) {
            appendDiagnostic('http-supervisor-dupe-unresolved', { port, pids: group.map((row) => row.pid), reason: 'no live claim is measurably fresher than the others' })
            continue
        }
        for (const row of group) {
            if (row.pid === keepPid || row.pid === process.pid) continue
            const signalled = dryRun ? true : signalPid(row.pid)
            appendDiagnostic('http-supervisor-retired-dupe', { port, pid: row.pid, kept_pid: keepPid, started_at: row.started_at, signalled, dry_run: dryRun })
            retired.push({ port, pid: row.pid, kept_pid: keepPid, signalled, reason: 'duplicate-supervisor' })
        }
    }
    return retired
}

export async function sweepHttpInstances(options = {}) {
    const duplicate_supervisors = await retireDuplicateHttpSupervisors(options)
    const reclaimed = await reclaimDeadPortRegistries()
    const orphaned = await reapOrphanedHttpInstances(options)
    const dead = await reapDeadHttpInstances()
    const replaced = await replaceBehindHttpInstances(options)
    return { dead, replaced, orphaned, reclaimed, duplicate_supervisors }
}

export async function ensureHttpSingleton({ port = defaultHttpPort(), timeoutMs = STARTUP_WAIT_MS, wait = true, sweep = true } = {}) {
    if (port === 'auto') {
        await reclaimDeadPortRegistries()
        port = (await allocateHttpPort({ preferred: defaultHttpPort() })) ?? defaultHttpPort()
    }
    if (sweep) await reapDeadHttpInstances()

    const live = await probeHealth(port)
    if (live && !versionBehind(live.version)) {
        writeSingletonState({ port, pid: live.pid ?? null, url: httpMcpUrl(port), ts: Date.now(), reused: true })
        return { url: httpMcpUrl(port), port, pid: live.pid ?? null, reused: true, version: live.version ?? null }
    }

    if (live) {
        const ownHolder = await holderIsOwn(port, live.pid)
        const retired = ownHolder && await retireHttpInstance({ port, pid: live.pid ?? null, reason: 'version-behind', version: live.version ?? null })
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
    const holderPid = recorded?.pid && pidAlive(recorded.pid) === true
        ? Number(recorded.pid)
        : await recordedServerPid(readStateFile(instanceFilePath(port), port), readStateFile(supervisorStateFilePath(port), port), port)
    if (holderPid !== null) {
        const late = await waitForHealth(port, 5_000)
        if (late) {
            return { url: httpMcpUrl(port), port, pid: late.pid ?? holderPid, reused: true, version: late.version ?? null }
        }
        const retired = await retireHttpInstance({ port, pid: holderPid, reason: 'unresponsive-recorded-pid' })
        appendDiagnostic('http-singleton-unresponsive', {
            port,
            recorded_pid: holderPid,
            retired,
            note: 'a live pid holds the port but answers no health check',
        })
    }
    if (!claimSpawn('singleton', port)) {
        const peer = await waitForHealth(port, timeoutMs)
        if (peer) return { url: httpMcpUrl(port), port, pid: peer.pid ?? null, reused: true, version: peer.version ?? null }
        return { url: null, port, pid: null, reused: false, spawned: false, error: `another starter holds the spawn claim for port ${port}` }
    }
    if (isSharedRecordPort(port)) dropSingletonState()

    const pid = spawnServerProcess({ port })
    if (!wait) {
        appendDiagnostic('http-singleton-spawned', { port, pid, entry: launchedEntryPath(), awaited: false })
        return { url: null, port, pid, reused: false, spawned: true, pending: true, version: null }
    }

    const health = await waitForHealth(port, timeoutMs)
    releaseSpawnClaim('singleton', port)
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

const SPAWN_CLAIM_STALE_MS = 20_000
const EXCLUSIVE_CREATE_FLAG = 'wx'

function spawnClaimPath(name, port) {
    return path.join(agentplugDir(), `gm-mcp-${name}-${port}.claim`)
}

export function claimSpawn(name, port) {
    const file = spawnClaimPath(name, port)
    mkdirSync(agentplugDir(), { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(file, String(Date.now()), { flag: EXCLUSIVE_CREATE_FLAG })
            return true
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error
            const claimedAt = Number(readFileSyncSafe(file))
            if (Number.isFinite(claimedAt) && Date.now() - claimedAt < SPAWN_CLAIM_STALE_MS) return false
            moveStaleClaimAside(file)
        }
    }
    return false
}

function readFileSyncSafe(file) {
    try { return readFileSync(file, 'utf8') } catch { return '' }
}

function moveStaleClaimAside(file) {
    try { renameSync(file, `${file}.${process.pid}.stale`) } catch (error) { appendDiagnostic('spawn-claim-stale-rename-failed', { file, error: describeError(error) }) }
}

export function releaseSpawnClaim(name, port) {
    try { unlinkSync(spawnClaimPath(name, port)) } catch (error) { appendDiagnostic('spawn-claim-unlink-failed', { name, port, error: describeError(error) }) }
}

export function ensureHttpSupervisor({ port = defaultHttpPort(), intervalMs = supervisorIntervalMs(), force = false } = {}) {
    if (!force && !supervisorEnabled()) return { port, pid: null, started: false, reason: 'disabled' }
    const recorded = readSupervisorState(port)
    if (supervisorRunning(recorded)) return { port, pid: recorded.pid, started: false, reason: 'already-running' }
    if (!claimSpawn('supervisor', port)) return { port, pid: null, started: false, reason: 'claim-held' }
    const afterClaim = readSupervisorState(port)
    if (supervisorRunning(afterClaim)) return { port, pid: afterClaim.pid, started: false, reason: 'already-running' }

    const entry = serverEntryPath()
    const { stdio, fd } = childStdio()
    const child = spawn(process.execPath, [entry, 'http-supervise', '--port', String(port), '--interval', String(Math.round(intervalMs / 1000))], {
        ...hiddenDetachedOptions({ stdio }),
        cwd: homedir(),
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
