#!/usr/bin/env node
// Runs one command inside a throwaway home, so nothing it spawns (the bundle, the runner, a test, a
// witness) can read or change the real ~/.gm-tools or ~/.agentplug. HOME, USERPROFILE, GM_TOOLS_DIR and
// AGENTPLUG_HOME point at a fresh temp dir that holds no runner binary and no daemon, and the background
// features that touch a machine-wide install (release bridge, self-update, shared HTTP server, dev sync)
// are switched off. A run that needs a runner copies one into <home>/.gm-tools itself.
//
//   node scripts/sandboxed.mjs node test/landed-output.test.mjs
//   node scripts/sandboxed.mjs --keep node bin/gm-mcp-server.js dispatch health   (keeps the sandbox dir)
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const keep = args[0] === '--keep'
if (keep) args.shift()
const [command, ...rest] = args
if (!command) {
    console.error('usage: node scripts/sandboxed.mjs [--keep] <command> [args...]')
    process.exit(2)
}

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'gm-mcp-sandbox-')))
mkdirSync(path.join(home, '.gm-tools'), { recursive: true })
mkdirSync(path.join(home, '.agentplug'), { recursive: true })

const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GM_TOOLS_DIR: path.join(home, '.gm-tools'),
    AGENTPLUG_HOME: path.join(home, '.agentplug'),
    GM_MCP_RELEASE_BRIDGE: '0',
    GM_MCP_NO_SELF_UPDATE: '1',
    GM_MCP_SELF_UPDATE: '0',
    GM_MCP_NO_HTTP_SINGLETON: '1',
    GM_MCP_HTTP_SUPERVISOR: '0',
    GM_MCP_BUNDLE_DRIFT_RELOAD: '0',
    GM_MCP_DEV_SYNC: '0',
}

const result = spawnSync(command, rest, { env, stdio: 'inherit', windowsHide: true })

if (keep) {
    console.error(`gm-mcp sandbox kept at ${home}`)
} else {
    try {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
        console.error(`gm-mcp sandbox ${home} was not removed: ${error.message}`)
    }
}
if (result.error) {
    console.error(`gm-mcp sandbox: could not run ${command}: ${result.error.message}`)
    process.exit(127)
}
process.exit(result.status ?? 1)
