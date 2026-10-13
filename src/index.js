import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions, setHealthExtras } from './http-transport.js'
import { defaultHttpPort, ensureHttpSingletonInBackground, ensureHttpSupervisor, httpSingletonEnabled, recordHttpInstance } from './singleton.js'
import { adoptHandedOverHandle, handOverStdioToRefreshedBundle, handOverToRefreshedBundle, handoverRequested, HANDOVER_LISTEN_RETRY_MS } from './bundle-refresh.js'
import { bundleHealthBlock, bundleStalenessAnnouncement, startBundleDriftWatch } from './bundle-drift.js'
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

function watchForStaleBundle({ handOver = null, transportKind = 'stdio' } = {}) {
    return startBundleDriftWatch((state) => {
        const line = bundleStalenessAnnouncement(state)
        if (line) console.error(line)
        if (handOver && state?.reloadable === true) return handOver(state)
        appendDiagnostic('bundle-stale-no-handover', { ...state, transport: transportKind })
        return null
    }, { transport: transportKind })
}

export async function main() {
    if (wantsHttpTransport()) {
        const { host, port } = httpListenOptions()
        setHealthExtras(() => bundleHealthBlock())
        const listenHandle = await adoptHandedOverHandle()
        const { server } = await startHttpServer({ host, port, listenHandle, listenRetryMs: handoverRequested() ? HANDOVER_LISTEN_RETRY_MS : 0 })
        seedHttpSingletonInBackground({ skipPort: port })
        const supervision = ensureHttpSupervisor({ port })
        recordHttpInstance({ port, host, supervisorPid: supervision?.pid ?? null })
        watchForStaleBundle({ transportKind: 'http', handOver: (state) => handOverToRefreshedBundle({ host, port, server, state }) })
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
    watchForStaleBundle({ transportKind: 'stdio', handOver: (state) => handOverStdioToRefreshedBundle({ transport, state }) })
    scheduleStaleDeployedBundleChecks()
    runReleaseBridgeInBackground()
}

export { flagValue }
