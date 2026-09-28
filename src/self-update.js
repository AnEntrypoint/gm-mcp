import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEPLOYED_BUNDLE_FILE_NAME = 'gm-mcp-server.mjs'
const DEFAULT_BUNDLE_URL = 'https://raw.githubusercontent.com/AnEntrypoint/gm-mcp/main/bin/gm-mcp-server.js'
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000
const MIN_PLAUSIBLE_BUNDLE_BYTES = 100_000
const BUNDLE_SHEBANG = '#!/usr/bin/env node'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const shortHash = (hex) => hex.slice(0, 12)

function toolsDir() {
    return process.env.GM_TOOLS_DIR || path.join(homedir(), '.gm-tools')
}

function canonicalPath(file) {
    const resolved = realpathSync(file)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isRunningFromDeployedBundle(deployedPath) {
    if (!existsSync(deployedPath)) return false
    return canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(deployedPath)
}

function checkedRecently(stampPath) {
    const intervalMs = Number(process.env.GM_MCP_SELF_UPDATE_INTERVAL_MS ?? DEFAULT_CHECK_INTERVAL_MS)
    if (!existsSync(stampPath)) return false
    return Date.now() - statSync(stampPath).mtimeMs < intervalMs
}

function touch(stampPath) {
    if (!existsSync(stampPath)) writeFileSync(stampPath, '')
    const now = new Date()
    utimesSync(stampPath, now, now)
}

async function fetchBundleBytes(url) {
    if (url.startsWith('file:')) return readFileSync(fileURLToPath(url))
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
    return Buffer.from(await response.arrayBuffer())
}

function assertLoadableBundle(bytes, candidatePath) {
    if (bytes.length < MIN_PLAUSIBLE_BUNDLE_BYTES) throw new Error(`candidate bundle is only ${bytes.length} bytes`)
    if (!bytes.subarray(0, BUNDLE_SHEBANG.length).toString('utf8').startsWith(BUNDLE_SHEBANG)) throw new Error('candidate bundle has no node shebang')
    const syntaxCheck = spawnSync(process.execPath, ['--check', candidatePath], { encoding: 'utf8' })
    if (syntaxCheck.status !== 0) throw new Error(`candidate bundle fails node --check: ${syntaxCheck.stderr.trim().split('\n')[0]}`)
}

function replaceDeployedBundle(deployedPath, bytes) {
    const candidatePath = `${deployedPath}.candidate.${process.pid}.mjs`
    writeFileSync(candidatePath, bytes)
    try {
        assertLoadableBundle(bytes, candidatePath)
        copyFileSync(deployedPath, `${deployedPath}.prev`)
        renameSync(candidatePath, deployedPath)
    } catch (error) {
        if (existsSync(candidatePath)) unlinkSync(candidatePath)
        throw error
    }
}

export async function refreshStaleDeployedBundle() {
    if (process.env.GM_MCP_SELF_UPDATE === '0') return { outcome: 'disabled' }
    const deployedPath = path.join(toolsDir(), DEPLOYED_BUNDLE_FILE_NAME)
    if (!isRunningFromDeployedBundle(deployedPath)) return { outcome: 'not-deployed-copy' }
    const stampPath = `${deployedPath}.checked`
    if (checkedRecently(stampPath)) return { outcome: 'checked-recently' }

    const url = process.env.GM_MCP_BUNDLE_URL || DEFAULT_BUNDLE_URL
    const freshBytes = await fetchBundleBytes(url)
    const freshHash = sha256(freshBytes)
    const deployedHash = sha256(readFileSync(deployedPath))
    if (freshHash === deployedHash) {
        touch(stampPath)
        return { outcome: 'current', hash: freshHash }
    }
    replaceDeployedBundle(deployedPath, freshBytes)
    touch(stampPath)
    return { outcome: 'refreshed', from: deployedHash, to: freshHash, url }
}

export function refreshStaleDeployedBundleInBackground() {
    refreshStaleDeployedBundle()
        .then((result) => {
            if (result.outcome === 'refreshed') {
                console.error(`gm-mcp: deployed bundle was stale -- refreshed ${shortHash(result.from)} -> ${shortHash(result.to)} from ${result.url}; takes effect on next connect (previous kept as ${DEPLOYED_BUNDLE_FILE_NAME}.prev)`)
            }
        })
        .catch((error) => {
            console.error(`gm-mcp: bundle staleness check failed (${error.message}); keeping the deployed copy`)
        })
}
