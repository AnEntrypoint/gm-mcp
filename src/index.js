import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions, setHealthExtras } from './http-transport.js'
import { defaultHttpPort, ensureHttpSingletonInBackground, ensureHttpSupervisor, httpSingletonEnabled } from './singleton.js'
import { adoptHandedOverHandle, handOverToRefreshedBundle, handoverRequested, HANDOVER_LISTEN_RETRY_MS } from './bundle-refresh.js'
import { bundleHealthBlock, bundleStalenessLine, startBundleDriftWatch } from './bundle-drift.js'
import { scheduleStaleDeployedBundleChecks } from './self-update.js'
import { runReleaseBridgeInBackground } from './release-bridge.js'
import { appendDiagnostic, describeError } from './server-log.js'

export { createServer } from './mcp-server.js'

function flagValue(name) {
    const args = process.argv.slice(2)
    const index = args.indexOf(`--${name}`)
    if (index === -1) return undefined
    const next = args[index + 1]
    return next && !next.startsWith('--') ? next : undefined
}

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

// A stdio server is owned by its client: exiting detaches it, and nothing on this side can put a
// replacement on the same stdio pair. So stdio reports the staleness and leaves the reload to the
// reconnect; only the shared HTTP server, whose clients are per-request, can replace itself.
function watchForStaleBundle({ handOver = null } = {}) {
    return startBundleDriftWatch((state) => {
        const line = bundleStalenessLine(state)
        if (line) console.error(line)
        // A stale bundle the watch cannot reload (older, unreadable, no version, reload switched off)
        // is reported and left alone: the refusal is the whole point of the check, so handing over
        // anyway would move this process onto worse code under a message saying it would not.
        if (handOver && state?.reloadable === true) return handOver(state)
        appendDiagnostic('bundle-stale-no-handover', { ...state, transport: handOver ? 'http' : 'stdio' })
        return null
    }, { transport: handOver ? 'http' : 'stdio' })
}

export async function main() {
    if (wantsHttpTransport()) {
        const { host, port } = httpListenOptions()
        setHealthExtras(() => bundleHealthBlock())
        const listenHandle = await adoptHandedOverHandle()
        const { server } = await startHttpServer({ host, port, listenHandle, listenRetryMs: handoverRequested() ? HANDOVER_LISTEN_RETRY_MS : 0 })
        seedHttpSingletonInBackground({ skipPort: port })
        ensureHttpSupervisor({ port })
        watchForStaleBundle({ handOver: (state) => handOverToRefreshedBundle({ host, port, server, state }) })
        scheduleStaleDeployedBundleChecks((result) => handOverToRefreshedBundle({ host, port, server, result }))
        runReleaseBridgeInBackground()
        return
    }

    installStdioGuards()
    const server = createServer()
    const transport = new StdioServerTransport()

    const keepAlive = setInterval(() => {}, 1 << 30)

    await server.connect(transport)
    console.error('gm-mcp: connected, serving on stdio')
    seedHttpSingletonInBackground()
    watchForStaleBundle()
    scheduleStaleDeployedBundleChecks()
    runReleaseBridgeInBackground()
}

export { flagValue }
