import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions, setHealthExtras } from './http-transport.js'
import { startContinuationMonitor } from './continuation.js'
import { bundleHealthBlock, bundleStalenessAnnouncement, recordDriftPair, runningBundle, startBundleDriftWatch } from './bundle-drift.js'
import { recordRunningImage } from './running-images.js'
import { scheduleStaleDeployedBundleChecks } from './self-update.js'
import { runLeakWatchPass } from './leak-watch.js'
import { runReleaseBridgeInBackground } from './release-bridge.js'
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

// A stale server announces the newer installed bundle once and keeps serving the bundle it launched with. Nothing
// hands over to the newer bundle: it takes effect when the next session starts.
function watchForStaleBundle({ transportKind = 'stdio' } = {}) {
    return startBundleDriftWatch(async (state) => {
        recordDriftPair(state, transportKind, 'reconnect-needed')
        const line = bundleStalenessAnnouncement(state)
        if (line) {
            console.error(line)
            appendDiagnostic('bundle-stale-no-handover', { ...state, transport: transportKind })
        }
        return null
    }, { transport: transportKind, consolidateRoot: () => lastProjectRoot() })
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
    startContinuationMonitor((params) => server.server.sendLoggingMessage(params).catch((error) => appendDiagnostic('continuation-notify-failed', { error: describeError(error) })), () => nextPrdFor(gmDispatch))
    recordRunningImage('stdio', runningBundle())
    watchForStaleBundle({ transportKind: 'stdio' })
    scheduleStaleDeployedBundleChecks(null, runLeakWatchPass)
    runReleaseBridgeInBackground()
}

export { flagValue }
