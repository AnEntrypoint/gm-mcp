import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { attributePid, attributeRows } from './child-ledger.js'
import { pidAlive } from './dispatch.js'
import { classifyGmServerCommand, classifyRunnerCommand } from './gm-cmdline.js'
import { listeningPidOf, portAcceptsConnection, portListenerState } from './ports.js'
import { readProcessTableAsync, windowsTableSpawnCount, withWindowsTablePass } from './process-table.js'
import {
    dropHttpRecord,
    establishedConnectionCount,
    instanceFilePath,
    launchedEntryPath,
    liveSupervisorPid,
    parentPidOf,
    portOwnerPid,
    probeHealth,
    registeredHttpPorts,
    supervisorStateFilePath,
} from './singleton.js'
import { ageMsSince } from './timestamp.js'
import { agentplugDir } from './paths.js'
import { lockPidOf } from './janitor.js'

const BROWSER_NAMES = new Set(['chrome', 'chrome.exe', 'msedge', 'msedge.exe', 'firefox', 'firefox.exe'])
export const DEFAULT_LEAK_KINDS = ['exec']

export const MCP_CLIENT_PATTERNS = [
    /(^|[\\/])(claude|claude-code|code|code-insiders|codium|cursor|windsurf|zed|cline|roo-code|copilot|gemini)(\.exe)?(\s|$)/i,
    /visual studio code/i,
    /@modelcontextprotocol/i,
    /--mcp-config/i,
    /mcp-client/i,
]

const MAX_PARENT_HOPS = 8
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

function unattributedScanEnabled() {
    const raw = (process.env.GM_MCP_REAP_UNATTRIBUTED || '').trim().toLowerCase()
    return !(raw !== '' && OFF_VALUES.has(raw))
}

export const VERDICT = { RETIRE: 'retire', KEEP: 'keep', UNKNOWN: 'unknown' }

function measure(name, value, pass) {
    return { predicate: name, value, pass }
}

export function parentAbandoned(parentPid, recordedPpid = null) {
    if (parentPid === null || !Number.isInteger(Number(parentPid)) || Number(parentPid) <= 0) return false
    if (pidAlive(parentPid) === false) return true
    if (process.platform === 'win32') return false
    const recorded = Number(recordedPpid)
    if (Number.isInteger(recorded) && recorded > 0) return Number(parentPid) !== recorded
    return Number(parentPid) === 1
}

// Parent pid first seen for each unattributed candidate, keyed by pid and command. A later sweep that finds another parent
// has seen the process re-parented (Linux hands an orphan to the nearest child subreaper, not to pid 1), so its parent is abandoned.
const firstSeenParent = new Map()

function reparentedSinceFirstSeen(pid, ppid, command) {
    const seen = firstSeenParent.get(pid)
    if (!seen || seen.command !== command) {
        firstSeenParent.set(pid, { ppid, command })
        return false
    }
    return seen.ppid !== ppid
}

function pruneFirstSeenParents(livePids) {
    const live = new Set(livePids)
    for (const pid of firstSeenParent.keys()) if (!live.has(pid)) firstSeenParent.delete(pid)
}

// The shared win32 process-table read (process-table.js) answers this, so a reap pass spawns powershell once.
async function windowsCommandByPid() {
    return new Map((await readProcessTableAsync()).map((row) => [Number(row.pid), row.command]))
}

const execFileAsync = promisify(execFile)

async function commandLineOf(pid) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    if (process.platform === 'win32') {
        const command = (await windowsCommandByPid()).get(wanted)
        return typeof command === 'string' && command !== '' ? command : null
    }
    try {
        const { stdout } = await execFileAsync('ps', ['-o', 'args=', '-p', String(wanted)], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
        const value = stdout.trim()
        return value === '' ? null : value
    } catch {
        return null
    }
}

async function isProtectedBrowser(pid) {
    const command = await commandLineOf(pid)
    if (command === null) return false
    const lowered = command.toLowerCase()
    if (![...BROWSER_NAMES].some((name) => lowered.includes(name.toLowerCase()))) return false
    return !/--user-data-dir[=\s]/.test(lowered)
}

function readJson(filePath) {
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
        return null
    }
}

function verdictOf(predicates, extra = {}) {
    const failed = predicates.filter((entry) => entry.pass !== true)
    const unmeasured = predicates.filter((entry) => entry.value === null)
    if (unmeasured.length > 0) {
        return { verdict: VERDICT.UNKNOWN, predicates, unmeasured: unmeasured.map((entry) => entry.predicate), ...extra }
    }
    if (failed.length > 0) {
        return { verdict: VERDICT.KEEP, predicates, protected_by: failed.map((entry) => entry.predicate), ...extra }
    }
    return { verdict: VERDICT.RETIRE, predicates, ...extra }
}

// The recorded server pid is dead, so the registry record is stale. Retiring it removes the record and signals nothing.
// A listener on the port or a live supervisor keeps it, and an unmeasured listener leaves the verdict unknown.
async function staleRecordFinding(port, serverPid, instance, now) {
    const listener = await portListenerState(port)
    const supervisorPid = liveSupervisorPid(port, instance, now)
    return verdictOf([
        measure('attributed', 'registry', true),
        measure('server-dead', false, true),
        measure('no-listener', listener.measured ? (listener.hasListener ? 'listener-' + listener.ownerPid : false) : null, listener.measured === true && listener.hasListener === false),
        measure('no-live-supervisor', supervisorPid === null ? true : supervisorPid, supervisorPid === null),
    ], {
        source: 'http-instance',
        port,
        pid: serverPid,
        stale_record: true,
        supervisor_pid: supervisorPid,
        note: 'recorded server pid ' + serverPid + ' is dead, so the registry record is stale',
    })
}

export async function assessHttpInstances({ now = Date.now(), roots = [] } = {}) {
    const findings = []
    for (const port of registeredHttpPorts()) {
        const instance = readJson(instanceFilePath(port))
        const supervisor = readJson(supervisorStateFilePath(port))
        const serverPid = Number(instance?.pid ?? supervisor?.server_pid ?? 0)
        if (!Number.isInteger(serverPid) || serverPid <= 0) {
            const listener = await listeningPidOf(port)
            findings.push({
                source: 'http-instance',
                port,
                pid: null,
                verdict: VERDICT.KEEP,
                protected_by: ['attributed'],
                predicates: [measure('attributed', null, false)],
                note: 'no recorded server pid for this registry',
                listener_pid: listener,
            })
            continue
        }
        if (pidAlive(serverPid) === false) {
            findings.push(await staleRecordFinding(port, serverPid, instance, now))
            continue
        }
        const ownerPid = await portOwnerPid(port)
        const health = await probeHealth(port)
        const healthPid = Number(health?.pid ?? 0)
        const identity = ownerPid === serverPid ? 'socket-owner' : (healthPid > 0 && healthPid === serverPid ? 'health-pid' : null)
        const supervisorPid = liveSupervisorPid(port, instance, now)
        const parentPid = await parentPidOf(serverPid)
        const attached = await establishedConnectionCount(port)
        const notBrowser = (await isProtectedBrowser(serverPid)) === false
        const predicates = [
            measure('attributed', 'registry', true),
            measure('not-self', serverPid !== process.pid, serverPid !== process.pid),
            measure('server-alive', pidAlive(serverPid), pidAlive(serverPid) === true),
            measure('identity-held', identity, identity !== null),
            measure('no-live-supervisor', supervisorPid === null ? true : supervisorPid, supervisorPid === null),
            measure('parent-abandoned', parentPid, parentAbandoned(parentPid)),
            measure('zero-attached-clients', attached, attached === 0),
            measure('not-user-browser', notBrowser, notBrowser),
        ]
        findings.push(verdictOf(predicates, {
            source: 'http-instance',
            port,
            pid: serverPid,
            supervisor_pid: supervisorPid,
            parent_pid: parentPid,
            attached_clients: attached,
            listener_pid: ownerPid,
        }))
    }
    return findings
}

export async function assessLeases({ roots = [] } = {}) {
    const findings = []
    for (const root of roots) {
        const leaseDir = path.join(root, '.gm', 'browser-lease')
        if (!existsSync(leaseDir)) continue
        let sessions = []
        try {
            sessions = readdirSync(leaseDir)
        } catch {
            sessions = []
        }
        for (const session of sessions) {
            const ownerPath = path.join(leaseDir, session, 'owner.json')
            const record = readJson(ownerPath)
            if (!record) continue
            const holderPid = Number(record.pid ?? 0)
            const browserPid = Number(record.browserPid ?? 0)
            const port = Number(record.port ?? 0)
            const holderAlive = holderPid > 0 ? pidAlive(holderPid) : null
            const browserAlive = browserPid > 0 ? pidAlive(browserPid) : null
            const portOpen = port > 0 ? await portAcceptsConnection(port) : null
            const holdsPort = port > 0 ? await portOwnerPid(port) : null
            const attached = port > 0 ? await establishedConnectionCount(port) : null

            const deathEvidence = [
                holderPid > 0 && holderAlive === false ? `holder-pid-${holderPid}-dead` : null,
                browserPid > 0 && browserAlive === false ? `browser-pid-${browserPid}-dead` : null,
                port > 0 && portOpen === false ? `port-${port}-refused` : null,
            ].filter(Boolean)

            const predicates = [
                measure('attributed', ownerPath, true),
                measure('not-self', holderPid !== process.pid, holderPid > 0 && holderPid !== process.pid),
                measure('death-evidence', deathEvidence.length > 0 ? deathEvidence.join('+') : null, deathEvidence.length > 0),
                measure('port-not-held', port > 0 ? holdsPort === null : 'no-port', port === 0 || holdsPort === null),
                measure('zero-attached-clients', attached, port === 0 ? true : attached === 0),
            ]
            findings.push(verdictOf(predicates, {
                source: 'lease',
                root: path.resolve(root),
                session,
                lease_file: ownerPath,
                holder_pid: holderPid > 0 ? holderPid : null,
                browser_pid: browserPid > 0 ? browserPid : null,
                port: port > 0 ? port : null,
                heartbeat_at: record.heartbeatAt ?? null,
                heartbeat_age_ms: ageMsSince(record.heartbeatAt),
                owner: record.owner ?? null,
            }))
        }
    }
    return findings
}

export async function assessAttributedChildren({ roots = [], liveSessionIds = null, kinds = DEFAULT_LEAK_KINDS } = {}) {
    const findings = []
    const seen = new Set()
    for (const root of roots) {
        for (const row of attributeRows({ root })) {
            if (!kinds.includes(row.kind ?? null)) continue
            const pid = Number(row.pid)
            if (seen.has(pid)) continue
            seen.add(pid)
            // A dead pid has nothing left to retire: its row is history. Assessing it re-reads every
            // ledger and spawns ps per row, so the hourly pass over many projects would take minutes.
            if (pidAlive(pid) !== true) continue
            const attributed = attributePid(pid, { root })
            const parentPid = await parentPidOf(pid)
            const port = Number.isInteger(Number(row.port)) && Number(row.port) > 0 ? Number(row.port) : null
            const attached = port === null ? null : await establishedConnectionCount(port)
            const sessionLive = typeof row.session_id === 'string' && liveSessionIds ? liveSessionIds.has(row.session_id) : null
            const notBrowser = (await isProtectedBrowser(pid)) === false
            const predicates = [
                measure('attributed', attributed.dispatch_id ?? row.kind, true),
                measure('not-self', pid !== process.pid, pid !== process.pid),
                measure('alive', pidAlive(pid), pidAlive(pid) === true),
                measure('parent-abandoned', parentPid, parentAbandoned(parentPid, attributed.recorded_ppid)),
                measure('no-live-lane', sessionLive === null ? 'no-session-recorded' : sessionLive === false, sessionLive === null ? true : sessionLive === false),
                measure('zero-attached-clients', attached, port === null ? true : attached === 0),
                measure('not-user-browser', notBrowser, notBrowser),
            ]
            findings.push(verdictOf(predicates, {
                source: 'attributed-child',
                pid,
                kind: row.kind ?? null,
                verb: row.verb ?? null,
                dispatch_id: attributed.dispatch_id ?? null,
                session_id: row.session_id ?? null,
                root: row.root ?? path.resolve(root),
                parent_pid: parentPid,
                port,
                recorded_age_ms: attributed.recorded_age_ms ?? null,
            }))
        }
    }
    return findings
}

export async function liveMcpClientInParentChain(pid, parentPid, table, { maxHops = MAX_PARENT_HOPS } = {}) {
    const byPid = new Map()
    for (const row of table) {
        const rowPid = Number(row.pid)
        if (Number.isInteger(rowPid) && rowPid > 0) byPid.set(rowPid, row)
    }
    let current = Number.isInteger(Number(parentPid)) && Number(parentPid) > 0 ? Number(parentPid) : await parentPidOf(pid)
    const seen = new Set()
    let unreadable = null
    for (let hop = 0; hop < maxHops; hop += 1) {
        if (!Number.isInteger(current) || current <= 1) break
        if (seen.has(current)) break
        seen.add(current)
        if (pidAlive(current) !== true) return { value: `parent-${current}-dead`, client: false }
        const command = byPid.get(current)?.command ?? await commandLineOf(current)
        if (typeof command !== 'string' || command === '') {
            unreadable = current
        } else if (MCP_CLIENT_PATTERNS.some((pattern) => pattern.test(command))) {
            return { value: `client:${current}:${command.slice(0, 80)}`, client: true }
        }
        const next = byPid.get(current)?.ppid ?? await parentPidOf(current)
        if (!Number.isInteger(Number(next)) || Number(next) <= 0) break
        current = Number(next)
    }
    if (unreadable !== null) return { value: null, client: false, unreadable }
    return { value: 'no-client-in-parent-chain', client: false }
}

export async function assessUnattributedServers({ roots = [], liveSessionIds = null, now = Date.now(), processes = null, entryPath = null } = {}) {
    const table = Array.isArray(processes) ? processes : await readProcessTableAsync()
    const hint = entryPath ?? safeEntryPath()
    const candidates = []
    for (const row of table) {
        const info = classifyGmServerCommand(row.command, { entryPath: hint })
        if (info === null || info.transport === 'supervisor') continue
        const pid = Number(row.pid)
        if (!Number.isInteger(pid) || pid <= 0) continue
        candidates.push({ pid, row, info })
    }
    pruneFirstSeenParents(candidates.map((candidate) => candidate.pid))
    if (candidates.length === 0) return []
    const ledgerByPid = new Map()
    for (const root of [...roots, null]) {
        for (const ledgerRow of attributeRows({ root })) {
            const pid = Number(ledgerRow.pid)
            if (!Number.isInteger(pid) || pid <= 0) continue
            const held = ledgerByPid.get(pid) ?? []
            held.push(ledgerRow)
            ledgerByPid.set(pid, held)
        }
    }
    const ownedPorts = []
    for (const port of registeredHttpPorts()) ownedPorts.push({ port, owner: await portOwnerPid(port) })

    const rowByPid = new Map(table.map((entry) => [Number(entry.pid), entry]))
    const findings = []
    for (const { pid, row, info } of candidates) {
        const ledgerRows = ledgerByPid.get(pid) ?? []
        const ledgerRow = ledgerRows.length > 0 ? ledgerRows[ledgerRows.length - 1] : null
        const parentPid = Number.isInteger(Number(row.ppid)) && Number(row.ppid) > 0 ? Number(row.ppid) : await parentPidOf(pid)
        const attributed = ledgerRow !== null
        const reparented = reparentedSinceFirstSeen(pid, parentPid, row.command)
        const evidence = [attributed ? null : 'unattributed', parentAbandoned(parentPid) || reparented ? 'parent-abandoned' : null].filter(Boolean).join('+')
        const port = info.port
        const health = port === null ? null : await probeHealth(port)
        const owned = ownedPorts.find((entry) => entry.owner === pid) ?? null
        let laneValue = 'no-ledger-row'
        let lanePass = true
        const sessionId = typeof ledgerRow?.session_id === 'string' && ledgerRow.session_id !== '' ? ledgerRow.session_id : null
        if (attributed && sessionId !== null) {
            laneValue = `session:${sessionId}:${liveSessionIds ? (liveSessionIds.has(sessionId) ? 'live' : 'dead') : 'lane-unmeasured'}`
            lanePass = liveSessionIds ? !liveSessionIds.has(sessionId) : false
        } else if (attributed) {
            laneValue = 'no-session-recorded'
        }
        const chain = info.transport === 'stdio'
            ? await liveMcpClientInParentChain(pid, parentPid, table)
            : { value: 'not-a-stdio-server', client: false }
        const parentRow = rowByPid.get(parentPid)
        const supervisedBy = parentRow !== undefined && classifyGmServerCommand(parentRow.command)?.transport === 'supervisor' ? parentPid : null
        const alive = pidAlive(pid)
        const notBrowser = (await isProtectedBrowser(pid)) === false
        const predicates = [
            measure('gm-mcp-entry', info.entry, true),
            measure('not-self', pid !== process.pid, pid !== process.pid),
            measure('alive', alive, alive === true),
            measure('not-live-http-instance', health !== null ? `health-answers-on-port-${port}` : (owned !== null ? `owns-port-${owned.port}` : (port === null ? 'stdio-no-port' : `port-${port}-silent`)), health === null && owned === null),
            measure('orphan-evidence', evidence === '' ? null : evidence, evidence !== ''),
            measure('no-live-lane', laneValue, lanePass),
            measure('no-live-mcp-client', chain.value, chain.value !== null && chain.client === false),
            measure('not-supervised-child', supervisedBy === null ? 'no-supervisor-parent' : 'supervisor-' + supervisedBy, supervisedBy === null),
            measure('not-user-browser', notBrowser, notBrowser),
        ]
        findings.push(verdictOf(predicates, {
            source: 'unattributed-server',
            pid,
            transport: info.transport,
            entry: info.entry,
            port,
            parent_pid: parentPid,
            attributed,
            session_id: ledgerRow?.session_id ?? null,
            dispatch_id: ledgerRow?.dispatch_id ?? null,
            started_at: row.started_at ?? null,
            age_ms: ageMsSince(row.started_at, now),
            scanned_processes: table.length,
        }))
    }
    return findings
}

function safeEntryPath() {
    try {
        return launchedEntryPath()
    } catch {
        return null
    }
}

async function retirePid(pid, { signal = 'SIGTERM' } = {}) {
    try {
        if (process.platform === 'win32') {
            await execFileAsync('taskkill', ['/PID', String(Number(pid)), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
            process.kill(Number(pid), signal)
        }
        return true
    } catch {
        return false
    }
}

function removeFile(filePath) {
    try {
        rmSync(filePath, { force: true })
        return true
    } catch {
        return false
    }
}

// Runner and guard rule. A runner process is stale unless it is the pid its install dir's daemon-owner.lock names, and a
// guard process is stale unless it is the pid in daemon-guard.lock. A lock that is missing or names a dead pid, and a process
// whose install dir cannot be read, make that process unknown, so nothing is signalled for it.
const GRACE_MS = 30 * 1000
const GRACE_POLL_MS = 250

// install_dir() is AGENTPLUG_HOME when it is set, else $HOME/.agentplug. Linux reads the start environment from /proc.
export function installDirOfPid(pid) {
    let raw
    try {
        raw = readFileSync('/proc/' + pid + '/environ', 'utf8')
    } catch {
        return null
    }
    const vars = new Map()
    for (const entry of raw.split('\0')) {
        const at = entry.indexOf('=')
        if (at > 0) vars.set(entry.slice(0, at), entry.slice(at + 1))
    }
    const override = (vars.get('AGENTPLUG_HOME') || '').trim()
    if (override !== '') return path.resolve(override)
    const home = vars.get('HOME') || ''
    return home !== '' ? path.join(home, '.agentplug') : null
}

// An exited but unreaped process still answers kill -0; its /proc stat reads state Z.
function gone(pid) {
    if (pidAlive(pid) === false) return true
    try {
        return /^\d+ \([^)]*\) Z/.test(readFileSync('/proc/' + pid + '/stat', 'utf8'))
    } catch {
        return false
    }
}

export function assessRunnerProcesses({ processes = [] } = {}) {
    const ownDir = agentplugDir()
    const ownOwner = lockPidOf(ownDir, 'daemon-owner.lock')
    const findings = []
    for (const row of processes) {
        const info = classifyRunnerCommand(row.command)
        if (info === null) continue
        const pid = Number(row.pid)
        if (!Number.isInteger(pid) || pid <= 0) continue
        const lockName = info.kind === 'guard' ? 'daemon-guard.lock' : 'daemon-owner.lock'
        const dir = installDirOfPid(pid) ?? (ownOwner === pid ? ownDir : null)
        const lockPid = dir === null ? null : lockPidOf(dir, lockName)
        const lockLive = lockPid !== null && pidAlive(lockPid) === true
        findings.push(verdictOf([
            measure('attributed', dir, dir !== null),
            measure('lock-holder-live', lockLive ? lockPid : null, lockLive),
            measure('not-lock-holder', pid === lockPid ? 'holder' : 'not-holder', pid !== lockPid),
            measure('not-self', pid !== process.pid, pid !== process.pid),
        ], {
            source: info.kind,
            pid,
            install_dir: dir,
            lock: dir === null ? null : path.join(dir, lockName),
            lock_pid: lockPid,
        }))
    }
    return findings
}

// Retires what the reaper judged. Registry records go through dropHttpRecord, runner and guard processes get SIGTERM and
// then SIGKILL after GRACE_MS, and other processes get the signal retirePid has always sent.
export async function applyRetirements(findings) {
    const retired = []
    const graceful = []
    for (const finding of findings) {
        if (finding.verdict !== VERDICT.RETIRE) continue
        if (finding.source === 'lease') {
            removeFile(finding.lease_file)
            retired.push({ ...finding, action: 'lease-record-removed' })
            continue
        }
        if (finding.stale_record === true) {
            retired.push({ ...finding, action: dropHttpRecord(finding.port) ? 'record-removed' : 'record-removal-failed' })
            continue
        }
        if (finding.source === 'runner' || finding.source === 'guard') {
            graceful.push(finding)
            continue
        }
        const signalled = await retirePid(finding.pid)
        retired.push({ ...finding, action: signalled ? 'signalled' : 'signal-refused' })
    }
    if (graceful.length > 0) retired.push(...(await retireWithGrace(graceful)))
    return retired
}

async function retireWithGrace(findings) {
    if (process.platform === 'win32') {
        const done = []
        for (const finding of findings) done.push({ ...finding, action: (await retirePid(finding.pid)) ? 'signalled' : 'signal-refused' })
        return done
    }
    const out = findings.map((finding) => {
        let sent = true
        try {
            process.kill(finding.pid, 'SIGTERM')
        } catch {
            sent = false
        }
        return { ...finding, action: sent ? 'sigterm-sent' : 'signal-refused' }
    })
    const deadline = Date.now() + GRACE_MS
    while (Date.now() < deadline && out.some((entry) => entry.action === 'sigterm-sent' && !gone(entry.pid))) {
        await new Promise((resolve) => setTimeout(resolve, GRACE_POLL_MS))
    }
    for (const entry of out) {
        if (entry.action !== 'sigterm-sent') continue
        if (gone(entry.pid)) {
            entry.action = 'terminated'
            continue
        }
        try {
            process.kill(entry.pid, 'SIGKILL')
            entry.action = 'killed-after-grace'
        } catch {
            entry.action = 'kill-refused'
        }
    }
    return out
}

export function reapReport(options = {}) {
    return withWindowsTablePass(() => reapPass(options))
}

async function reapPass({ roots = [], apply = false, liveSessionIds = null, kinds = DEFAULT_LEAK_KINDS, now = Date.now(), unattributed = unattributedScanEnabled() } = {}) {
    const started = Date.now()
    const tableSpawnsBefore = windowsTableSpawnCount()
    const unattributedEnabled = unattributed !== false && unattributed !== null
    const table = Array.isArray(unattributed) ? unattributed : await readProcessTableAsync()
    const findings = [
        ...(await assessHttpInstances({ roots, now })),
        ...(await assessLeases({ roots })),
        ...(await assessAttributedChildren({ roots, liveSessionIds, kinds })),
        ...(unattributedEnabled ? await assessUnattributedServers({ roots, liveSessionIds, now, processes: table }) : []),
        ...assessRunnerProcesses({ processes: table }),
    ]
    const retired = apply ? await applyRetirements(findings) : []
    const counts = { retire: 0, keep: 0, unknown: 0 }
    for (const finding of findings) counts[finding.verdict] += 1
    return {
        apply,
        retired,
        findings,
        counts,
        unattributed_scan: { enabled: unattributedEnabled, scanned: table.length },
        generated_at: new Date(now).toISOString(),
        elapsed_ms: Date.now() - started,
        windows_table_spawns: windowsTableSpawnCount() - tableSpawnsBefore,
    }
}

export function formatFindings(report) {
    const lines = [`gm-mcp leak reaper (${report.apply ? 'APPLY' : 'DRY-RUN'}) -- retire ${report.counts.retire}, keep ${report.counts.keep}, unknown ${report.counts.unknown}`]
    for (const finding of report.findings) {
        const subject = finding.port !== null && finding.port !== undefined ? `port ${finding.port}` : `pid ${finding.pid}`
        const detail = finding.verdict === VERDICT.RETIRE
            ? finding.predicates.map((entry) => `${entry.predicate}=${String(entry.value)}`).join(' ')
            : `protected by ${(finding.protected_by ?? finding.unmeasured ?? []).join(', ')}`
        lines.push(`  ${finding.verdict.toUpperCase().padEnd(7)} ${finding.source} ${subject} -- ${detail}`)
    }
    for (const entry of report.retired) {
        lines.push(`  RETIRED ${entry.source} pid ${entry.pid ?? '-'} (${entry.action})`)
    }
    return lines.join('\n')
}

export function leaseRecordAgeMs(leaseFile) {
    try {
        return Date.now() - statSync(leaseFile).mtimeMs
    } catch {
        return null
    }
}
