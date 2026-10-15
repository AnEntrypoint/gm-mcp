import { createHash } from 'node:crypto'
import { spawnSync } from './process-port.js'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLE_VERSION } from './bundle-version.js'
import { agentplugDir, toolsDir } from './paths.js'
import { appendDiagnostic } from './server-log.js'
import { inflightDispatchCount } from './dispatch.js'

const DEPLOYED_BUNDLE_FILE_NAME = 'gm-mcp-server.mjs'
const DEFAULT_BUNDLE_URL = 'https://raw.githubusercontent.com/AnEntrypoint/gm-mcp/main/bin/gm-mcp-server.js'
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000
const MIN_PLAUSIBLE_BUNDLE_BYTES = 100_000
const BUNDLE_SHEBANG = '#!/usr/bin/env node'

const NO_SELF_UPDATE_ENV = 'GM_MCP_NO_SELF_UPDATE'
const DEPLOYED_ONLY_ENV = 'GM_MCP_SELF_UPDATE_DEPLOYED_ONLY'
const NO_SELF_UPDATE_FILE = 'gm-mcp-server.no-self-update'
const LOCAL_BUILD_PIN_FILE = 'gm-mcp-server.local-build.json'
const SELF_UPDATE_OFF_VALUES = new Set(['0', 'false', 'no', 'off'])
const BUNDLE_VERSION_ASSIGNMENT = /BUNDLE_VERSION\s*=\s*["']([^"']+)["']/

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const readDigest = (file) => {
    const bytes = readFileSync(file)
    return { bytes, sha256: sha256(bytes) }
}
const shortHash = (hex) => hex.slice(0, 12)

function defaultDeployedPath() {
    return path.join(toolsDir(), DEPLOYED_BUNDLE_FILE_NAME)
}

export function noSelfUpdateFilePath() {
    return path.join(agentplugDir(), NO_SELF_UPDATE_FILE)
}

export function localBuildPinPath() {
    return path.join(agentplugDir(), LOCAL_BUILD_PIN_FILE)
}

export function noSelfUpdateReason() {
    const envValue = process.env[NO_SELF_UPDATE_ENV]
    if (envValue !== undefined && !SELF_UPDATE_OFF_VALUES.has(envValue.trim().toLowerCase())) {
        return `${NO_SELF_UPDATE_ENV}=${JSON.stringify(envValue)} suppresses self-update of the deployed bundle (set it to 0 to allow updates again)`
    }
    const marker = noSelfUpdateFilePath()
    if (existsSync(marker)) return `${marker} exists, which suppresses self-update of the deployed bundle (delete that file to allow updates again)`
    return null
}

export function deployedOnlySelfUpdateReason() {
    const envValue = process.env[DEPLOYED_ONLY_ENV]
    if (envValue === undefined) return null
    if (SELF_UPDATE_OFF_VALUES.has(envValue.trim().toLowerCase())) return null
    return `${DEPLOYED_ONLY_ENV}=${JSON.stringify(envValue)} limits the release channel to the deployed bundle's own process (set it to 0 to let any running copy keep the deployed bundle current)`
}

export function readLocalBuildPin() {
    try {
        const pin = JSON.parse(readFileSync(localBuildPinPath(), 'utf8'))
        return pin && typeof pin.sha256 === 'string' && pin.sha256 ? pin : null
    } catch {
        return null
    }
}

export function pinLocalBuild(deployedPath = defaultDeployedPath()) {
    const { bytes, sha256: deployedHash } = readDigest(deployedPath)
    const pinPath = localBuildPinPath()
    const pin = {
        sha256: deployedHash,
        path: path.resolve(deployedPath),
        version: parseBundleVersion(bytes) || BUNDLE_VERSION,
        ts: new Date().toISOString(),
    }
    mkdirSync(path.dirname(pinPath), { recursive: true })
    writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`, 'utf8')
    return pin
}

export function clearLocalBuildPin() {
    const pinPath = localBuildPinPath()
    rmSync(pinPath, { force: true })
    return pinPath
}

export function parseBundleVersion(bytes) {
    const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)
    const found = BUNDLE_VERSION_ASSIGNMENT.exec(text)
    return found ? found[1] : null
}

export function compareVersions(left, right) {
    const parts = (value) => String(value)
        .split(/[.+-]/)
        .map((part) => {
            const parsed = Number.parseInt(part, 10)
            return Number.isFinite(parsed) ? parsed : 0
        })
    const leftParts = parts(left)
    const rightParts = parts(right)
    for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
        const leftPart = leftParts[i] ?? 0
        const rightPart = rightParts[i] ?? 0
        if (leftPart > rightPart) return 1
        if (leftPart < rightPart) return -1
    }
    return 0
}

export function versionGuardReason(candidateBytes, installedBytes = null) {
    const candidateVersion = parseBundleVersion(candidateBytes)
    if (!candidateVersion) {
        return {
            code: 'candidate-version-unknown',
            reason: `the candidate bundle carries no ${BUNDLE_VERSION_ASSIGNMENT} assignment, so it cannot be proven newer than the installed ${BUNDLE_VERSION}`,
        }
    }
    const order = compareVersions(candidateVersion, BUNDLE_VERSION)
    if (order < 0) {
        return {
            code: 'no-downgrade',
            reason: `the candidate bundle is version ${candidateVersion} and the installed one is ${BUNDLE_VERSION} -- a self-update may not move backward`,
        }
    }
    if (order === 0 && installedBytes && sha256(candidateBytes) === sha256(installedBytes)) {
        return {
            code: 'same-build',
            reason: `the candidate bundle is byte-identical to the installed ${BUNDLE_VERSION} build -- nothing to update`,
        }
    }
    return { code: null, reason: null, candidateVersion }
}

export function localBuildPinReason(deployedHash) {
    const pin = readLocalBuildPin()
    if (!pin || pin.sha256 !== deployedHash) return null
    const pinPath = localBuildPinPath()
    return {
        code: 'local-build-pinned',
        reason: `the installed bundle is pinned as a local build by ${pinPath} (sha256 ${shortHash(pin.sha256)}${pin.ts ? `, pinned at ${pin.ts}` : ''}) -- clear it with "gm-mcp unpin-local-build" or delete that file to hand it back to the release channel`,
    }
}

export function selfUpdateStatus() {
    const deployedPath = defaultDeployedPath()
    let bytes = null
    try {
        bytes = readFileSync(deployedPath)
    } catch {
        bytes = null
    }
    const pin = readLocalBuildPin()
    return {
        installed_version: BUNDLE_VERSION,
        deployed_bundle: deployedPath,
        running_from_deployed_bundle: isRunningFromDeployedBundle(deployedPath),
        deployed_sha256: bytes ? sha256(bytes) : null,
        deployed_pinned_as_local_build: Boolean(bytes && pin && pin.sha256 === sha256(bytes)),
        frozen_by: noSelfUpdateReason(),
        no_self_update_file: noSelfUpdateFilePath(),
        no_self_update_file_present: existsSync(noSelfUpdateFilePath()),
        local_build_pin_path: localBuildPinPath(),
        local_build_pin: pin,
    }
}

function canonicalPath(file) {
    const resolved = realpathSync(file)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isRunningFromDeployedBundle(deployedPath) {
    if (!existsSync(deployedPath)) return false
    return canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(deployedPath)
}

function checkIntervalMs() {
    const fromEnv = Number(process.env.GM_MCP_SELF_UPDATE_INTERVAL_MS)
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CHECK_INTERVAL_MS
}

function checkedRecently(stampPath) {
    if (!existsSync(stampPath)) return false
    return Date.now() - statSync(stampPath).mtimeMs < checkIntervalMs()
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
    const syntaxCheck = spawnSync(process.execPath, ['--check', candidatePath], { encoding: 'utf8', windowsHide: true })
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

export async function refreshStaleDeployedBundle(deployedPath = defaultDeployedPath()) {
    if (process.env.GM_MCP_SELF_UPDATE === '0') return { outcome: 'disabled' }
    const self = isRunningFromDeployedBundle(deployedPath)
    const deployedOnly = deployedOnlySelfUpdateReason()
    if (deployedOnly && !self) return { outcome: 'not-deployed-copy', self, reason: deployedOnly }
    if (!existsSync(deployedPath)) return { outcome: 'no-deployed-copy', self, deployed_bundle: deployedPath }
    const refuse = (code, reason) => {
        console.error(`gm-mcp: refusing deployed bundle self-update (${code}) -- ${reason}`)
        appendDiagnostic('self-update-refused', { code, reason, self, deployed_bundle: deployedPath })
        return { outcome: 'refused', code, reason, self, deployed_bundle: deployedPath }
    }
    const suppressed = noSelfUpdateReason()
    if (suppressed) return refuse('frozen', suppressed)

    const stampPath = `${deployedPath}.checked`
    if (checkedRecently(stampPath)) return { outcome: 'checked-recently', self }

    const { bytes: deployedBytes, sha256: deployedHash } = readDigest(deployedPath)
    const pinned = localBuildPinReason(deployedHash)
    if (pinned) return refuse(pinned.code, pinned.reason)

    const url = process.env.GM_MCP_BUNDLE_URL || DEFAULT_BUNDLE_URL
    const freshBytes = await fetchBundleBytes(url)
    const freshHash = sha256(freshBytes)
    if (freshHash === deployedHash) {
        touch(stampPath)
        return { outcome: 'current', self, hash: freshHash }
    }
    const version = versionGuardReason(freshBytes, deployedBytes)
    if (version.code) return refuse(version.code, version.reason)

    if (inflightDispatchCount() > 0) return { outcome: 'deferred-dispatch-inflight', self, dispatches_inflight: inflightDispatchCount() }

    replaceDeployedBundle(deployedPath, freshBytes)
    touch(stampPath)
    return { outcome: 'refreshed', self, from: deployedHash, to: freshHash, url, deployed_bundle: deployedPath, version: `${BUNDLE_VERSION} -> ${version.candidateVersion}` }
}

export function refreshStaleDeployedBundleInBackground(onRefreshed = null) {
    return refreshStaleDeployedBundle()
        .then(async (result) => {
            appendDiagnostic('self-update-check', result)
            if (result.outcome !== 'refreshed') return
            // Only the deployed copy may hand its listen handle over: a repo-build process that
            // refreshed a foreign deployment would otherwise reload into a bundle it is not running.
            if (onRefreshed && result.self === true) {
                await onRefreshed(result)
                return
            }
            const takesEffect = result.self === true ? 'takes effect on next connect' : 'takes effect for whoever launches the deployed copy next'
            console.error(`gm-mcp: deployed bundle was stale -- refreshed ${shortHash(result.from)} -> ${shortHash(result.to)} (${result.version}) from ${result.url}; ${takesEffect} (previous kept as ${DEPLOYED_BUNDLE_FILE_NAME}.prev)`)
        })
        .catch((error) => {
            appendDiagnostic('self-update-failed', { error: error?.message ? String(error.message) : String(error) })
            console.error(`gm-mcp: bundle staleness check failed (${error.message}); keeping the deployed copy`)
        })
}

export function scheduleStaleDeployedBundleChecks(onRefreshed = null) {
    refreshStaleDeployedBundleInBackground(onRefreshed)
    const timer = setInterval(() => refreshStaleDeployedBundleInBackground(onRefreshed), checkIntervalMs())
    timer.unref()
    return timer
}
