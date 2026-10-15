// Orphan detection: a process gm never spawned can still pile up and take the machine with
// it. The 2026-10-15 case was 11 runners reparented to pid 1 (their launching shell had died),
// each holding 200-900 MB RSS after burning under 20 CPU seconds over 1600-2500 seconds alive
// -- a duty ratio near 0.01 -- while the one live run of the same binary was still burning CPU.
// The duty ratio is what separates a leaked process from a busy one, so it is the discriminator
// here, not age alone.
//
// Nothing in this module signals a pid. It reports; retiring an unattributed heavyweight is a
// decision for a human, because a wrong kill is worse than a missed one.
import { readFileSync } from 'node:fs'

import { attributeRows } from './child-ledger.js'
import { classifyGmServerCommand } from './gm-cmdline.js'
import { ageMsSince } from './timestamp.js'

export const DEFAULT_ORPHAN_RSS_MB = 150
export const DEFAULT_ORPHAN_DUTY = 0.02
export const DEFAULT_ORPHAN_MIN_AGE_MS = 900_000
export const DEFAULT_CMDLINE_CHARS = 160

// /proc/<pid>/stat counts CPU in clock ticks; 100 Hz is the Linux default and every value read
// here is a ratio, so a box running another CLK_TCK scales both sides the same way.
const DEFAULT_CLOCK_TICKS = 100

const RSS_ENV = 'GM_MCP_LEAK_ORPHAN_RSS_MB'
const DUTY_ENV = 'GM_MCP_LEAK_ORPHAN_DUTY'
const MIN_AGE_ENV = 'GM_MCP_LEAK_ORPHAN_MIN_AGE_MS'
const SCAN_ENV = 'GM_MCP_LEAK_ORPHANS'
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

function round(value, places) {
    const factor = 10 ** places
    return Math.round(value * factor) / factor
}

export function envNumber(name, fallback) {
    const raw = (process.env[name] ?? '').trim()
    if (raw === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
}

export function orphanScanEnabled() {
    const raw = (process.env[SCAN_ENV] ?? '').trim().toLowerCase()
    return !(raw !== '' && OFF_VALUES.has(raw))
}

export function orphanRssMb() {
    return envNumber(RSS_ENV, DEFAULT_ORPHAN_RSS_MB)
}

export function orphanDuty() {
    return envNumber(DUTY_ENV, DEFAULT_ORPHAN_DUTY)
}

export function orphanMinAgeMs() {
    return envNumber(MIN_AGE_ENV, DEFAULT_ORPHAN_MIN_AGE_MS)
}

// `comm` is wrapped in parentheses and may itself hold spaces and parentheses, so the numeric
// fields are counted from the LAST ')' -- after it, index 0 is field 3 (state), which puts utime
// (field 14) at index 11, stime (field 15) at 12 and starttime (field 22) at 19.
export function parseProcStat(text, { clockTicks = DEFAULT_CLOCK_TICKS } = {}) {
    if (typeof text !== 'string' || text === '') return null
    const afterComm = text.lastIndexOf(')')
    if (afterComm < 0) return null
    const fields = text.slice(afterComm + 1).trim().split(/\s+/)
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
    const ticks = Number(fields[19])
    return {
        cpu_seconds: (utime + stime) / clockTicks,
        starttime_ticks: Number.isFinite(ticks) ? ticks : null,
    }
}

export function parseProcStatus(text) {
    if (typeof text !== 'string' || text === '') return null
    const rss = /VmRSS:\s+(\d+)\s*kB/i.exec(text)
    const threads = /Threads:\s+(\d+)/i.exec(text)
    // "State:\tS (sleeping)" -- the letter is the state, the rest is a gloss.
    const state = /^State:\s*(\S+)/m.exec(text)
    return {
        rss_kb: rss === null ? null : Number(rss[1]),
        threads: threads === null ? null : Number(threads[1]),
        state: state === null ? null : state[1],
    }
}

// /proc is read directly instead of shelling out to ps: on a loaded box ps itself can take over
// 120 s and time out, which is exactly the box this scan exists to diagnose.
export function readProcProcess(pid, { readFile = readFileSync, clockTicks = DEFAULT_CLOCK_TICKS, procRoot = '/proc' } = {}) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return null
    let statText
    try {
        statText = readFile(`${procRoot}/${wanted}/stat`, 'utf8')
    } catch {
        return null
    }
    const stat = parseProcStat(statText, { clockTicks })
    if (stat === null) return null
    let statusText = ''
    try {
        statusText = readFile(`${procRoot}/${wanted}/status`, 'utf8')
    } catch {
        statusText = ''
    }
    const status = parseProcStatus(statusText) ?? { rss_kb: null, threads: null, state: null }
    let cmdline = null
    try {
        cmdline = readFile(`${procRoot}/${wanted}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim()
    } catch {
        cmdline = null
    }
    return {
        pid: wanted,
        rss_kb: status.rss_kb,
        cpu_seconds: stat.cpu_seconds,
        threads: status.threads,
        state: status.state,
        cmdline: cmdline === '' ? null : cmdline,
    }
}

function ledgerPids(roots) {
    const owned = new Set()
    const wanted = [...new Set([...(Array.isArray(roots) ? roots : []), null])]
    for (const root of wanted) {
        for (const row of attributeRows({ root })) {
            const pid = Number(row.pid)
            if (Number.isInteger(pid) && pid > 0) owned.add(pid)
        }
    }
    return owned
}

export function orphanFindings({
    table = [],
    roots = [],
    now = Date.now(),
    readProc = readProcProcess,
    rssMb = orphanRssMb(),
    duty = orphanDuty(),
    minAgeMs = orphanMinAgeMs(),
    maxCmdlineChars = DEFAULT_CMDLINE_CHARS,
    enabled = orphanScanEnabled(),
} = {}) {
    const thresholds = { rss_mb: rssMb, duty, min_age_ms: minAgeMs }
    if (enabled !== true || !Array.isArray(table)) return { enabled: false, thresholds, count: 0, items: [] }
    const owned = ledgerPids(roots)
    const items = []
    for (const row of table) {
        const pid = Number(row?.pid)
        if (!Number.isInteger(pid) || pid <= 2 || pid === process.pid) continue
        if (Number(row?.ppid) !== 1) continue
        if (owned.has(pid)) continue
        // A gm-mcp process is one of ours however it got reparented: the census and the reap
        // above already report it, and an orphan here means a process gm never spawned.
        const command = typeof row?.command === 'string' ? row.command : ''
        if (command !== '' && classifyGmServerCommand(command) !== null) continue
        // An unmeasured start time is not an old age: age null leaves the process unjudged.
        const ageMs = ageMsSince(row?.started_at, now)
        if (ageMs === null || ageMs <= 0 || ageMs < minAgeMs) continue
        const proc = readProc(pid)
        if (proc === null || proc === undefined) continue
        const rssKb = Number(proc.rss_kb)
        if (!Number.isFinite(rssKb) || rssKb <= 0) continue
        const measuredRssMb = rssKb / 1024
        if (measuredRssMb < rssMb) continue
        const cpuSeconds = Number(proc.cpu_seconds)
        if (!Number.isFinite(cpuSeconds) || cpuSeconds < 0) continue
        const measuredDuty = cpuSeconds / (ageMs / 1000)
        if (!(measuredDuty < duty)) continue
        items.push({
            pid,
            ppid: 1,
            rss_mb: round(measuredRssMb, 1),
            age_ms: Math.round(ageMs),
            cpu_seconds: round(cpuSeconds, 3),
            duty: round(measuredDuty, 4),
            threads: Number.isFinite(Number(proc.threads)) ? Number(proc.threads) : null,
            state: typeof proc.state === 'string' ? proc.state : null,
            cmdline: typeof proc.cmdline === 'string' && proc.cmdline !== '' ? proc.cmdline.slice(0, maxCmdlineChars) : null,
        })
    }
    items.sort((left, right) => right.rss_mb - left.rss_mb)
    return { enabled: true, thresholds, count: items.length, items }
}

export function orphanRssTotalMb(orphans) {
    const items = Array.isArray(orphans?.items) ? orphans.items : []
    return items.reduce((total, item) => total + (Number(item.rss_mb) || 0), 0)
}
