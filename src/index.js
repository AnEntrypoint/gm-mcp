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

// Opt-in (GM_MCP_HTTP_SINGLETON=1): seeding starts a detached HTTP server that
// outlives the session, so a plain stdio session never leaves one behind.
function seedHttpSingletonInBackground() {
    if ((process.env.GM_MCP_HTTP_SINGLETON || '').trim() !== '1') return
    ensureHttpSingleton()
        .then((result) => {
            if (result?.url) return
        })
        .catch(() => {})
}

// The supervisor is the only thing that brings this server back when it dies,
// and it is just another detached process: killed, it stays dead, and nothing
// on the http registration's path can re-arm it -- the window this server stays
// down is exactly the window in which a client decides it is disconnected for
// good. Re-assert it on a slow loop; the call is a no-op while its pid is alive.
function supervisorRearmMs() {
    const seconds = Number((process.env.GM_MCP_HTTP_SUPERVISOR_REARM_SECONDS || '').trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 5 * 60_000
}
const SUPERVISOR_REARM_MS = supervisorRearmMs()
function armHttpSupervisor(port) {
    const arm = () => ensureHttpSupervisor({ port }).catch(() => {})
    arm()
    const timer = setInterval(arm, SUPERVISOR_REARM_MS)
    timer.unref?.()
}

export async function main() {
    if (wantsHttpTransport()) {
        const { port } = await startHttpServer(httpListenOptions())
        armHttpSupervisor(port)
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
