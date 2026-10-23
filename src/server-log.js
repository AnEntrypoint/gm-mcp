import { agentplugDir, spoolDirOf, toolsDir } from './paths.js'
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const LOG_FILE_NAME = 'gm-mcp-server.log'
const MAX_LOG_BYTES = 2 * 1024 * 1024
const REPEAT_WINDOW_MS = 60 * 1000
const MAX_REPEAT_KEYS = 512
const REPEAT_KEY_IGNORED_FIELDS = new Set(['ms', 'inflight', 'dispatches_inflight', 'pid', 'dispatch_id', 'call_id'])
const lastWrittenByKey = new Map()

export function logFilePath() {
    const override = (process.env.GM_MCP_LOG_PATH || '').trim()
    if (override) return path.resolve(override)
    return path.join(toolsDir(), LOG_FILE_NAME)
}

function fileFacts(file) {
    try {
        const stat = statSync(file)
        return { path: file, bytes: stat.size, mtime: stat.mtime.toISOString() }
    } catch {
        return { path: file, bytes: null, mtime: null }
    }
}

function dirFacts(dir) {
    try {
        let bytes = 0
        let files = 0
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile()) continue
            bytes += statSync(path.join(dir, entry.name)).size
            files += 1
        }
        return { path: dir, files, bytes, mtime: statSync(dir).mtime.toISOString() }
    } catch {
        return { path: dir, files: null, bytes: null, mtime: null }
    }
}

export function logLocations(projectRoot = null) {
    const root = projectRoot || process.cwd()
    return {
        gm_mcp_server_log: fileFacts(logFilePath()),
        gm_mcp_server_log_rotated: fileFacts(`${logFilePath()}.1`),
        runner_daemon_log: fileFacts(path.join(agentplugDir(), 'daemon.log')),
        exec_spool_out: { ...dirFacts(path.join(spoolDirOf(root), 'out')), root, root_source: projectRoot ? 'explicit' : 'process_cwd' },
    }
}

function rotateOversizedLog(file) {
    if (statSync(file).size <= MAX_LOG_BYTES) return
    renameSync(file, `${file}.1`)
}

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
        installExitFlush()
        if (fields.dispatch_id !== undefined) previous.dispatch_id = fields.dispatch_id
        return { write: false }
    }
    lastWrittenByKey.set(key, { at: now, suppressed: 0, event })
    if (lastWrittenByKey.size > MAX_REPEAT_KEYS) {
        for (const [staleKey, state] of lastWrittenByKey) {
            if (now - state.at >= REPEAT_WINDOW_MS) lastWrittenByKey.delete(staleKey)
        }
        if (lastWrittenByKey.size > MAX_REPEAT_KEYS) lastWrittenByKey.clear()
    }
    return { write: true, suppressed: previous?.suppressed ?? 0, dispatch_id: previous?.dispatch_id }
}

let exitFlushInstalled = false

function installExitFlush() {
    if (exitFlushInstalled) return
    exitFlushInstalled = true
    process.on('exit', flushSuppressedCounts)
}

function flushSuppressedCounts() {
    for (const state of lastWrittenByKey.values()) {
        if (!state.suppressed) continue
        try {
            const dispatch = state.dispatch_id !== undefined ? { dispatch_id: state.dispatch_id } : {}
            appendFileSync(logFilePath(), `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event: 'repeat-suppressed', of: state.event, count: state.suppressed, window_ms: REPEAT_WINDOW_MS, flushed: 'exit', ...dispatch })}\n`, 'utf8')
        } catch {
        }
        state.suppressed = 0
    }
}

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
        if (!admission.write) {
            if (fields.dispatch_id !== undefined) {
                appendFileSync(file, `${JSON.stringify({ ts, pid: process.pid, event: 'repeat-suppressed-id', of: event, dispatch_id: fields.dispatch_id })}\n`, 'utf8')
            }
            return record
        }
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        const summary = admission.suppressed > 0
            ? `${JSON.stringify({ ts, pid: process.pid, event: 'repeat-suppressed', of: event, count: admission.suppressed, window_ms: REPEAT_WINDOW_MS, ...(admission.dispatch_id !== undefined ? { dispatch_id: admission.dispatch_id } : {}) })}
`
            : ''
        appendFileSync(file, `${summary}${record}
`, 'utf8')
        rotateOversizedLog(file)
    } catch (error) {
        try {
            process.stderr.write(`gm-mcp: ${JSON.stringify({ ts, pid: process.pid, event: 'log-write-failed', of: event, code: error?.code ?? null, message: String(error?.message ?? error) })}
`)
        } catch {
        }
    }
    return record
}

const DESCRIBE_ERROR_MAX_CHARS = 8000
const DATA_URL_PAYLOAD = /data:[^,\s'"`)]*;base64,[A-Za-z0-9+/=]+/g

export function describeError(error) {
    const text = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : String(error)
    // The bundle runs as a data: module, so each stack frame embeds the whole bundle as base64: one throw makes a stack of megabytes, and the reply path that scans it then overflows.
    const collapsed = text.includes(';base64,')
        ? text.replace(DATA_URL_PAYLOAD, (match) => `${match.slice(0, match.indexOf(',') + 1)}<${match.length} chars omitted>`)
        : text
    if (collapsed.length <= DESCRIBE_ERROR_MAX_CHARS) return collapsed
    return `${collapsed.slice(0, DESCRIBE_ERROR_MAX_CHARS)}\n... ${collapsed.length - DESCRIBE_ERROR_MAX_CHARS} more char(s) omitted`
}
