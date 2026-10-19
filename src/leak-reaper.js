import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { attributePid, attributeRows } from './child-ledger.js'
import { pidAlive } from './dispatch.js'
import { classifyGmServerCommand } from './gm-cmdline.js'
import { listeningPidOf, portAcceptsConnection } from './ports.js'
import { readProcessTable } from './process-table.js'
import {
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
    return Number(parentPid) === 1 || Number(parentPid) === 2
}

const WINDOWS_SNAPSHOT_TTL_MS = 5_000
let windowsSnapshot = null

function windowsCommandByPid() {
    const now = Date.now()
    if (windowsSnapshot === null || now - windowsSnapshot.at > WINDOWS_SNAPSHOT_TTL_MS) {
        windowsSnapshot = { at: now, byPid: new Map(readProcessTable().map((row) => [Number(row.pid), row.command])) }
    }
    return windowsSnapshot.byPid
}

function commandLineOf(pid) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    if (process.platform === 'win32') {
        const command = windowsCommandByPid().get(wanted)
        return typeof command === 'string' && command !== '' ? command : null
    }
    try {
        const text = execFileSync('ps', ['-o', 'args=', '-p', String(wanted)], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
        const value = text.trim()
        return value === '' ? null : value
    } catch {
        return null
    }
}

function isProtectedBrowser(pid) {
    const command = commandLineOf(pid)
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
        const ownerPid = await portOwnerPid(port)
        const health = await probeHealth(port)
        const healthPid = Number(health?.pid ?? 0)
        const identity = ownerPid === serverPid ? 'socket-owner' : (healthPid > 0 && healthPid === serverPid ? 'health-pid' : null)
        const supervisorPid = liveSupervisorPid(port, instance, now)
        const parentPid = await parentPidOf(serverPid)
        const attached = await establishedConnectionCount(port)
        const predicates = [
            measure('attributed', 'registry', true),
            measure('not-self', serverPid !== process.pid, serverPid !== process.pid),
            measure('server-alive', pidAlive(serverPid), pidAlive(serverPid) === true),
            measure('identity-held', identity, identity !== null),
            measure('no-live-supervisor', supervisorPid === null ? true : supervisorPid, supervisorPid === null),
            measure('parent-abandoned', parentPid, parentAbandoned(parentPid)),
            measure('zero-attached-clients', attached, attached === 0),
            measure('not-user-browser', isProtectedBrowser(serverPid) === false, isProtectedBrowser(serverPid) === false),
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
            const predicates = [
                measure('attributed', attributed.dispatch_id ?? row.kind, true),
                measure('not-self', pid !== process.pid, pid !== process.pid),
                measure('alive', pidAlive(pid), pidAlive(pid) === true),
                measure('parent-abandoned', parentPid, parentAbandoned(parentPid, attributed.recorded_ppid)),
                measure('no-live-lane', sessionLive === null ? 'no-session-recorded' : sessionLive === false, sessionLive === null ? true : sessionLive === false),
                measure('zero-attached-clients', attached, port === null ? true : attached === 0),
                measure('not-user-browser', isProtectedBrowser(pid) === false, isProtectedBrowser(pid) === false),
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
        const command = byPid.get(current)?.command ?? commandLineOf(current)
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
    const table = Array.isArray(processes) ? processes : readProcessTable()
    const hint = entryPath ?? safeEntryPath()
    const candidates = []
    for (const row of table) {
        const info = classifyGmServerCommand(row.command, { entryPath: hint })
        if (info === null || info.transport === 'supervisor') continue
        const pid = Number(row.pid)
        if (!Number.isInteger(pid) || pid <= 0) continue
        candidates.push({ pid, row, info })
    }
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

    const findings = []
    for (const { pid, row, info } of candidates) {
        const ledgerRows = ledgerByPid.get(pid) ?? []
        const ledgerRow = ledgerRows.length > 0 ? ledgerRows[ledgerRows.length - 1] : null
        const parentPid = Number.isInteger(Number(row.ppid)) && Number(row.ppid) > 0 ? Number(row.ppid) : await parentPidOf(pid)
        const attributed = ledgerRow !== null
        const evidence = [attributed ? null : 'unattributed', parentAbandoned(parentPid) ? 'parent-abandoned' : null].filter(Boolean).join('+')
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
        const alive = pidAlive(pid)
        const predicates = [
            measure('gm-mcp-entry', info.entry, true),
            measure('not-self', pid !== process.pid, pid !== process.pid),
            measure('alive', alive, alive === true),
            measure('not-live-http-instance', health !== null ? `health-answers-on-port-${port}` : (owned !== null ? `owns-port-${owned.port}` : (port === null ? 'stdio-no-port' : `port-${port}-silent`)), health === null && owned === null),
            measure('orphan-evidence', evidence === '' ? null : evidence, evidence !== ''),
            measure('no-live-lane', laneValue, lanePass),
            measure('no-live-mcp-client', chain.value, chain.value !== null && chain.client === false),
            measure('not-user-browser', isProtectedBrowser(pid) === false, isProtectedBrowser(pid) === false),
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
            execFileSync('taskkill', ['/PID', String(Number(pid)), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
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

export async function reapReport({ roots = [], apply = false, liveSessionIds = null, kinds = DEFAULT_LEAK_KINDS, now = Date.now(), unattributed = unattributedScanEnabled() } = {}) {
    const unattributedEnabled = unattributed !== false && unattributed !== null
    const table = Array.isArray(unattributed) ? unattributed : (unattributedEnabled ? readProcessTable() : [])
    const findings = [
        ...(await assessHttpInstances({ roots, now })),
        ...(await assessLeases({ roots })),
        ...(await assessAttributedChildren({ roots, liveSessionIds, kinds })),
        ...(unattributedEnabled ? await assessUnattributedServers({ roots, liveSessionIds, now, processes: table }) : []),
    ]
    const retired = []
    for (const finding of findings) {
        if (finding.verdict !== VERDICT.RETIRE) continue
        if (!apply) continue
        if (finding.source === 'lease') {
            removeFile(finding.lease_file)
            retired.push({ ...finding, action: 'lease-record-removed' })
            continue
        }
        const signalled = await retirePid(finding.pid)
        retired.push({ ...finding, action: signalled ? 'signalled' : 'signal-refused' })
    }
    const counts = { retire: 0, keep: 0, unknown: 0 }
    for (const finding of findings) counts[finding.verdict] += 1
    return {
        apply,
        retired,
        findings,
        counts,
        unattributed_scan: { enabled: unattributedEnabled, scanned: table.length },
        generated_at: new Date(now).toISOString(),
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
