import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions, setHealthExtras } from './http-transport.js'
import { defaultHttpPort, ensureHttpSingleton, ensureHttpSingletonInBackground, ensureHttpSupervisor, httpMcpUrl, httpSingletonEnabled, probeHealth, recordHttpInstance } from './singleton.js'
import { serveStdioRelay } from './stdio-relay.js'
import { adoptHandedOverHandle, handOverToRefreshedBundle, handoverRequested, HANDOVER_LISTEN_RETRY_MS } from './bundle-refresh.js'
import { bundleHealthBlock, bundleStalenessAnnouncement, runningBundle, startBundleDriftWatch } from './bundle-drift.js'
import { recordRunningImage } from './running-images.js'
import { scheduleStaleDeployedBundleChecks } from './self-update.js'
import { runLeakWatchPass } from './leak-watch.js'
import { runReleaseBridgeInBackground } from './release-bridge.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { installSpoolPort } from './spool-port.js'
import { flagValue } from './argv.js'
import { nodeSpoolPort } from './spool-port-node.js'

installSpoolPort(nodeSpoolPort)

export { createServer } from './mcp-server.js'

export function wantsHttpTransport() {
    if (process.argv.slice(2).includes('--http')) return true
    return (process.env.GM_MCP_TRANSPORT || '').trim().toLowerCase() === 'http'
}

function seedHttpSingletonInBackground({ skipPort = null } = {}) {
    if (!httpSingletonEnabled()) return null
    const port = defaultHttpPort()
    if (skipPort !== null && Number(skipPort) === port) {
        appendDiagnostic('http-singleton-self', { port, pid: process.pid })
        return null
    }
    try {
        return ensureHttpSingletonInBackground({ port })
    } catch (error) {
        appendDiagnostic('http-singleton-seed-failed', { port, error: describeError(error) })
        return null
    }
}

async function stdioRelayTarget() {
    if (!httpSingletonEnabled()) return null
    const port = defaultHttpPort()
    const started = await ensureHttpSingleton({ port, wait: true, sweep: false }).catch((error) => {
        appendDiagnostic('stdio-relay-singleton-failed', { error: describeError(error) })
        return null
    })
    if (started?.url) return started.url
    const live = await probeHealth(port)
    if (live) {
        appendDiagnostic('stdio-relay-reused-live-singleton', { port, pid: live.pid ?? null })
        return httpMcpUrl(port)
    }
    const reason = started?.error ?? 'singleton start threw'
    appendDiagnostic('stdio-relay-no-singleton', { port, reason })
    console.error('gm-mcp: no gm-mcp HTTP server answers on port ' + port + ' and none could start (' + reason + '); refusing to start a second standalone server -- see ' + logFilePath())
    process.exit(1)
}

function watchForStaleBundle({ handOver = null, transportKind = 'stdio' } = {}) {
    return startBundleDriftWatch((state) => {
        const honest = handOver ? state : { ...state, reloadable: false, refusal_code: 'no-handover', refusal_reason: 'a ' + transportKind + ' server cannot replace itself without dropping its client, so a relaunch serves the installed bundle' }
        const line = bundleStalenessAnnouncement(honest)
        if (line) console.error(line)
        if (handOver && state?.reloadable === true) return handOver(state)
        if (line) appendDiagnostic('bundle-stale-no-handover', { ...honest, transport: transportKind })
        return null
    }, { transport: transportKind })
}

export async function main() {
    if (wantsHttpTransport()) {
        const { host, port } = httpListenOptions()
        setHealthExtras(() => bundleHealthBlock())
        const listenHandle = await adoptHandedOverHandle()
        const { server } = await startHttpServer({ host, port, listenHandle, listenRetryMs: handoverRequested() ? HANDOVER_LISTEN_RETRY_MS : 0 })
        recordRunningImage('http', runningBundle())
        seedHttpSingletonInBackground({ skipPort: port })
        const supervision = ensureHttpSupervisor({ port })
        recordHttpInstance({ port, host, supervisorPid: supervision?.pid ?? null })
        watchForStaleBundle({ transportKind: 'http', handOver: (state) => handOverToRefreshedBundle({ host, port, server, state }) })
        scheduleStaleDeployedBundleChecks((result) => handOverToRefreshedBundle({ host, port, server, result }), runLeakWatchPass)
        runReleaseBridgeInBackground()
        return
    }

    installStdioGuards()
    const relayUrl = await stdioRelayTarget()
    if (relayUrl) {
        recordRunningImage('stdio-relay', runningBundle())
        watchForStaleBundle({ transportKind: 'stdio-relay' })
        return serveStdioRelay({ url: relayUrl })
    }
    appendDiagnostic('stdio-standalone-start', { pid: process.pid })
    const server = createServer()
    const transport = new StdioServerTransport()

    const keepAlive = setInterval(() => {}, 1 << 30)

    await server.connect(transport)
    console.error('gm-mcp: connected, serving on stdio')
    recordRunningImage('stdio', runningBundle())
    seedHttpSingletonInBackground()
    watchForStaleBundle({ transportKind: 'stdio' })
    scheduleStaleDeployedBundleChecks(null, runLeakWatchPass)
    runReleaseBridgeInBackground()
}

export { flagValue }
