import { readFileSync } from 'node:fs'

import { attributeRows } from './child-ledger.js'
import { classifyGmServerCommand } from './gm-cmdline.js'
import { MCP_CLIENT_PATTERNS, reapReport, VERDICT } from './leak-reaper.js'
import { listeningPidOf } from './ports.js'
import { liveSessionNameOf, readProcessTable } from './process-table.js'
import { appendDiagnostic, describeError } from './server-log.js'
import {
    launchedEntryPath,
    listHttpSupervisors,
    probeHealth,
    registeredHttpPorts,
    supervisorStateFilePath,
    supervisorToKeep,
} from './singleton.js'
import { measuredMs } from './timestamp.js'

export const DEFAULT_POPULATION_WARN_AT = 8
export const DEFAULT_MIN_RETIRE_AGE_MS = 30 * 60 * 1000
export const DEFAULT_MAX_AUTO_RETIRE_PER_PASS = 3

const MAX_PARENT_HOPS = 8
const LEAK_WATCH_ENV = 'GM_MCP_LEAK_WATCH'
const AUTO_APPLY_ENV = 'GM_MCP_LEAK_AUTO_APPLY'
const POPULATION_WARN_ENV = 'GM_MCP_LEAK_POPULATION_WARN'
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

function envSaysOff(name) {
    const raw = process.env[name]
    return raw !== undefined && OFF_VALUES.has(raw.trim().toLowerCase())
}

function envSaysOn(name) {
    const raw = process.env[name]
    if (raw === undefined) return false
    const value = raw.trim().toLowerCase()
    return value !== '' && !OFF_VALUES.has(value)
}

export function leakWatchEnabled() {
    return !envSaysOff(LEAK_WATCH_ENV)
}

export function autoApplyEnabled() {
    return envSaysOn(AUTO_APPLY_ENV)
}

export function populationWarnAt() {
    const fromEnv = Number((process.env[POPULATION_WARN_ENV] || '').trim())
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_POPULATION_WARN_AT
}

function safeEntryPath() {
    try {
        return launchedEntryPath()
    } catch {
        return null
    }
}

function signalPidByDefault(pid) {
    try {
        process.kill(Number(pid), 'SIGTERM')
        return true
    } catch {
        return false
    }
}

function guard(predicate, value, pass) {
    return { predicate, value, pass }
}

export function censusGmProcesses(table, { entryPath = null } = {}) {
    const hint = entryPath ?? safeEntryPath()
    const servers = []
    const supervisors = []
    for (const row of table) {
        const info = classifyGmServerCommand(row.command, { entryPath: hint })
        if (info === null) continue
        const pid = Number(row.pid)
        if (!Number.isInteger(pid) || pid <= 0) continue
        const ppid = Number(row.ppid)
        const entry = {
            pid,
            ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
            transport: info.transport,
            port: info.port,
            started_at: measuredMs(row.started_at),
        }
        if (info.transport === 'supervisor') supervisors.push(entry)
        else servers.push(entry)
    }
    return { servers, supervisors }
}

export function populationOf(census, { warnAt = populationWarnAt(), now = Date.now() } = {}) {
    const started = [...census.servers, ...census.supervisors]
        .map((entry) => entry.started_at)
        .filter((value) => Number.isFinite(value))
    const total = census.servers.length + census.supervisors.length
    return {
        gm_processes: total,
        servers: census.servers.length,
        supervisors: census.supervisors.length,
        warn_at: warnAt,
        above_warn: total >= warnAt,
        oldest_age_ms: started.length === 0 ? null : Number(now) - Math.min(...started),
    }
}

function supervisorStateOf(port) {
    try {
        const state = JSON.parse(readFileSync(supervisorStateFilePath(port), 'utf8'))
        if (state === null || typeof state !== 'object' || Array.isArray(state)) return null
        return Number(state.port) === Number(port) ? state : null
    } catch {
        return null
    }
}

export function duplicateSupervisorFindings({ processes, now = Date.now() } = {}) {
    const rows = listHttpSupervisors({ processes })
    const findings = []
    for (const port of [...new Set(rows.map((row) => row.port))].sort((left, right) => left - right)) {
        const group = rows.filter((row) => row.port === port)
        if (group.length < 2) continue
        const pids = group.map((row) => row.pid)
        const keptPid = supervisorToKeep(group, supervisorStateOf(port), now)
        findings.push({
            port,
            pids,
            kept_pid: keptPid,
            duplicates: keptPid === null ? [] : pids.filter((pid) => pid !== keptPid),
        })
    }
    return findings
}

export async function sharedHttpPids(ports) {
    const pids = new Set()
    for (const port of ports) {
        const health = await probeHealth(port)
        const healthPid = Number(health?.pid ?? 0)
        if (Number.isInteger(healthPid) && healthPid > 0) pids.add(healthPid)
        const ownerPid = Number(listeningPidOf(port) ?? 0)
        if (Number.isInteger(ownerPid) && ownerPid > 0) pids.add(ownerPid)
    }
    return pids
}

export function parentWalker(table) {
    const byPid = new Map()
    for (const row of table) {
        const pid = Number(row.pid)
        if (Number.isInteger(pid) && pid > 0) byPid.set(pid, row)
    }
    return (pid, ppid, maxHops = MAX_PARENT_HOPS) => {
        const chain = []
        const seen = new Set()
        let current = Number.isInteger(Number(ppid)) && Number(ppid) > 0 ? Number(ppid) : null
        while (current !== null && current > 1 && !seen.has(current) && chain.length < maxHops) {
            seen.add(current)
            const row = byPid.get(current)
            chain.push({ pid: current, command: typeof row?.command === 'string' && row.command !== '' ? row.command : null })
            if (row === undefined) break
            const next = Number(row.ppid)
            current = Number.isInteger(next) && next > 0 ? next : null
        }
        return chain
    }
}

export function ancestorVerdict(chain) {
    let unmeasured = false
    for (const step of chain) {
        if (step.command === null) {
            unmeasured = true
            continue
        }
        if (MCP_CLIENT_PATTERNS.some((pattern) => pattern.test(step.command))) return { client: step, session: null, unmeasured }
        if (liveSessionNameOf(step.command) !== null) return { client: null, session: step, unmeasured }
    }
    return { client: null, session: null, unmeasured }
}

export function autoApplyDecision({ finding, ancestors, sharedPids = new Set(), now = Date.now(), minAgeMs = DEFAULT_MIN_RETIRE_AGE_MS, appliedCount = 0, maxPerPass = DEFAULT_MAX_AUTO_RETIRE_PER_PASS } = {}) {
    const pid = Number(finding?.pid)
    const startedAt = Number(finding?.started_at)
    const ageMs = Number.isFinite(startedAt) && startedAt > 0 ? Number(now) - startedAt : null
    const shared = Number.isInteger(pid) && sharedPids.has(pid)
    const guards = [
        guard('verdict-retire', finding?.verdict ?? null, finding?.verdict === VERDICT.RETIRE),
        guard('candidate-is-stdio-server', finding?.transport ?? null, finding?.transport === 'stdio'),
        guard('not-self', Number.isInteger(pid) ? pid : null, Number.isInteger(pid) && pid > 2 && pid !== process.pid),
        guard('not-shared-http-pid', shared ? 'answers-health-or-owns-a-registered-port' : true, shared === false),
        guard('ancestors-measured', ancestors?.unmeasured === true ? null : true, ancestors?.unmeasured !== true),
        guard('no-live-client-ancestor', ancestors?.client ? `client:${ancestors.client.pid}` : true, !ancestors?.client),
        guard('not-live-session', ancestors?.session ? `session:${ancestors.session.pid}:${liveSessionNameOf(ancestors.session.command)}` : true, !ancestors?.session),
        guard('age-measured', ageMs, ageMs !== null),
        guard('age-over-floor', ageMs === null ? null : `${Math.round(ageMs / 60_000)}m/${Math.round(minAgeMs / 60_000)}m`, ageMs !== null && ageMs >= minAgeMs),
        guard('per-pass-budget', `${appliedCount}/${maxPerPass}`, appliedCount < maxPerPass),
    ]
    const blockedBy = guards.filter((entry) => entry.pass !== true).map((entry) => entry.predicate)
    return { pid, eligible: blockedBy.length === 0, guards, blocked_by: blockedBy }
}

function ledgerRoots() {
    const roots = new Set()
    for (const row of attributeRows({ root: null })) {
        if (typeof row.root === 'string' && row.root !== '') roots.add(row.root)
    }
    return [...roots]
}

function findingSummary(finding) {
    return {
        source: finding.source,
        pid: finding.pid ?? null,
        port: finding.port ?? null,
        transport: finding.transport ?? null,
        age_ms: measuredMs(finding.age_ms),
    }
}

export async function leakWatchReport({ roots = null, processes = null, now = Date.now(), apply = false, httpPorts = null, signalPid = signalPidByDefault, minAgeMs = DEFAULT_MIN_RETIRE_AGE_MS, maxPerPass = DEFAULT_MAX_AUTO_RETIRE_PER_PASS, warnAt = populationWarnAt() } = {}) {
    const table = Array.isArray(processes) ? processes : readProcessTable()
    const scanRoots = Array.isArray(roots) && roots.length > 0 ? roots : ledgerRoots()
    const reap = await reapReport({ roots: scanRoots, apply: false, now, unattributed: table })
    const census = censusGmProcesses(table)
    const duplicates = duplicateSupervisorFindings({ processes: table, now })
    const sharedPids = await sharedHttpPids(Array.isArray(httpPorts) ? httpPorts : registeredHttpPorts())

    const retireable = reap.findings.filter((finding) => finding.verdict === VERDICT.RETIRE)
    const unattributedServers = reap.findings.filter((finding) => finding.source === 'unattributed-server')
    const population = {
        ...populationOf(census, { warnAt, now }),
        unattributed_servers: unattributedServers.length,
        retireable: retireable.length,
    }

    const walk = parentWalker(table)
    const applied = []
    const skipped = []
    let appliedCount = 0
    if (apply) {
        for (const finding of retireable.filter((entry) => entry.source === 'unattributed-server')) {
            const parentPid = Number(finding.parent_pid)
            const ancestors = ancestorVerdict(walk(finding.pid, Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null))
            const decision = autoApplyDecision({ finding, ancestors, sharedPids, now, minAgeMs, appliedCount, maxPerPass })
            if (decision.eligible !== true) {
                skipped.push({ pid: decision.pid, source: finding.source, blocked_by: decision.blocked_by })
                continue
            }
            const signalled = signalPid(decision.pid)
            appliedCount += 1
            applied.push({ pid: decision.pid, signalled, source: finding.source, transport: finding.transport, age_ms: finding.age_ms ?? null })
        }
    }

    const duplicateSupervisorCount = duplicates.reduce((total, entry) => total + entry.duplicates.length, 0)
    return {
        generated_at: new Date(now).toISOString(),
        scanned_processes: table.length,
        population,
        duplicate_supervisors: duplicates,
        duplicate_supervisor_count: duplicateSupervisorCount,
        reap_counts: reap.counts,
        retireable: retireable.map(findingSummary),
        auto_apply: { enabled: apply === true, applied, skipped, min_age_ms: minAgeMs, max_per_pass: maxPerPass },
        notable: population.above_warn || duplicateSupervisorCount > 0 || unattributedServers.length > 0 || applied.length > 0,
    }
}

export function formatLeakWatchLine(report) {
    const population = report.population
    const parts = [
        `${population.gm_processes} gm-mcp process(es) on this host (warn at ${population.warn_at})`,
        `${population.servers} server(s), ${population.supervisors} supervisor(s)`,
        `${population.unattributed_servers} unattributed, ${population.retireable} retireable`,
        `${report.duplicate_supervisor_count} duplicate supervisor(s)`,
    ]
    let line = `gm-mcp: leak watch -- ${parts.join('; ')}`
    if (population.above_warn) line += ' -- ABOVE the population warning threshold'
    if (report.auto_apply.applied.length > 0) {
        line += `; retired ${report.auto_apply.applied.map((entry) => entry.pid).join(',')} automatically`
    } else if (report.population.retireable > 0) {
        const entry = safeEntryPath()
        line += `; retire them with "node ${entry ?? '~/.gm-tools/gm-mcp-server.mjs'} reap --apply"`
    }
    return line
}

export async function runLeakWatchPass(options = {}) {
    if (!leakWatchEnabled()) return { outcome: 'disabled' }
    const apply = typeof options.apply === 'boolean' ? options.apply : autoApplyEnabled()
    let report
    try {
        report = await leakWatchReport({ ...options, apply })
    } catch (error) {
        const reason = describeError(error)
        appendDiagnostic('leak-watch-failed', { error: reason })
        console.error(`gm-mcp: leak watch failed (${reason.split('\n')[0]})`)
        return { outcome: 'failed', error: reason }
    }
    if (report.notable !== true) return { outcome: 'clean', report }
    appendDiagnostic('leak-watch', {
        gm_processes: report.population.gm_processes,
        warn_at: report.population.warn_at,
        above_warn: report.population.above_warn,
        servers: report.population.servers,
        supervisors: report.population.supervisors,
        unattributed_servers: report.population.unattributed_servers,
        retireable: report.population.retireable,
        duplicate_supervisors: report.duplicate_supervisor_count,
        duplicate_ports: report.duplicate_supervisors.map((entry) => entry.port),
        reap_counts: report.reap_counts,
        auto_applied: report.auto_apply.applied.map((entry) => entry.pid),
        auto_apply_enabled: report.auto_apply.enabled,
    })
    console.error(formatLeakWatchLine(report))
    if (report.auto_apply.applied.length > 0) {
        appendDiagnostic('leak-watch-applied', { applied: report.auto_apply.applied, skipped: report.auto_apply.skipped })
    }
    return { outcome: 'reported', report }
}
