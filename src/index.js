import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions } from './http-transport.js'
import { ensureHttpSingleton } from './singleton.js'
import { scheduleStaleDeployedBundleChecks } from './self-update.js'
import { runReleaseBridgeInBackground } from './release-bridge.js'

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

function seedHttpSingletonWhenOptedIn() {
    if ((process.env.GM_MCP_HTTP_SINGLETON || '').trim() !== '1') return
    ensureHttpSingleton()
        .then((result) => {
            if (result?.url) return
        })
        .catch(() => {})
}

export async function main() {
    if (wantsHttpTransport()) {
        await startHttpServer(httpListenOptions())
        scheduleStaleDeployedBundleChecks()
        runReleaseBridgeInBackground()
        return
    }

    installStdioGuards()
    const server = createServer()
    const transport = new StdioServerTransport()

    const keepAlive = setInterval(() => {}, 1 << 30)

    await server.connect(transport)
    console.error('gm-mcp: connected, serving on stdio')
    seedHttpSingletonWhenOptedIn()
    scheduleStaleDeployedBundleChecks()
    runReleaseBridgeInBackground()
}

export { flagValue }
