import { main } from './index.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { clearLocalBuildPin, localBuildPinPath, noSelfUpdateFilePath, pinLocalBuild, selfUpdateStatus } from './self-update.js'

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
}

const command = process.argv[2]

if (command === '--help' || command === '-h') {
    console.log(`gm-mcp ${BUNDLE_VERSION}

usage:
  gm-mcp-server.js                 start the MCP stdio server
  gm-mcp-server.js pin-local-build [path]   pin the deployed bundle (default ~/.gm-tools/gm-mcp-server.mjs) so a self-update cannot overwrite it
  gm-mcp-server.js unpin-local-build        clear that pin
  gm-mcp-server.js self-update-status       print freeze state, local-build pin and deployed bundle sha256

freeze a self-update without a pin by setting ${'GM_MCP_NO_SELF_UPDATE'}=1 or creating ${noSelfUpdateFilePath()}`)
    process.exit(0)
}

if (command && COMMANDS[command]) {
    try {
        process.exit(COMMANDS[command]())
    } catch (error) {
        console.error(`gm-mcp: ${command} failed: ${error.message}`)
        process.exit(1)
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
