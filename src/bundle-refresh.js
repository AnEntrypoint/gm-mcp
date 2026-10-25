import { inflightDispatchCount } from './dispatch.js'
import { appendDiagnostic } from './server-log.js'
import { defaultDeployedPath } from './self-update.js'
import { serveStdioRelay } from './stdio-relay.js'
import { relayStdioToBundle } from './stdio-respawn.js'

const HANDOVER_TARGET_TIMEOUT_MS = 15_000
const HANDOVER_DEFER_LIMIT_MS = 120_000
const HANDOVER_IDLE_POLL_MS = 250

const shortHash = (hex) => (typeof hex === 'string' ? hex.slice(0, 12) : null)

let stdioHandedOver = false
// The last reason a pending reload did not land. It is logged when it changes, so a 30 s retry does not repeat it.
let lastNotLanded = null

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

// A pending reload that did not land: the outcome and reason are returned to the drift watch, which retries on its next
// tick, and the reason is logged once per change of reason (bundle-reload-not-landed in the server log).
function notLanded(detail, outcome, reason, extra = {}) {
    if (lastNotLanded !== reason) {
        lastNotLanded = reason
        appendDiagnostic('bundle-reload-not-landed', { ...detail, outcome, reason, ...extra })
    }
    return { outcome, reason, ...extra }
}

// The safe boundary for a reload is an idle moment: no dispatch in flight. Waits for it up to HANDOVER_DEFER_LIMIT_MS.
async function waitForHandoverBoundary() {
    const started = Date.now()
    while (inflightDispatchCount() > 0 && Date.now() - started < HANDOVER_DEFER_LIMIT_MS) {
        await new Promise(resolve => setTimeout(resolve, HANDOVER_IDLE_POLL_MS))
    }
    return { inflight: inflightDispatchCount(), waited_ms: Date.now() - started }
}

// No HTTP singleton is running (stdio never starts one), so the stdio pipes relay to a child started from the
// installed bundle. The host keeps this process's pipes and never sees the process exit.
async function relayToInstalledBundle({ state, transport, monitor, detail }) {
    const bundlePath = defaultDeployedPath()
    const result = await relayStdioToBundle({ bundlePath, args: process.argv.slice(2), transport, dispatchesInFlight: inflightDispatchCount })
    if (result.outcome !== 'relaying') return notLanded(detail, result.outcome, result.reason)
    lastNotLanded = null
    stdioHandedOver = true
    if (monitor) clearInterval(monitor)
    appendDiagnostic('bundle-handover-stdio-relay', { ...detail, child_pid: result.child_pid, bundle: bundlePath })
    console.error(`gm-mcp: this stdio session now relays to the installed bundle (${state.installed_version ?? 'unknown version'}, child pid ${result.child_pid}); the MCP client keeps its pipe`)
    return { outcome: 'handed-over', relay_pid: result.child_pid }
}

export async function handOverStdioToRefreshedBundle({ state, transport, server, monitor = null, target, recover }) {
    if (stdioHandedOver) return { outcome: 'handed-over', already: true }
    const url = await withTimeout(target(), HANDOVER_TARGET_TIMEOUT_MS)
    const detail = { from: shortHash(state.running_sha256), to: shortHash(state.installed_sha256), to_version: state.installed_version ?? null, from_pid: process.pid, target: url ? 'http' : 'relay' }
    const boundary = await waitForHandoverBoundary()
    if (boundary.inflight > 0) return notLanded(detail, 'deferred', 'dispatch-in-flight', { dispatches_inflight: boundary.inflight, waited_ms: boundary.waited_ms })
    if (!url) return relayToInstalledBundle({ state, transport, monitor, detail })
    lastNotLanded = null
    stdioHandedOver = true
    if (monitor) clearInterval(monitor)
    appendDiagnostic('bundle-handover-stdio', { ...detail, url })
    console.error(`gm-mcp: this stdio session now relays to the installed bundle at ${url} (${state.installed_version ?? 'unknown version'}); the MCP client keeps its pipe`)
    await transport.close()
    serveStdioRelay({ url, recover, initializeParams: clientInitializeParams(server) })
    return { outcome: 'handed-over', url }
}
