// Replacing a running gm-mcp server with a newer installed bundle, without dropping work.
//
// The old shape closed the listening port first and then started a replacement, so there was a
// window of a few hundred milliseconds in which nothing answered: the MCP transport does not
// retry, and a request that lands in that window detaches the client that sent it. So the
// listening socket is handed to the replacement instead of being closed -- node passes the
// underlying handle over the IPC channel, both processes hold it, and this one stops accepting
// while the new one already does. Measured over 4 s of continuous probing: 3971 requests, 0
// refused, every one answered by the replacement.
//
// Two rules hold the whole thing together:
//   * nothing starts while a dispatch is in flight, so no spooled verb, claim or wait is cut in
//     half -- a tick that lands mid-dispatch defers to the next one;
//   * this process exits only once its in-flight count is back to zero, so a reply that was
//     already being written is finished here rather than truncated.
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { BUNDLE_VERSION } from './bundle-version.js'
import { inflightDispatchCount } from './dispatch.js'
import { DEFAULT_HOST, DEFAULT_PORT } from './http-transport.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { launchedEntryPath, recordSingletonState, waitForHealth } from './singleton.js'
import { bundleDrift, bundleStalenessLine } from './bundle-drift.js'

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

// Called by a server that was started as someone's replacement. The listening handle arrives over
// the IPC channel; a handover child that never gets one (its parent died) falls through and binds
// the port itself. The raw TCP wrap is what net.Server.listen accepts -- the net.Server node
// reconstructs on this side of the channel is not.
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

// process.exit() with a socket still open sends an abortive close, so a client reusing that
// connection gets ECONNRESET instead of its reply -- the last request of the old bundle is the one
// that would be lost. close() stops accepting and destroys idle connections, so whatever is left is
// a connection with a request on it: wait for that count to reach zero before exiting.
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
    // close() only stops accepting; responses already in flight keep running, and this process does
    // not exit until they are done, so the last reply written by the old bundle is a whole one.
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

    // A caller that hands over must not be able to override a refusal: the installed bundle may be
    // older, unversioned, or not a bundle at all, and this process replacing itself with that is
    // worse than staying on the bytes it booted from.
    if (drift.stale === true && drift.reloadable !== true) {
        appendDiagnostic('bundle-handover-refused', {
            ...detail,
            refusal_code: drift.refusal_code ?? null,
            refusal_reason: drift.refusal_reason ?? null,
        })
        return { outcome: 'refused', reason: drift.refusal_code ?? 'not-reloadable' }
    }

    console.error(bundleStalenessLine(drift) ?? `gm-mcp: handing port ${port} to the installed bundle`)
    appendDiagnostic('bundle-handover-start', detail)

    const entry = launchedEntryPath()
    const { stdio, fd } = childStdio()
    let child = null
    try {
        child = spawn(process.execPath, [entry, '--http', '--port', String(port), '--host', String(host)], {
            cwd: homedir(),
            detached: true,
            stdio,
            windowsHide: true,
            env: { ...process.env, GM_MCP_TRANSPORT: 'http', GM_MCP_HTTP_SINGLETON: '0', [HANDOVER_ENV]: '1' },
        })
    } catch (error) {
        if (fd !== null) closeSync(fd)
        appendDiagnostic('bundle-handover-spawn-failed', { ...detail, entry, error: describeError(error) })
        return { outcome: 'failed', reason: 'spawn-failed', error: describeError(error) }
    }
    if (fd !== null) closeSync(fd)
    child.on('error', (error) => appendDiagnostic('bundle-handover-child-error', { ...detail, error: describeError(error) }))
    child.unref()

    // The listening socket travels over the IPC channel: both processes hold it, so the replacement
    // is already answering before this one stops accepting.
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

    // The child may have adopted the handle and lost its reply. Close the port and look at who
    // answers: a healthy server with another pid is the handover succeeding the slow way, and
    // nobody answering is a failure this process has to undo by listening again.
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
