import { BUNDLE_VERSION } from './bundle-version.js'
import { inflightDispatchCount } from './dispatch.js'
import { DEFAULT_HOST, DEFAULT_PORT } from './http-transport.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { launchedEntryPath, spawnServerProcess, waitForHealth } from './singleton.js'

const HANDOVER_WAIT_MS = 20_000
const HANDOVER_GRACE_MS = 500

const shortHash = (hex) => String(hex ?? '').slice(0, 12)

// The port has to be free before the replacement can bind it, so the listening
// socket is closed first and taken back only if the replacement never shows up.
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

// A long-lived server is the process that most needs a refreshed bundle and the
// one that would otherwise never see it: it was started from the old bytes and
// keeps running them. The replacement binds the port and answers health before
// this process leaves, so the port is only briefly unbound -- and it is taken
// back if the replacement never arrives.
export async function handOverToRefreshedBundle({ host = DEFAULT_HOST, port = DEFAULT_PORT, server = null, result = {} } = {}) {
    const { from, to, version, url } = result
    appendDiagnostic('bundle-refreshed', { port, url: url ?? null, from: from ?? null, to: to ?? null, version: version ?? null })
    console.error(`gm-mcp: deployed bundle was stale -- refreshed ${shortHash(from)} -> ${shortHash(to)} (${version ?? 'version unknown'}) from ${url ?? 'the release channel'}; previous kept as gm-mcp-server.mjs.prev`)

    if (inflightDispatchCount() > 0) {
        appendDiagnostic('bundle-handover-deferred', { port, dispatches_inflight: inflightDispatchCount(), from, to })
        return { outcome: 'deferred', reason: 'dispatch-in-flight' }
    }

    const entry = launchedEntryPath()
    await releasePort(server)
    const pid = spawnServerProcess({ host, port })
    const health = await waitForHealth(port, HANDOVER_WAIT_MS, process.pid)
    if (!health) {
        appendDiagnostic('bundle-handover-failed', { port, spawned_pid: pid, entry, from, to, note: 'the replacement never answered health -- this process takes the port back and keeps serving the old bundle' })
        console.error(`gm-mcp: refusing to hand over to the refreshed bundle -- no healthy replacement on port ${port}; keeping ${BUNDLE_VERSION}`)
        return { outcome: 'failed', reason: 'replacement-unhealthy', listening_again: await takePortBack(server, host, port) }
    }

    appendDiagnostic('bundle-handover', { port, from_pid: process.pid, to_pid: health.pid ?? pid, entry, from, to, version: version ?? null, replacement_version: health.version ?? null })
    console.error(`gm-mcp: port ${port} handed to pid ${health.pid ?? pid} running ${health.version ?? 'the refreshed bundle'}`)
    await new Promise((resolve) => setTimeout(resolve, HANDOVER_GRACE_MS))
    process.exit(0)
}
