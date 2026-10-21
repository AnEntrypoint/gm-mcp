import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { agentplugDir, leasesDir, spoolDirOf } from './paths.js'
import { ageMsSince } from './timestamp.js'
import { appendDiagnostic, describeError } from './server-log.js'

export const LEDGER_NAME = '.child-pids.jsonl'
const GLOBAL_LEDGER_NAME = 'gm-child-pids.jsonl'
const MAX_LEDGER_BYTES = 1_048_576
const READ_TAIL_BYTES = 524_288
const ROTATED_SUFFIX = '.1'

export function globalLedgerPath() {
    return path.join(agentplugDir(), GLOBAL_LEDGER_NAME)
}

export function projectLedgerPath(root) {
    return path.join(spoolDirOf(root), LEDGER_NAME)
}

export function ledgerPaths(root = null) {
    const paths = [globalLedgerPath()]
    if (root) paths.push(projectLedgerPath(root))
    return paths
}

// The project roots gm has dispatched into. dispatch.js ensureAgentLease writes one lease file per
// (project, gm-mcp pid) whose content is the project root; a lease whose directory is gone names nothing.
export function leaseRoots() {
    let names
    try {
        names = readdirSync(leasesDir())
    } catch {
        return []
    }
    const roots = new Set()
    for (const name of names) {
        if (!name.endsWith('.lease')) continue
        let root = ''
        try {
            root = readFileSync(path.join(leasesDir(), name), 'utf8').trim()
        } catch {
            continue
        }
        if (path.isAbsolute(root) && existsSync(root)) roots.add(path.resolve(root))
    }
    return [...roots]
}

function writeLine(file, entry) {
    try {
        appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
        return true
    } catch {
        return false
    }
}

function rotateIfLarge(file) {
    try {
        const size = statSync(file).size
        if (size < MAX_LEDGER_BYTES) return
        const rotated = `${file}${ROTATED_SUFFIX}`
        try { rmSync(rotated, { force: true }) } catch (error) { appendDiagnostic('ledger-rotate-remove-failed', { file: rotated, error: describeError(error) }) }
        try { renameSync(file, rotated) } catch (error) { appendDiagnostic('ledger-rotate-failed', { file, error: describeError(error) }) }
    } catch {
        return
    }
}

export function recordChild({ root = null, pid, kind = 'child', verb = null, dispatch_id = null, session_id = null, task = null, port = null, writer = 'mcp', note = null } = {}) {
    const numericPid = Number(pid)
    if (!Number.isInteger(numericPid) || numericPid <= 0) return null
    const entry = {
        ts: Date.now(),
        writer,
        pid: numericPid,
        ppid: process.pid,
        kind,
        verb,
        dispatch_id,
        session_id,
        task,
        port: port === null || port === undefined ? null : Number(port),
        root: root ? path.resolve(root) : null,
        note,
    }
    const file = root ? projectLedgerPath(root) : globalLedgerPath()
    try {
        mkdirSync(path.dirname(file), { recursive: true })
    } catch (error) {
        appendDiagnostic('ledger-mkdir-failed', { file, error: describeError(error) })
    }
    rotateIfLarge(file)
    if (writeLine(file, entry)) return entry
    return null
}

function readTailLines(file) {
    let size = 0
    try {
        size = statSync(file).size
    } catch {
        return []
    }
    const start = Math.max(0, size - READ_TAIL_BYTES)
    const length = Math.min(size, READ_TAIL_BYTES)
    if (length <= 0) return []
    let text = ''
    try {
        const fd = openSync(file, 'r')
        try {
            const buffer = Buffer.alloc(length)
            const read = readSync(fd, buffer, 0, length, start)
            text = buffer.subarray(0, read).toString('utf8')
        } finally {
            closeSync(fd)
        }
    } catch {
        return []
    }
    const lines = text.split('\n')
    if (start > 0) lines.shift()
    return lines
}

export function readLedger(root = null) {
    const rows = []
    for (const file of ledgerPaths(root)) {
        for (const line of readTailLines(file)) {
            const trimmed = line.trim()
            if (trimmed === '') continue
            let parsed
            try {
                parsed = JSON.parse(trimmed)
            } catch {
                continue
            }
            if (!parsed || typeof parsed !== 'object') continue
            if (!Number.isInteger(Number(parsed.pid))) continue
            rows.push({ ...parsed, ledger: file })
        }
    }
    rows.sort((left, right) => Number(left.ts ?? 0) - Number(right.ts ?? 0))
    return rows
}

export function attributePid(pid, { root = null } = {}) {
    const wanted = Number(pid)
    if (!Number.isInteger(wanted) || wanted <= 0) return { pid: null, attributed: false, reason: 'no-pid' }
    const rows = readLedger(root).filter((row) => Number(row.pid) === wanted)
    if (rows.length === 0) return { pid: wanted, attributed: false, reason: 'unattributed', note: 'no dispatch recorded this pid, so it is not ours to retire' }
    const latest = rows[rows.length - 1]
    return {
        pid: wanted,
        attributed: true,
        kind: latest.kind ?? null,
        verb: latest.verb ?? null,
        dispatch_id: latest.dispatch_id ?? null,
        session_id: latest.session_id ?? null,
        task: latest.task ?? null,
        port: Number.isInteger(Number(latest.port)) && Number(latest.port) > 0 ? Number(latest.port) : null,
        root: latest.root ?? null,
        recorded_ppid: Number.isInteger(Number(latest.ppid)) ? Number(latest.ppid) : null,
        recorded_at: latest.ts ?? null,
        recorded_age_ms: ageMsSince(latest.ts),
        writer: latest.writer ?? null,
        ledger: latest.ledger ?? null,
        record_count: rows.length,
    }
}

export function attributeRows({ root = null, kind = null } = {}) {
    return readLedger(root).filter((row) => (kind === null ? true : row.kind === kind))
}

export function reapOwnChildren(roots = []) {
    const reaped = []
    const seen = new Set()
    for (const root of [null, ...roots]) {
        for (const row of readLedger(root)) {
            const pid = Number(row.pid)
            if (Number(row.ppid) !== process.pid || seen.has(pid)) continue
            seen.add(pid)
            try {
                process.kill(pid, 'SIGTERM')
                reaped.push(pid)
            } catch {}
        }
    }
    return reaped
}
