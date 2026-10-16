import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { BUNDLE_VERSION } from './bundle-version.js'
import { inflightDispatchCount } from './dispatch.js'
import { DEFAULT_HOST, DEFAULT_PORT } from './http-transport.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { launchedEntryPath, recordSingletonState, waitForHealth } from './singleton.js'
import { bundleDrift, bundleStalenessNotice } from './bundle-drift.js'
import { hiddenDetachedOptions } from './hidden-spawn.js'
import { exitWhenIdle } from './transport-guard.js'

const HANDOVER_READY_TIMEOUT_MS = 30_000
export const HANDOVER_LISTEN_RETRY_MS = 60_000
const HANDOVER_FALLBACK_PROBE_MS = 10_000
const HANDOVER_DRAIN_TIMEOUT_MS = 60_000
const HANDOVER_DRAIN_POLL_MS = 50

export const HANDOVER_ENV = 'GM_MCP_HANDOVER'
const HANDOVER_READY = 'gm-mcp-handover-ready'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shortHash = (hex) => (typeof hex === 'string' ? hex.slice(0, 12) : null)

export function handoverRequested() {
    return (process.env[HANDOVER_ENV] || '').trim() === '1'
}

const STDIO_READY_LINE = 'connected, serving on stdio'
const STDIO_READY_TIMEOUT_MS = 30_000

let stdioRelay = null

function stdioRelayPid() {
    return stdioRelay && stdioRelay.exitCode === null ? (stdioRelay.pid ?? null) : null
}

function detachStdio(transport) {
    const stdin = process.stdin
    const removed = []
    const bound = [transport?._ondata, transport?._onerror].filter((handler) => typeof handler === 'function')
    for (const handler of bound) {
        for (const event of ['data', 'error']) {
            stdin.off(event, handler)
            removed.push([event, handler])
        }
    }
    if (bound.length === 0 && transport) {
        try {
            Promise.resolve(transport.close?.()).catch(() => {})
        } catch {
        }
    }
    const ok = stdin.listenerCount('data') === 0
    if (ok) stdin.pause()
    return {
        ok,
        restore: () => {
            for (const [event, handler] of removed) stdin.on(event, handler)
        },
    }
}

function waitForStdioReady(child, { timeoutMs = STDIO_READY_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        let settled = false
        const finish = (value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
        }
        const timer = setTimeout(() => finish(false), timeoutMs)
        timer.unref?.()
        child.once('exit', (code, signal) => {
            appendDiagnostic('bundle-stdio-handover-child-exited-early', { spawned_pid: child.pid ?? null, code, signal })
            finish(false)
        })
        if (!child.stderr) {
            finish(false)
            return
        }
        child.stderr.on('data', (chunk) => {
            if (String(chunk).includes(STDIO_READY_LINE)) finish(true)
        })
    })
}

export async function handOverStdioToRefreshedBundle({ transport = null, state = null, result = {} } = {}) {
    if (stdioRelayPid() !== null) return { outcome: 'already-handed-over', pid: stdioRelayPid(), relaying: true }

    const drift = state ?? bundleDrift({ transport: 'stdio' })
    const detail = {
        reason: result.reason ?? 'installed-bundle-changed',
        from: drift.running_sha256 ?? result.from ?? null,
        to: drift.installed_sha256 ?? result.to ?? null,
        version: `${drift.running_version}${drift.installed_version ? ` -> ${drift.installed_version}` : ''}`,
        from_pid: process.pid,
    }

    if (inflightDispatchCount() > 0) {
        appendDiagnostic('bundle-stdio-handover-deferred', { ...detail, dispatches_inflight: inflightDispatchCount() })
        return { outcome: 'deferred', reason: 'dispatch-in-flight', dispatches_inflight: inflightDispatchCount() }
    }

    if (drift.stale === true && drift.reloadable !== true) {
        appendDiagnostic('bundle-stdio-handover-refused', {
            ...detail,
            refusal_code: drift.refusal_code ?? null,
            refusal_reason: drift.refusal_reason ?? null,
        })
        return { outcome: 'refused', reason: drift.refusal_code ?? 'not-reloadable' }
    }

    console.error(bundleStalenessNotice(drift) ?? 'gm-mcp: handing stdio to the installed bundle')
    appendDiagnostic('bundle-stdio-handover-start', detail)

    const entry = launchedEntryPath()
    let child = null
    try {
        child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
            cwd: process.cwd(),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, GM_MCP_TRANSPORT: 'stdio', GM_MCP_NO_HTTP_SINGLETON: '1' },
        })
    } catch (error) {
        appendDiagnostic('bundle-stdio-handover-spawn-failed', { ...detail, entry, error: describeError(error) })
        return { outcome: 'failed', reason: 'spawn-failed', error: describeError(error) }
    }
    if (!child.stdin || !child.stdout) {
        appendDiagnostic('bundle-stdio-handover-spawn-failed', { ...detail, entry, spawned_pid: child.pid ?? null, error: 'no-stdio-pipes' })
        try { child.kill() } catch { }
        return { outcome: 'failed', reason: 'spawn-failed', error: 'no-stdio-pipes' }
    }
    child.on('error', (error) => appendDiagnostic('bundle-stdio-handover-child-error', { ...detail, error: describeError(error) }))
    if (child.stderr) {
        child.stderr.on('error', () => { })
        child.stderr.on('data', (chunk) => {
            try { process.stderr.write(chunk) } catch { }
        })
    }

    const ready = await waitForStdioReady(child)
    if (!ready) {
        appendDiagnostic('bundle-stdio-handover-not-ready', { ...detail, spawned_pid: child.pid ?? null, entry })
        try { child.kill() } catch { }
        return { outcome: 'failed', reason: 'replacement-not-ready' }
    }

    if (inflightDispatchCount() > 0) {
        appendDiagnostic('bundle-stdio-handover-deferred', { ...detail, spawned_pid: child.pid ?? null, dispatches_inflight: inflightDispatchCount() })
        try { child.kill() } catch { }
        return { outcome: 'deferred', reason: 'dispatch-in-flight', dispatches_inflight: inflightDispatchCount() }
    }

    const detached = detachStdio(transport)
    if (!detached.ok) {
        detached.restore()
        appendDiagnostic('bundle-stdio-handover-detach-failed', { ...detail, spawned_pid: child.pid ?? null })
        try { child.kill() } catch { }
        return { outcome: 'failed', reason: 'stdio-detach-failed' }
    }

    child.stdin.on('error', (error) => appendDiagnostic('bundle-stdio-handover-relay-stdin-error', { ...detail, error: describeError(error) }))
    process.stdin.pipe(child.stdin)
    child.stdout.pipe(process.stdout)
    stdioRelay = child
    child.on('exit', (code, signal) => {
        appendDiagnostic('bundle-stdio-handover-child-exit', { ...detail, to_pid: child.pid ?? null, code, signal })
        try { process.stdin.unpipe(child.stdin) } catch { }
        if (stdioRelay === child) stdioRelay = null
        exitWhenIdle('relay-child-exited')
    })
    appendDiagnostic('bundle-stdio-handover', { ...detail, to_pid: child.pid ?? null, entry, relaying: true })
    console.error(`gm-mcp: stdio handed to pid ${child.pid} running ${drift.installed_version ?? 'the installed bundle'} -- this process stays up and relays`)
    return { outcome: 'handed-over', pid: child.pid ?? null, relaying: true }
}

function childStdio() {
    try {
        const file = logFilePath()
        mkdirSync(path.dirname(file), { recursive: true })
        const fd = openSync(file, 'a')
        return { stdio: ['ignore', fd, fd, 'ipc'], fd }
    } catch {
        return { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], fd: null }
    }
}

export function adoptHandedOverHandle({ timeoutMs = HANDOVER_READY_TIMEOUT_MS } = {}) {
    if (!handoverRequested()) return Promise.resolve(null)
    return new Promise((resolve) => {
        const done = (value) => {
            clearTimeout(timer)
            process.off('message', onMessage)
            resolve(value)
        }
        const onMessage = (message, handle) => {
            if (!message || message.type !== 'gm-mcp-handover') return
            const raw = handle && (handle._handle || handle.handle || handle)
            appendDiagnostic('bundle-handover-adopted', { handle: Boolean(raw), from_pid: message.pid ?? null })
            done(raw ?? null)
        }
        const timer = setTimeout(() => {
            appendDiagnostic('bundle-handover-adopt-timeout', { timeout_ms: timeoutMs })
            done(null)
        }, timeoutMs)
        timer.unref?.()
        process.on('message', onMessage)
    })
}

async function releasePort(server) {
    if (!server) return
    try {
        server.closeAllConnections?.()
    } catch {
    }
    await new Promise((resolve) => {
        try {
            server.close(() => resolve())
        } catch {
            resolve()
        }
    })
}

async function takePortBack(server, host, port) {
    if (!server) return false
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, host, () => {
                server.removeListener('error', reject)
                resolve()
            })
        })
        return true
    } catch (error) {
        appendDiagnostic('bundle-handover-relisten-failed', { port, error: describeError(error) })
        return false
    }
}

function openConnectionCount(server) {
    if (!server || typeof server.getConnections !== 'function') return Promise.resolve(0)
    return new Promise((resolve) => {
        try {
            server.getConnections((error, count) => resolve(error ? 0 : (count ?? 0)))
        } catch {
            resolve(0)
        }
    })
}

async function drainAndExit(server) {
    if (server) {
        await new Promise((resolve) => {
            try {
                server.close(() => resolve())
            } catch {
                resolve()
            }
        })
    }
    const deadline = Date.now() + HANDOVER_DRAIN_TIMEOUT_MS
    let open = 0
    while (Date.now() < deadline) {
        if (inflightDispatchCount() === 0) {
            open = await openConnectionCount(server)
            if (open <= 0) break
        }
        await sleep(HANDOVER_DRAIN_POLL_MS)
    }
    appendDiagnostic('bundle-handover-exit', { pid: process.pid, dispatches_inflight: inflightDispatchCount(), connections_open: open })
    process.exit(0)
}

export async function handOverToRefreshedBundle({ host = DEFAULT_HOST, port = DEFAULT_PORT, server = null, result = {}, state = null } = {}) {
    const drift = state ?? bundleDrift({ transport: 'http' })
    const detail = {
        port,
        reason: result.reason ?? 'installed-bundle-changed',
        from: drift.running_sha256 ?? result.from ?? null,
        to: drift.installed_sha256 ?? result.to ?? null,
        version: `${drift.running_version}${drift.installed_version ? ` -> ${drift.installed_version}` : ''}`,
        from_pid: process.pid,
    }

    if (inflightDispatchCount() > 0) {
        appendDiagnostic('bundle-handover-deferred', { ...detail, dispatches_inflight: inflightDispatchCount() })
        return { outcome: 'deferred', reason: 'dispatch-in-flight', dispatches_inflight: inflightDispatchCount() }
    }

    if (drift.stale === true && drift.reloadable !== true) {
        appendDiagnostic('bundle-handover-refused', {
            ...detail,
            refusal_code: drift.refusal_code ?? null,
            refusal_reason: drift.refusal_reason ?? null,
        })
        return { outcome: 'refused', reason: drift.refusal_code ?? 'not-reloadable' }
    }

    console.error(bundleStalenessNotice(drift) ?? `gm-mcp: handing port ${port} to the installed bundle`)
    appendDiagnostic('bundle-handover-start', detail)

    const entry = launchedEntryPath()
    const { stdio, fd } = childStdio()
    let child = null
    try {
        child = spawn(process.execPath, [entry, '--http', '--port', String(port), '--host', String(host)], {
            ...hiddenDetachedOptions({ stdio }),
            cwd: homedir(),
            env: { ...process.env, GM_MCP_TRANSPORT: 'http', GM_MCP_NO_HTTP_SINGLETON: '1', [HANDOVER_ENV]: '1' },
        })
    } catch (error) {
        if (fd !== null) closeSync(fd)
        appendDiagnostic('bundle-handover-spawn-failed', { ...detail, entry, error: describeError(error) })
        return { outcome: 'failed', reason: 'spawn-failed', error: describeError(error) }
    }
    if (fd !== null) closeSync(fd)
    child.on('error', (error) => appendDiagnostic('bundle-handover-child-error', { ...detail, error: describeError(error) }))
    child.unref()

    let handleSent = false
    try {
        handleSent = child.send({ type: 'gm-mcp-handover', port, host, pid: process.pid }, server)
    } catch (error) {
        appendDiagnostic('bundle-handover-send-failed', { ...detail, error: describeError(error) })
    }
    appendDiagnostic('bundle-handover-sent', { ...detail, handle_sent: handleSent })

    const ready = handleSent
        ? await new Promise((resolve) => {
            const finish = (value) => {
                clearTimeout(timer)
                child.off('message', onMessage)
                resolve(value)
            }
            const onMessage = (message) => {
                if (message && message.type === HANDOVER_READY && message.pid) finish({ pid: message.pid })
            }
            const timer = setTimeout(() => finish(null), HANDOVER_READY_TIMEOUT_MS)
            timer.unref?.()
            child.on('message', onMessage)
        })
        : null

    if (ready) {
        appendDiagnostic('bundle-handover', { ...detail, to_pid: ready.pid, entry, zero_gap: true })
        console.error(`gm-mcp: port ${port} handed to pid ${ready.pid} with no listening gap -- this process drains and exits`)
        try {
            recordSingletonState({ port, pid: ready.pid })
        } catch {
        }
        await drainAndExit(server)
        return { outcome: 'handed-over', pid: ready.pid, zero_gap: true }
    }

    appendDiagnostic('bundle-handover-no-ready', { ...detail, spawned_pid: child.pid ?? null, entry })
    await releasePort(server)
    const health = await waitForHealth(port, HANDOVER_FALLBACK_PROBE_MS, process.pid)
    if (health) {
        appendDiagnostic('bundle-handover', { ...detail, to_pid: health.pid ?? null, entry, zero_gap: false })
        try {
            recordSingletonState({ port, pid: health.pid ?? null })
        } catch {
        }
        process.exit(0)
    }
    const listening = await takePortBack(server, host, port)
    appendDiagnostic('bundle-handover-failed', { ...detail, spawned_pid: child.pid ?? null, entry, listening_again: listening })
    console.error(`gm-mcp: refusing to hand over -- no replacement answered on port ${port}; keeping ${BUNDLE_VERSION} (${shortHash(drift.running_sha256)})`)
    return { outcome: 'failed', reason: 'replacement-unhealthy', listening_again: listening }
}
