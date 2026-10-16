import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { agentplugDir, spoolDirOf } from './paths.js'
import { ageMsSince } from './timestamp.js'

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
        try { rmSync(rotated, { force: true }) } catch {}
        renameSync(file, rotated)
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
    } catch {}
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
