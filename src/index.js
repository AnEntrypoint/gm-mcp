import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions, setHealthExtras } from './http-transport.js'
import { defaultHttpPort, httpMcpUrl, probeHealth } from './singleton.js'
import { startContinuationMonitor } from './continuation.js'
import { handOverStdioToRefreshedBundle, stdioSessionHandedOver } from './bundle-refresh.js'
import { bundleHealthBlock, bundleStalenessAnnouncement, recordDriftPair, recordHandoverRefusal, runningBundle, startBundleDriftWatch } from './bundle-drift.js'
import { recordRunningImage } from './running-images.js'
import { scheduleStaleDeployedBundleChecks } from './self-update.js'
import { runLeakWatchPass } from './leak-watch.js'
import { runReleaseBridgeInBackground } from './release-bridge.js'
import { installSkillsInBackground } from './skill-install.js'
import { housekeepInBackground } from './triage-verbs.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { installSpoolPort } from './spool-port.js'
import { flagValue } from './argv.js'
import { setServingTransport } from './bundle-drift.js'
import { nodeSpoolPort } from './spool-port-node.js'
import { gmDispatch, lastProjectRoot, preloadVerbTable } from './dispatch.js'
import { takeFastTransport } from './fast-stdio.js'
import { nextPrdFor, setPrdPushSink } from './prd-feed.js'

installSpoolPort(nodeSpoolPort)

export { createServer } from './mcp-server.js'

// Explicit only: HTTP runs when a human types --http on the command line. No environment variable enables it.
export function wantsHttpTransport() {
    return process.argv.slice(2).includes('--http')
}

// The stdio session relays to an HTTP server only when one was started by hand with --http. This probes
// for it and never starts one, so stdio opens no listening port.
async function liveHttpTarget() {
    const port = defaultHttpPort()
    const live = await probeHealth(port)
    if (live) {
        appendDiagnostic('stdio-handover-reused-live-http', { port, pid: live.pid ?? null })
        return httpMcpUrl(port)
    }
    appendDiagnostic('stdio-handover-no-http-server', { port })
    return null
}

function watchForStaleBundle({ handOver = null, transportKind = 'stdio', settled = () => false } = {}) {
    return startBundleDriftWatch(async (state) => {
        if (settled()) {
            recordDriftPair(state, transportKind, 'settled')
            appendDiagnostic('bundle-drift-settled', { transport: transportKind, from: state?.running_sha256 ?? null, to: state?.installed_sha256 ?? null, pid: process.pid, already: true })
            return null
        }
        const retriable = state?.refusal_code == null || state.refusal_code === 'no-handover' || String(state.refusal_code).startsWith('handover-')
        const handable = handOver !== null && state?.stale === true && retriable
        if (handable) {
            // Announce only after the handover outcome is known: a failed or deferred handover did not reload.
            const outcome = await handOver({ ...state, reloadable: true, refusal_code: null, refusal_reason: null })
            if (outcome?.outcome === 'handed-over') {
                recordDriftPair(state, transportKind, 'settled')
                appendDiagnostic('bundle-drift-settled', { transport: transportKind, from: state.running_sha256 ?? null, to: state.installed_sha256 ?? null, pid: process.pid })
                return outcome
            }
            if (outcome?.outcome !== 'failed' && outcome?.outcome !== 'deferred') return outcome
            recordHandoverRefusal(state.installed_sha256, outcome.outcome, outcome.reason ?? outcome.outcome)
            if (outcome.outcome === 'failed') recordDriftPair(state, transportKind, 'reconnect-needed')
            const unhanded = { ...state, reloadable: false, refusal_code: 'handover-' + outcome.outcome, refusal_reason: outcome.reason ?? outcome.outcome }
            const line = bundleStalenessAnnouncement(unhanded)
            if (line) console.error(line)
            if (line) appendDiagnostic('bundle-stale-no-handover', { ...unhanded, transport: transportKind })
            return outcome
        }
        recordDriftPair(state, transportKind, 'reconnect-needed')
        const honest = handOver ? state : { ...state, reloadable: false, refusal_code: 'no-handover', refusal_reason: 'a ' + transportKind + ' server cannot replace itself without dropping its client, so a relaunch serves the installed bundle' }
        const line = bundleStalenessAnnouncement(honest)
        if (line) console.error(line)
        if (line) appendDiagnostic('bundle-stale-no-handover', { ...honest, transport: transportKind })
        return null
    }, { transport: transportKind })
}

export async function main() {
    await preloadVerbTable()
    housekeepInBackground(lastProjectRoot())
    if (wantsHttpTransport()) {
        setServingTransport('http')
        const { host, port } = httpListenOptions()
        setHealthExtras(() => bundleHealthBlock())
        const { server } = await startHttpServer({ host, port })
        recordRunningImage('http', runningBundle())
        watchForStaleBundle({ transportKind: 'http' })
        scheduleStaleDeployedBundleChecks(null, runLeakWatchPass)
        runReleaseBridgeInBackground()
        installSkillsInBackground()
        return
    }

    setServingTransport('stdio')
    installStdioGuards()
    appendDiagnostic('stdio-standalone-start', { pid: process.pid })
    const server = createServer()
    const transport = takeFastTransport() ?? new StdioServerTransport()

    const keepAlive = setInterval(() => {}, 1 << 30)

    await server.connect(transport)
    console.error('gm-mcp: connected, serving on stdio')
    // stdio only: HTTP has no open channel to push on, so it never installs this sink.
    setPrdPushSink((uri) => server.server.sendResourceUpdated({ uri }).catch((error) => appendDiagnostic('prd-push-failed', { uri, error: describeError(error) })))
    const monitor = startContinuationMonitor((params) => server.server.sendLoggingMessage(params).catch((error) => appendDiagnostic('continuation-notify-failed', { error: describeError(error) })), () => nextPrdFor(gmDispatch))
    recordRunningImage('stdio', runningBundle())
    watchForStaleBundle({ transportKind: 'stdio', settled: stdioSessionHandedOver, handOver: (state) => handOverStdioToRefreshedBundle({ state, transport, server, monitor, target: liveHttpTarget, recover: liveHttpTarget }) })
    scheduleStaleDeployedBundleChecks(null, runLeakWatchPass)
    runReleaseBridgeInBackground()
    installSkillsInBackground()
}

export { flagValue }
