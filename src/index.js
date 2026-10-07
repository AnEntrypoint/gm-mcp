import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './mcp-server.js'
import { installStdioGuards } from './transport-guard.js'
import { startHttpServer, httpListenOptions } from './http-transport.js'
import { ensureHttpSingleton, ensureHttpSupervisor } from './singleton.js'
import { refreshStaleDeployedBundleInBackground } from './self-update.js'

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

// A stdio server is owned by the client that spawned it: when that one pipe
// goes away the tool is gone for the whole session and nothing can re-attach
// it. Seeding the shared HTTP singleton here means the durable transport is
// up before any client asks for it, so switching the registration over is a
// one-liner with nothing to install.
function seedHttpSingletonInBackground() {
    if ((process.env.GM_MCP_HTTP_SINGLETON || '').trim() === '0') return
    ensureHttpSingleton()
        .then((result) => {
            if (result?.url) return
        })
        .catch(() => {})
}

// Armed after the listen succeeds rather than before, so the supervisor can
// never watch a port this process failed to take.
function seedHttpSupervisorInBackground(port) {
    ensureHttpSupervisor({ port })
        .catch(() => {})
}

export async function main() {
    if (wantsHttpTransport()) {
        const { port } = await startHttpServer(httpListenOptions())
        seedHttpSupervisorInBackground(port)
        return
    }

    installStdioGuards()
    const server = createServer()
    const transport = new StdioServerTransport()

    const keepAlive = setInterval(() => {}, 1 << 30)

    await server.connect(transport)
    console.error('gm-mcp: connected, serving on stdio')
    seedHttpSingletonInBackground()
    refreshStaleDeployedBundleInBackground()
}

export { flagValue }
