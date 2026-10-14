// Which copy of the bundle is running, and whether it may change what the machine runs.
//
// The deployed copy is <GM_TOOLS_DIR>/gm-mcp-server.mjs (default ~/.gm-tools). Any other copy is a dev
// copy: a repo checkout, a scratch build, a test run. A dev copy may dispatch, but it must never swap the
// installed runner or guest plugin, signal the daemon, or start, retire or supervise the shared HTTP
// server, because each of those lands on every session of the machine, not on the run that caused it.
// To exercise those paths, run the bundle as the deployed copy of a sandbox: copy it to
// <sandbox>/.gm-tools/gm-mcp-server.mjs and point HOME, GM_TOOLS_DIR and AGENTPLUG_HOME at the sandbox
// (scripts/sandboxed.mjs does exactly that).
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolsDir } from './paths.js'

export const DEPLOYED_BUNDLE_FILE_NAME = 'gm-mcp-server.mjs'

const ON_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function deployedBundlePath() {
    return path.join(toolsDir(), DEPLOYED_BUNDLE_FILE_NAME)
}

function canonicalPath(file) {
    const resolved = realpathSync(file)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function runningBundlePath() {
    return fileURLToPath(import.meta.url)
}

export function isRunningFromDeployedBundle(deployedPath = deployedBundlePath()) {
    if (!existsSync(deployedPath)) return false
    return canonicalPath(runningBundlePath()) === canonicalPath(deployedPath)
}

// An opt-in is an explicit truthy value; unset, empty and anything else is off.
export function explicitlyOn(name) {
    return ON_VALUES.has((process.env[name] ?? '').trim().toLowerCase())
}

// null for the deployed copy; otherwise why this process is a dev copy.
export function devCopyReason() {
    if (isRunningFromDeployedBundle()) return null
    return `this process runs from ${runningBundlePath()}, not the deployed ${deployedBundlePath()}`
}
