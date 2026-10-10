import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions } from './http-transport.js'
import { defaultHttpPort, ensureHttpSingletonInBackground, ensureHttpSupervisor, httpSingletonEnabled } from './singleton.js'
import { handOverToRefreshedBundle } from './bundle-refresh.js'
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

// Whatever transport this process was started on, it leaves a shared HTTP
// server behind: an agent host configured with the HTTP url never starts one,
// so a session whose port was never opened has no gm tools at all. Never
// awaited -- the spawn is detached and unref'd, so a stdio session is neither
// slowed nor held open by it.
function seedHttpSingletonInBackground({ skipPort = null } = {}) {
    if (!httpSingletonEnabled()) return null
    const port = defaultHttpPort()
    // This process is already that server; seeding would spawn a second one to
    // die on EADDRINUSE.
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

export async function main() {
    if (wantsHttpTransport()) {
        const { host, port } = httpListenOptions()
        const { server } = await startHttpServer({ host, port })
        seedHttpSingletonInBackground({ skipPort: port })
        // This process is the only thing that knows the port is meant to be
        // up, so it arms the watcher that keeps it up after it is gone.
        ensureHttpSupervisor({ port })
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
    scheduleStaleDeployedBundleChecks()
    runReleaseBridgeInBackground()
}

export { flagValue }
