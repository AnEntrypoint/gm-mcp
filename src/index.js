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

export async function main() {
    if (wantsHttpTransport()) {
        const { host, port } = httpListenOptions()
        const { server } = await startHttpServer({ host, port })
        seedHttpSingletonInBackground({ skipPort: port })
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
