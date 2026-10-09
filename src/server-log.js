import { toolsDir } from './paths.js'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const LOG_FILE_NAME = 'gm-mcp-server.log'
const MAX_LOG_BYTES = 2 * 1024 * 1024
const REPEAT_WINDOW_MS = 60 * 1000
const MAX_REPEAT_KEYS = 512
const REPEAT_KEY_IGNORED_FIELDS = new Set(['ms', 'inflight', 'dispatches_inflight', 'pid'])
const lastWrittenByKey = new Map()

export function logFilePath() {
    const override = (process.env.GM_MCP_LOG_PATH || '').trim()
    if (override) return path.resolve(override)
    return path.join(toolsDir(), LOG_FILE_NAME)
}

// Rotation renames instead of rewriting, so a capped log costs no data writes.
// The rename replaces any earlier previous generation, so at most two files of
// about MAX_LOG_BYTES each exist.
function rotateOversizedLog(file) {
    if (statSync(file).size <= MAX_LOG_BYTES) return
    renameSync(file, `${file}.1`)
}

// A record repeats the last line written for its event and fields (ms and
// inflight vary per dispatch and are excluded from the key). Repeats inside the
// window are counted, not written; the count is reported as a repeat-suppressed
// line the next time that key is written.
function repeatKey(event, fields) {
    const kept = {}
    for (const name of Object.keys(fields).sort()) {
        if (!REPEAT_KEY_IGNORED_FIELDS.has(name)) kept[name] = fields[name]
    }
    return `${event}\u0000${JSON.stringify(kept)}`
}

function admitRecord(event, fields, now) {
    const key = repeatKey(event, fields)
    const previous = lastWrittenByKey.get(key)
    if (previous && now - previous.at < REPEAT_WINDOW_MS) {
        previous.suppressed += 1
        return { write: false }
    }
    lastWrittenByKey.set(key, { at: now, suppressed: 0 })
    if (lastWrittenByKey.size > MAX_REPEAT_KEYS) {
        for (const [staleKey, state] of lastWrittenByKey) {
            if (now - state.at >= REPEAT_WINDOW_MS) lastWrittenByKey.delete(staleKey)
        }
        if (lastWrittenByKey.size > MAX_REPEAT_KEYS) lastWrittenByKey.clear()
    }
    return { write: true, suppressed: previous?.suppressed ?? 0 }
}

// The host discards this process's stderr, so a drop leaves nothing behind
// unless the record also lands on disk.
export function appendDiagnostic(event, fields = {}) {
    const now = Date.now()
    const ts = new Date(now).toISOString()
    const record = JSON.stringify({ ts, pid: process.pid, event, ...fields })
    try {
        process.stderr.write(`gm-mcp: ${record}
`)
    } catch {
    }
    try {
        const file = logFilePath()
        const admission = admitRecord(event, fields, now)
        if (!admission.write) return record
        mkdirSync(path.dirname(file), { recursive: true })
        const summary = admission.suppressed > 0
            ? `${JSON.stringify({ ts, pid: process.pid, event: 'repeat-suppressed', of: event, count: admission.suppressed, window_ms: REPEAT_WINDOW_MS })}
`
            : ''
        appendFileSync(file, `${summary}${record}
`, 'utf8')
        rotateOversizedLog(file)
    } catch {
    }
    return record
}

export function describeError(error) {
    if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
    return String(error)
}
