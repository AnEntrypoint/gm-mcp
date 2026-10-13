import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { attributePid, attributeRows } from './child-ledger.js'
import { pidAlive } from './dispatch.js'
import { portAcceptsConnection } from './ports.js'
import {
    establishedConnectionCount,
    instanceFilePath,
    liveSupervisorPid,
    parentPidOf,
    portOwnerPid,
    probeHealth,
    registeredHttpPorts,
    supervisorStateFilePath,
} from './singleton.js'

const BROWSER_NAMES = new Set(['chrome', 'chrome.exe', 'msedge', 'msedge.exe', 'firefox', 'firefox.exe'])

/**
 * A reaping verdict is only ever "retire" when every predicate was MEASURED true. A predicate
 * whose value could not be measured (null) is not a pass: it downgrades the verdict to
 * "unknown", and an unknown process is never signalled. That is the whole safety property --
 * the reaper would rather leave a leak standing than retire live work it could not prove dead.
 */
export const VERDICT = { RETIRE: 'retire', KEEP: 'keep', UNKNOWN: 'unknown' }

function measure(name, value, pass) {
    return { predicate: name, value, pass }
}

function commandLineOf(pid) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    try {
        if (process.platform === 'win32') {
            const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${wanted}'; if ($p) { $p.CommandLine }`], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
            const value = text.trim()
            return value === '' ? null : value
        }
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
    // A browser launched with a profile dir belongs to a lane; one without it is the user's own.
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

/**
 * gm-mcp HTTP singleton instances. The registry is itself the attribution, so these need no
 * ledger row. The added predicate over the existing sweep is identity: a recorded pid that is
 * alive but does not own the listening socket is a RE-USED pid, and treating it as live is what
 * let a dead registry keep its port forever.
 */
export async function assessHttpInstances({ now = Date.now(), roots = [] } = {}) {
    const findings = []
    for (const port of registeredHttpPorts()) {
        const instance = readJson(instanceFilePath(port))
        const supervisor = readJson(supervisorStateFilePath(port))
        const serverPid = Number(instance?.pid ?? supervisor?.server_pid ?? 0)
        if (!Number.isInteger(serverPid) || serverPid <= 0) {
            const listener = listeningPidOf(port)
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
        const ownerPid = portOwnerPid(port)
        const health = await probeHealth(port)
        const healthPid = Number(health?.pid ?? 0)
        // Identity is proven by the socket owner or by the server naming itself on /health. A
        // TCP row naming a pid that no longer exists is a phantom (socket handed to a child), so
        // it is unmeasured rather than a contradiction -- otherwise 8787 could never be assessed.
        const identity = ownerPid === serverPid ? 'socket-owner' : (healthPid > 0 && healthPid === serverPid ? 'health-pid' : null)
        const supervisorPid = liveSupervisorPid(port, instance, now)
        const parentPid = parentPidOf(serverPid)
        const attached = establishedConnectionCount(port)
        const predicates = [
            measure('attributed', 'registry', true),
            measure('not-self', serverPid !== process.pid, serverPid !== process.pid),
            measure('server-alive', pidAlive(serverPid), pidAlive(serverPid) === true),
            measure('identity-held', identity, identity !== null),
            measure('no-live-supervisor', supervisorPid === null ? true : supervisorPid, supervisorPid === null),
            measure('parent-dead', parentPid, parentPid !== null && pidAlive(parentPid) === false),
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

/**
 * Browser/accelerated-session leases. A heartbeat proves a writer is running, not that the
 * thing it leases exists, so a lease is retired on positive evidence of death -- holder dead,
 * browser dead, or the recorded DevTools port refusing a connection -- regardless of heartbeat.
 */
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
            const holdsPort = port > 0 ? portOwnerPid(port) : null
            const attached = port > 0 ? establishedConnectionCount(port) : null

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
                heartbeat_age_ms: Number.isFinite(Number(record.heartbeatAt)) ? Date.now() - Number(record.heartbeatAt) : null,
                owner: record.owner ?? null,
            }))
        }
    }
    return findings
}

/**
 * Ledger-attributed children. Attribution is the gate: a pid no dispatch claimed is not a
 * candidate at all, which is what keeps this from becoming a bulk process filter.
 */
export async function assessAttributedChildren({ roots = [], liveSessionIds = null } = {}) {
    const findings = []
    const seen = new Set()
    for (const root of roots) {
        for (const row of attributeRows({ root })) {
            const pid = Number(row.pid)
            if (seen.has(pid)) continue
            seen.add(pid)
            const attributed = attributePid(pid, { root })
            const parentPid = parentPidOf(pid)
            const port = Number.isInteger(Number(row.port)) && Number(row.port) > 0 ? Number(row.port) : null
            const attached = port === null ? null : establishedConnectionCount(port)
            const sessionLive = typeof row.session_id === 'string' && liveSessionIds ? liveSessionIds.has(row.session_id) : null
            const predicates = [
                measure('attributed', attributed.dispatch_id ?? row.kind, true),
                measure('not-self', pid !== process.pid, pid !== process.pid),
                measure('alive', pidAlive(pid), pidAlive(pid) === true),
                measure('parent-dead', parentPid, parentPid !== null && pidAlive(parentPid) === false),
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

async function retirePid(pid, { signal = 'SIGTERM' } = {}) {
    try {
        process.kill(Number(pid), signal)
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

export async function reapReport({ roots = [], apply = false, liveSessionIds = null, now = Date.now() } = {}) {
    const findings = [
        ...(await assessHttpInstances({ roots, now })),
        ...(await assessLeases({ roots })),
        ...(await assessAttributedChildren({ roots, liveSessionIds })),
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
    return { apply, retired, findings, counts, generated_at: new Date(now).toISOString() }
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
