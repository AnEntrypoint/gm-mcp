import { inflightDispatchCount } from './dispatch.js'
import { appendDiagnostic } from './server-log.js'
import { serveStdioRelay } from './stdio-relay.js'

const HANDOVER_TARGET_TIMEOUT_MS = 15_000
const HANDOVER_DEFER_LIMIT_MS = 120_000

const shortHash = (hex) => (typeof hex === 'string' ? hex.slice(0, 12) : null)

let stdioHandedOver = false
let stdioDeferralStartedAt = null

export function stdioSessionHandedOver() {
    return stdioHandedOver
}

function clientInitializeParams(server) {
    return {
        protocolVersion: '2025-06-18',
        capabilities: server.server.getClientCapabilities?.() ?? {},
        clientInfo: server.server.getClientVersion?.() ?? { name: 'gm-mcp-relay', version: '0' },
    }
}

function withTimeout(promise, ms) {
    let timer
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(null), ms)
        timer.unref?.()
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function handOverStdioToRefreshedBundle({ state, transport, server, monitor = null, target, recover }) {
    if (stdioHandedOver) return { outcome: 'handed-over', already: true }
    const url = await withTimeout(target(), HANDOVER_TARGET_TIMEOUT_MS)
    const detail = { from: shortHash(state.running_sha256), to: shortHash(state.installed_sha256), to_version: state.installed_version ?? null, from_pid: process.pid }
    if (!url) {
        appendDiagnostic('bundle-handover-stdio-failed', { ...detail, reason: 'no-http-singleton' })
        return { outcome: 'failed', reason: 'no-http-singleton' }
    }
    const inflight = inflightDispatchCount()
    if (inflight > 0) {
        const now = Date.now()
        stdioDeferralStartedAt ??= now
        const waited_ms = now - stdioDeferralStartedAt
        if (waited_ms < HANDOVER_DEFER_LIMIT_MS) {
            appendDiagnostic('bundle-handover-stdio-deferred', { ...detail, dispatches_inflight: inflight, waited_ms })
            return { outcome: 'deferred', reason: 'dispatch-in-flight', dispatches_inflight: inflight }
        }
        appendDiagnostic('bundle-handover-stdio-deferral-expired', { ...detail, dispatches_inflight: inflight, waited_ms })
    }
    stdioDeferralStartedAt = null
    stdioHandedOver = true
    if (monitor) clearInterval(monitor)
    appendDiagnostic('bundle-handover-stdio', { ...detail, url })
    console.error(`gm-mcp: this stdio session now relays to the installed bundle at ${url} (${state.installed_version ?? 'unknown version'}); the MCP client keeps its pipe`)
    await transport.close()
    serveStdioRelay({ url, recover, initializeParams: clientInitializeParams(server) })
    return { outcome: 'handed-over', url }
}
