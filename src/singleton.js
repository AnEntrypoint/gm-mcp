import { isPlainObject } from './plain-object.js';
import { agentplugDir } from './paths.js'
import { execFile } from './process-port.js'
import { classifyGmServerCommand } from './gm-cmdline.js'
import { readProcessTableAsync } from './process-table.js'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pidAlive } from './dispatch.js'
import { portListenerState } from './ports.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { DEFAULT_HOST, DEFAULT_PORT, HEALTH_PATH, MCP_PATH } from './http-transport.js'
import { measuredMs } from './timestamp.js'

const STATE_FILE_NAME = 'gm-mcp-http.json'
const INSTANCE_FILE_PREFIX = 'gm-mcp-http-instance-'
const SUPERVISOR_FILE_PATTERN = /^gm-mcp-http-supervisor-(\d+)\.json$/
const PROBE_TIMEOUT_MS = 1_500
const SWEEP_PROBE_TIMEOUT_MS = 400
const SUPERVISOR_INTERVAL_MS = 15_000
const SUPERVISOR_STATE_STALE_MS = 60_000

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

export function launchedEntryPath() {
    const argv1 = process.argv[1]
    if (argv1 && /\.(mjs|cjs|js)$/i.test(argv1) && existsSync(argv1)) return path.resolve(argv1)
    return fileURLToPath(import.meta.url)
}

// The installed bundle entry: the deployed release-channel copy when it exists, else the entry this process runs from.
// bundle-drift.js hashes it to detect a stale running bundle. Nothing is spawned from it.
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

function dropFile(filePath) {
    try {
        rmSync(filePath, { force: true })
        return true
    } catch {
        return false
    }
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

export function instanceFilePath(port = defaultHttpPort()) {
    return path.join(agentplugDir(), `${INSTANCE_FILE_PREFIX}${port}.json`)
}

export function supervisorStateFilePath(port = defaultHttpPort()) {
    return path.join(agentplugDir(), `gm-mcp-http-supervisor-${port}.json`)
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

// Windows parent pids come from the shared process-table read (readProcessTableAsync), not one PowerShell
// Get-CimInstance cold start per pid: a reap pass costs one powershell.exe spawn however many candidates it has.
export async function parentPidOf(pid) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    if (process.platform === 'win32') {
        const row = (await readProcessTableAsync()).find((entry) => Number(entry.pid) === wanted)
        const parsed = Number(row?.ppid)
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null
    }
    const text = await execFileText('ps', ['-o', 'ppid=', '-p', String(wanted)], {
        windowsHide: true,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (text === null) return null
    const parsed = Number.parseInt(text.trim(), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function dropInstanceFiles(port) {
    dropFile(instanceFilePath(port))
    dropFile(supervisorStateFilePath(port))
    dropSingletonStateForPort(port)
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

function supervisorRunning(state, now = Date.now()) {
    if (!state?.pid || pidAlive(state.pid) !== true) return false
    const interval = Number.isFinite(state.interval_ms) ? state.interval_ms : SUPERVISOR_INTERVAL_MS
    const staleAfter = Math.max(SUPERVISOR_STATE_STALE_MS, interval * 4)
    return typeof state.ts === 'number' && now - state.ts < staleAfter
}

