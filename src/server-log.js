import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const LOG_FILE_NAME = 'gm-mcp-server.log'
const MAX_LOG_BYTES = 4 * 1024 * 1024
const KEEP_TAIL_BYTES = 512 * 1024

export function logFilePath() {
    const override = (process.env.GM_MCP_LOG_PATH || '').trim()
    if (override) return path.resolve(override)
    const dir = (process.env.GM_TOOLS_DIR || '').trim() || path.join(homedir(), '.gm-tools')
    return path.join(dir, LOG_FILE_NAME)
}

// The host discards this process's stderr, so a drop leaves nothing behind
// unless the record also lands on disk.
function trimOversizedLog(file) {
    if (statSync(file).size <= MAX_LOG_BYTES) return
    const bytes = readFileSync(file)
    const tail = bytes.subarray(Math.max(0, bytes.length - KEEP_TAIL_BYTES))
    const firstNewline = tail.indexOf(0x0a)
    writeFileSync(file, firstNewline === -1 ? tail : tail.subarray(firstNewline + 1))
}

// A stdio server's stderr is the only channel the host keeps, so diagnostics go
// there by default. A CLI subcommand owns its stderr instead, and every record
// below still lands on disk, so it can turn the echo off and keep its output clean.
let echoDiagnosticsToStderr = (process.env.GM_MCP_LOG_STDERR || '').trim() !== '0'

export function setDiagnosticStderrEcho(enabled) {
    echoDiagnosticsToStderr = Boolean(enabled)
}

export function appendDiagnostic(event, fields = {}) {
    const record = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...fields })
    if (echoDiagnosticsToStderr) {
        try {
            process.stderr.write(`gm-mcp: ${record}\n`)
        } catch {
        }
    }
    try {
        const file = logFilePath()
        mkdirSync(path.dirname(file), { recursive: true })
        appendFileSync(file, `${record}\n`, 'utf8')
        trimOversizedLog(file)
    } catch {
    }
    return record
}

export function describeError(error) {
    if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
    return String(error)
}
