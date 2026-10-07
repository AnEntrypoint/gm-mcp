import { main, flagValue } from './index.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { clearLocalBuildPin, localBuildPinPath, noSelfUpdateFilePath, pinLocalBuild, selfUpdateStatus } from './self-update.js'
import { defaultHttpPort, ensureHttpSingleton, httpMcpUrl, probeHealth, runHttpSupervisor, supervisorIntervalMs } from './singleton.js'

const COMMANDS = {
    'pin-local-build': () => {
        const deployedPath = process.argv[3]
        const pin = deployedPath ? pinLocalBuild(deployedPath) : pinLocalBuild()
        console.log(`gm-mcp ${BUNDLE_VERSION}: pinned ${pin.path} (sha256 ${pin.sha256}) as a local build in ${localBuildPinPath()} -- the release channel can no longer overwrite it`)
        return 0
    },
    'unpin-local-build': () => {
        const pinPath = clearLocalBuildPin()
        console.log(`gm-mcp ${BUNDLE_VERSION}: cleared the local-build pin at ${pinPath} -- the release channel may update the deployed bundle again`)
        return 0
    },
    'self-update-status': () => {
        console.log(JSON.stringify(selfUpdateStatus(), null, 2))
        return 0
    },
    'ensure-http': async () => {
        const port = defaultHttpPort()
        const result = await ensureHttpSingleton({ port })
        if (!result.url) {
            console.error(`gm-mcp ${BUNDLE_VERSION}: ${result.error}`)
            return 1
        }
        console.log(`gm-mcp ${BUNDLE_VERSION}: ${result.reused ? 'reusing' : 'started'} the shared HTTP server (pid ${result.pid}) -- ${result.url}`)
        return 0
    },
    'http-status': async () => {
        const port = defaultHttpPort()
        const health = await probeHealth(port)
        console.log(JSON.stringify({ port, url: httpMcpUrl(port), running: Boolean(health), health }, null, 2))
        return 0
    },
    'http-supervise': async () => {
        const port = Number(flagValue('port')) || defaultHttpPort()
        const seconds = Number(flagValue('interval'))
        const intervalMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : supervisorIntervalMs()
        const result = await runHttpSupervisor({ port, intervalMs })
        console.log(`gm-mcp ${BUNDLE_VERSION}: http-supervise ${port} ended -- ${result.reason ?? 'stopped'}`)
        return 0
    },
}

const command = process.argv[2]

if (command === '--help' || command === '-h') {
    console.log(`gm-mcp ${BUNDLE_VERSION}

usage:
  gm-mcp-server.js                 start the MCP stdio server
  gm-mcp-server.js --http [--port N] [--host H]
                                   serve MCP streamable HTTP on http://127.0.0.1:N/mcp
                                   (stateless, so a dropped client is just another request)
  gm-mcp-server.js ensure-http     start the shared HTTP server if none is listening and print its url
  gm-mcp-server.js http-status     report whether the shared HTTP server is answering
  gm-mcp-server.js http-supervise [--port N] [--interval S]
                                   watch the shared HTTP server and restart it when it stops answering
                                   (a --http server starts one for itself unless ${'GM_MCP_HTTP_SUPERVISOR'}=0)
  gm-mcp-server.js pin-local-build [path]   pin the deployed bundle (default ~/.gm-tools/gm-mcp-server.mjs) so a self-update cannot overwrite it
  gm-mcp-server.js unpin-local-build        clear that pin
  gm-mcp-server.js self-update-status       print freeze state, local-build pin and deployed bundle sha256

register the durable transport instead of stdio with:
  claude mcp remove gm -s user && claude mcp add --transport http gm ${'http://127.0.0.1:'}${defaultHttpPort()}${'/mcp'} -s user

freeze a self-update without a pin by setting ${'GM_MCP_NO_SELF_UPDATE'}=1 or creating ${noSelfUpdateFilePath()}`)
    process.exit(0)
}

if (command && COMMANDS[command]) {
    try {
        process.exit(await COMMANDS[command]())
    } catch (error) {
        console.error(`gm-mcp: ${command} failed: ${error.message}`)
        process.exit(1)
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
