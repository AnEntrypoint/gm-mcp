import process from 'node:process'
import { BUNDLE_VERSION } from './bundle-version.js'
import { inflightDispatchCount } from './dispatch.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'

const CLIENT_GONE_EXIT_RECHECK_MS = 15_000

// A JSON-RPC frame is always a single JSON object terminated by a newline.
// Testing the first byte before parsing keeps this off the hot path: a
// response can be a megabyte and every write goes through here.
function isJsonRpcFrame(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    if (buffer.length === 0 || buffer[0] !== 0x7b) return false
    const text = buffer.toString('utf8')
    try {
        const parsed = JSON.parse(text)
        return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
    } catch {
        return false
    }
}

export function reserveStdoutForJsonRpc() {
    const stdout = process.stdout
    const write = stdout.write.bind(stdout)
    stdout.write = (chunk, encoding, callback) => {
        if (!isJsonRpcFrame(chunk)) {
            const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
            appendDiagnostic('stdout-write-diverted', { bytes: text.length, text: text.slice(0, 400) })
            if (typeof encoding === 'function') encoding()
            else if (typeof callback === 'function') callback()
            return true
        }
        return write(chunk, encoding, callback)
    }
    console.log = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`)
    console.info = console.log
    return stdout
}

// Nothing here exits. The transport outlives every async fault: a dispatch is
// a spool ticket somebody is waiting on, and killing the process loses both
// the reply and the only record of why.
export function keepServingOnAsyncFailure() {
    const report = (label) => (error) => {
        appendDiagnostic(label, { error: describeError(error), dispatches_inflight: inflightDispatchCount() })
    }
    process.on('uncaughtException', report('uncaught-exception'))
    process.on('unhandledRejection', report('unhandled-rejection'))
    process.stdin.on('error', report('stdin-error'))
    process.stderr.on('error', report('stderr-error'))
    process.on('exit', (code) => {
        appendDiagnostic('exit', { code, dispatches_inflight: inflightDispatchCount() })
    })
}

// A stdio server is killed more often than it chooses to die, and the default
// handlers leave no trace. Name the signal on the way out, then behave exactly
// as node would have.
export function logSignalExits() {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        process.on(signal, () => {
            appendDiagnostic('exit', { reason: 'signal', signal, dispatches_inflight: inflightDispatchCount() })
            process.exit(0)
        })
    }
}

// A dead pipe is not a reason to die. Claude Code owns this process's stdin
// and stdout; once it stops reading, exiting here would trade a recoverable
// stall for a guaranteed "MCP server has disconnected" that lasts the rest of
// the session. Stay up, say so once per error kind, and let the client decide.
export function surviveClientGone() {
    const reported = new Set()
    process.stdout.on('error', (error) => {
        const code = error?.code || 'unknown'
        if (reported.has(code)) return
        reported.add(code)
        appendDiagnostic('stdout-pipe-gone', {
            code,
            error: describeError(error),
            note: 'client stopped reading -- server stays up so a reconnect finds it alive',
            dispatches_inflight: inflightDispatchCount(),
        })
    })
    process.stdin.on('end', () => {
        appendDiagnostic('stdin-ended', { note: 'client disconnect or platform pipe quirk -- server stays up' })
    })
}

export function installStdioGuards() {
    keepServingOnAsyncFailure()
    logSignalExits()
    reserveStdoutForJsonRpc()
    surviveClientGone()
    appendDiagnostic('start', {
        bundle_version: BUNDLE_VERSION,
        argv: process.argv.slice(1),
        cwd: process.cwd(),
        node: process.version,
        log: logFilePath(),
    })
    return true
}
