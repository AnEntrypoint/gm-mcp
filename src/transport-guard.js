import process from 'node:process'
import { BUNDLE_VERSION } from './bundle-version.js'
import { inflightDispatchCount } from './dispatch.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'

const CLIENT_GONE_EXIT_RECHECK_MS = 15_000

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

function reserveStdoutForJsonRpc() {
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

export function logSignalExits() {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        process.on(signal, () => {
            appendDiagnostic('exit', { reason: 'signal', signal, dispatches_inflight: inflightDispatchCount() })
            process.exit(0)
        })
    }
}

function surviveClientGone() {
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
