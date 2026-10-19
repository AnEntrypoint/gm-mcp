import { createHash } from 'node:crypto'
import { spawnSync } from './process-port.js'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLE_VERSION } from './bundle-version.js'
import { agentplugDir, toolsDir } from './paths.js'
import { appendDiagnostic, describeError, logFilePath, logLocations } from './server-log.js'
import { inflightDispatchCount } from './dispatch.js'
import { liveRunningImages, unrecordedBundleProcesses } from './running-images.js'

const DEPLOYED_BUNDLE_FILE_NAME = 'gm-mcp-server.mjs'
const DEFAULT_BUNDLE_URL = 'https://raw.githubusercontent.com/AnEntrypoint/gm-mcp/main/bin/gm-mcp-server.js'
const HEAD_PROBE_URL = 'https://api.github.com/repos/AnEntrypoint/gm-mcp/commits/main'
const commitBundleUrl = (sha) => `https://raw.githubusercontent.com/AnEntrypoint/gm-mcp/${sha}/bin/gm-mcp-server.js`
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000
// The commits probe spends one unauthenticated GitHub request per interval (60/h quota), so no operator value may poll faster.
const MIN_CHECK_INTERVAL_MS = DEFAULT_CHECK_INTERVAL_MS
// A stored validator is sent only within this long of the last unconditional fetch (see refreshStaleDeployedBundle).
const FULL_FETCH_INTERVAL_MS = 10 * 60 * 1000
const DEFER_RETRY_DELAY_MS = 20_000
const MAX_DEFER_RETRIES_PER_TRIGGER = 4
const SWAP_DEFER_LIMIT_MS = 120_000
let swapDeferralStartedAt = null
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
    const deployedSha = bytes ? sha256(bytes) : null
    const deployedVersion = bytes ? parseBundleVersion(bytes) : null
    const deployedMtimeMs = bytes ? statSync(deployedPath).mtimeMs : null
    const recorded = liveRunningImages()
    const runningImages = [
        ...recorded.map((image) => ({
            pid: image.pid,
            role: image.role,
            version: image.version,
            sha256: typeof image.sha256 === 'string' ? image.sha256.slice(0, 12) : null,
            started_at: image.started_at,
            stale: Boolean(deployedSha) && (image.version !== deployedVersion || image.sha256 !== deployedSha),
        })),
        ...unrecordedBundleProcesses(new Set(recorded.map((image) => image.pid)), deployedMtimeMs),
    ]
    return {
        installed_version: BUNDLE_VERSION,
        deployed_bundle: deployedPath,
        running_from_deployed_bundle: isRunningFromDeployedBundle(deployedPath),
        deployed_sha256: deployedSha,
        deployed_pinned_as_local_build: Boolean(bytes && pin && pin.sha256 === deployedSha),
        running_images: runningImages,
        stale_running_images: runningImages.filter((image) => image.stale === true).length,
        unknown_running_images: runningImages.filter((image) => image.stale === 'unknown').length,
        frozen_by: noSelfUpdateReason(),
        no_self_update_file: noSelfUpdateFilePath(),
        no_self_update_file_present: existsSync(noSelfUpdateFilePath()),
        channel_cache: readBundleCache(deployedPath),
        local_build_pin_path: localBuildPinPath(),
        local_build_pin: pin,
        logs: logLocations(),
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
    return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.max(MIN_CHECK_INTERVAL_MS, fromEnv) : DEFAULT_CHECK_INTERVAL_MS
}

function checkedRecently(stampPath) {
    if (!existsSync(stampPath)) return false
    return Date.now() - statSync(stampPath).mtimeMs < checkIntervalMs()
}

function deferRetryDelayMs() {
    // A retry finishes the trigger that deferred, so it is not a second poll loop -- but it must
    // still never fetch faster than the interval the operator asked for, so an operator who
    // shortened that interval below the default retry delay gets retries no faster than it.
    return Math.min(DEFER_RETRY_DELAY_MS, checkIntervalMs())
}

function touch(stampPath) {
    if (!existsSync(stampPath)) writeFileSync(stampPath, '')
    const now = new Date()
    utimesSync(stampPath, now, now)
}

function bundleCachePath(deployedPath) {
    return `${deployedPath}.fetched.json`
}

function readBundleCache(deployedPath) {
    try {
        return JSON.parse(readFileSync(bundleCachePath(deployedPath), 'utf8'))
    } catch {
        return null
    }
}

function writeBundleCache(deployedPath, record) {
    writeFileSync(bundleCachePath(deployedPath), JSON.stringify(record))
}

// A conditional request costs headers only when the bundle is unchanged: the server answers 304 to
// an If-None-Match that still matches, so a check that finds nothing new moves no bundle bytes.
async function fetchBundle(url, cached) {
    if (url.startsWith('file:')) return { bytes: readFileSync(fileURLToPath(url)), etag: null, notModified: false }
    const headers = cached?.etag ? { 'if-none-match': cached.etag } : {}
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status === 304 && cached?.etag) return { bytes: null, etag: cached.etag, notModified: true }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
    return { bytes: Buffer.from(await response.arrayBuffer()), etag: response.headers.get('etag'), notModified: false }
}

// The API probe is the freshness signal: a 304 on the stored validator means the main tip is unchanged and costs no
// body; a 200 names the tip sha, which the bundle is then fetched by (commit-addressed URLs are immutable).
let headProbeBackoffUntilMs = 0

async function probeHead(cached) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'gm-mcp-self-update' }
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (token) headers.authorization = `Bearer ${token}`
    const validated = Boolean(cached?.api_etag && cached?.commit_sha)
    if (validated) headers['if-none-match'] = cached.api_etag
    const response = await fetch(HEAD_PROBE_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status === 304 && validated) return { notModified: true, sha: cached.commit_sha, etag: cached.api_etag }
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${HEAD_PROBE_URL}`)
        const resetEpochSec = Number(response.headers.get('x-ratelimit-reset'))
        const retryAfterSec = Number(response.headers.get('retry-after'))
        if ((response.status === 403 || response.status === 429) && resetEpochSec > 0) error.rateLimitResetMs = resetEpochSec * 1000
        else if ((response.status === 403 || response.status === 429) && retryAfterSec > 0) error.rateLimitResetMs = Date.now() + retryAfterSec * 1000
        throw error
    }
    const head = await response.json()
    if (typeof head?.sha !== 'string' || !COMMIT_SHA_PATTERN.test(head.sha)) throw new Error('commits API reply names no head sha')
    return { notModified: false, sha: head.sha, etag: response.headers.get('etag') }
}

// A rate-limited API probe backs off until GitHub's reset time; the raw-main fallback in refreshStaleDeployedBundle covers the gap.
// Every failure is logged; appendDiagnostic suppresses only identical repeats within its window.
async function probeHeadOrNull(cached) {
    if (Date.now() < headProbeBackoffUntilMs) return null
    try {
        return await probeHead(cached)
    } catch (error) {
        if (error.rateLimitResetMs) headProbeBackoffUntilMs = error.rateLimitResetMs
        appendDiagnostic('self-update-probe-failed', { error: describeError(error), backoff_until_ms: headProbeBackoffUntilMs || null })
        return null
    }
}

function assertLoadableBundle(bytes, candidatePath) {
    if (bytes.length < MIN_PLAUSIBLE_BUNDLE_BYTES) throw new Error(`candidate bundle is only ${bytes.length} bytes`)
    if (!bytes.subarray(0, BUNDLE_SHEBANG.length).toString('utf8').startsWith(BUNDLE_SHEBANG)) throw new Error('candidate bundle has no node shebang')
    const syntaxCheck = spawnSync(process.execPath, ['--check', candidatePath], { encoding: 'utf8', windowsHide: true })
    if (syntaxCheck.status !== 0) {
        const lines = syntaxCheck.stderr.trim().split('\n')
        const message = lines.find((line) => /^\w*Error\b/.test(line.trim())) || lines.at(-1)
        const location = lines.find((line) => /:\d+$/.test(line.trim())) || lines[0]
        throw new Error(`candidate bundle fails node --check: ${location.trim()} ${message.trim()}`)
    }
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

export async function refreshStaleDeployedBundle(deployedPath = defaultDeployedPath(), options = {}) {
    const countInflightDispatches = options.countInflightDispatches ?? inflightDispatchCount
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
    const ignoreStamp = options.ignoreStamp === true || options.force === true
    if (!ignoreStamp && checkedRecently(stampPath)) return { outcome: 'checked-recently', self }

    const { bytes: deployedBytes, sha256: deployedHash } = readDigest(deployedPath)
    const pinned = localBuildPinReason(deployedHash)
    if (pinned) return refuse(pinned.code, pinned.reason)

    const url = process.env.GM_MCP_BUNDLE_URL || DEFAULT_BUNDLE_URL
    const cached = readBundleCache(deployedPath)
    const head = url === DEFAULT_BUNDLE_URL ? await probeHeadOrNull(options.unconditional === true ? null : cached) : null
    if (head?.notModified && cached.sha === deployedHash) {
        writeBundleCache(deployedPath, { ...cached, checked_at: Date.now(), outcome: 'not_modified' })
        touch(stampPath)
        return { outcome: 'current', self, hash: deployedHash, not_modified: true, probe: 'api' }
    }
    let fetched
    let fullAt = cached?.full_at || 0
    // A null commit_sha and api_etag make the next probe unconditional, so a fallback fetch never leaves a validator behind.
    let record = { commit_sha: null, api_etag: null }
    if (head) {
        fetched = await fetchBundle(commitBundleUrl(head.sha), null)
        record = { commit_sha: head.sha, api_etag: head.etag }
    } else {
        // Fallback when the API probe fails: the raw-main fetch, with its unconditional full fetch at FULL_FETCH_INTERVAL_MS.
        const fullDue = options.unconditional === true || !cached || cached.sha !== deployedHash ||
            Date.now() - (cached.full_at || 0) >= FULL_FETCH_INTERVAL_MS
        fetched = await fetchBundle(url, fullDue ? null : cached)
        fullAt = fullDue ? Date.now() : cached.full_at
    }
    const fetchedFrom = head ? commitBundleUrl(head.sha) : url
    if (fetched.notModified) {
        writeBundleCache(deployedPath, { etag: fetched.etag, sha: deployedHash, full_at: fullAt, checked_at: Date.now(), outcome: 'not_modified', ...record })
        touch(stampPath)
        return { outcome: 'current', self, hash: deployedHash, not_modified: true, probe: head ? 'api' : 'raw' }
    }
    const freshBytes = fetched.bytes
    const freshHash = sha256(freshBytes)
    if (freshHash === deployedHash) {
        writeBundleCache(deployedPath, { etag: fetched.etag, sha: freshHash, full_at: fullAt, checked_at: Date.now(), outcome: 'current', ...record })
        touch(stampPath)
        return { outcome: 'current', self, hash: freshHash }
    }
    const version = versionGuardReason(freshBytes, deployedBytes)
    if (version.code) return refuse(version.code, version.reason)

    // Swapping the bundle under a dispatch that is running would cut that dispatch's reply off
    // mid-write, so the swap waits -- and the wait is retried soon instead of an interval later.
    const dispatchesInflight = countInflightDispatches()
    if (dispatchesInflight > 0) {
        swapDeferralStartedAt ??= Date.now()
        const waitedMs = Date.now() - swapDeferralStartedAt
        if (waitedMs < SWAP_DEFER_LIMIT_MS) return { outcome: 'deferred-dispatch-inflight', self, dispatches_inflight: dispatchesInflight, waited_ms: waitedMs }
        appendDiagnostic('self-update-defer-expired', { dispatches_inflight: dispatchesInflight, waited_ms: waitedMs })
    }
    swapDeferralStartedAt = null

    replaceDeployedBundle(deployedPath, freshBytes)
    writeBundleCache(deployedPath, { etag: fetched.etag, sha: freshHash, full_at: fullAt, checked_at: Date.now(), outcome: 'refreshed', ...record })
    touch(stampPath)
    return { outcome: 'refreshed', self, from: deployedHash, to: freshHash, url: fetchedFrom, probe: head ? 'api' : 'raw', deployed_bundle: deployedPath, version: `${BUNDLE_VERSION} -> ${version.candidateVersion}` }
}

// A fix pushed upstream reaches a running server within one check interval. An operator (or an agent
// that just pushed one and wants it now) can ask for the check without waiting out the stamp. This skips ONLY the stamp-freshness deferral: the freeze file, the
// local-build pin, the no-downgrade guard, the loadability check and the inflight-dispatch wait all
// still hold, and it reloads nothing -- a forced check is the same file swap the hourly tick does.
export async function refreshDeployedBundleNow(deployedPath = defaultDeployedPath(), options = {}) {
    const result = await refreshStaleDeployedBundle(deployedPath, { ...options, ignoreStamp: true, unconditional: true })
    const forced = { ...result, forced: true }
    appendDiagnostic('self-update-check', forced)
    return forced
}

export function deployedBundleVersion(deployedPath = defaultDeployedPath()) {
    try {
        return parseBundleVersion(readFileSync(deployedPath))
    } catch {
        return null
    }
}

export function describeSelfUpdateOutcome(result) {
    switch (result?.outcome) {
        case 'refreshed':
            return `refreshed ${shortHash(result.from)} -> ${shortHash(result.to)} from ${result.url}`
        case 'current':
            return `already the release-channel build${result.hash ? ` (sha ${shortHash(result.hash)})` : ''}`
        case 'checked-recently':
            return `checked within the last ${Math.round(checkIntervalMs() / 1000)}s, so the stamp was honoured`
        case 'deferred-dispatch-inflight':
            return `waiting on ${result.dispatches_inflight} dispatch(es) inflight -- the swap waits rather than cutting a reply mid-write`
        case 'disabled':
            return 'GM_MCP_SELF_UPDATE=0 disables the release channel'
        case 'no-deployed-copy':
            return `no deployed bundle at ${result.deployed_bundle}, and one is never created behind the operator`
        case 'not-deployed-copy':
            return result.reason
        case 'refused':
            return `refused (${result.code}) -- ${result.reason}`
        default:
            return `no outcome to report (${JSON.stringify(result ?? null)})`
    }
}

let deferRetriesLeft = MAX_DEFER_RETRIES_PER_TRIGGER
let deferRetriesScheduled = 0
let deferRetriesExhausted = 0
let pendingDeferRetryPromise = null

export function pendingDeferRetry() {
    return pendingDeferRetryPromise
}

export function deferRetryState() {
    return {
        max_retries_per_trigger: MAX_DEFER_RETRIES_PER_TRIGGER,
        retries_left: deferRetriesLeft,
        scheduled: deferRetriesScheduled,
        exhausted: deferRetriesExhausted,
        pending: pendingDeferRetryPromise !== null,
        delay_ms: deferRetryDelayMs(),
    }
}

function armDeferRetry(onRefreshed, options, deferred) {
    if (deferRetriesLeft <= 0) {
        deferRetriesLeft = MAX_DEFER_RETRIES_PER_TRIGGER
        deferRetriesExhausted += 1
        appendDiagnostic('self-update-defer-retry-exhausted', {
            dispatches_inflight: deferred.dispatches_inflight,
            retries: MAX_DEFER_RETRIES_PER_TRIGGER,
            next_check_in_ms: checkIntervalMs(),
        })
        return null
    }
    deferRetriesLeft -= 1
    const delayMs = options.deferRetryDelayMs ?? deferRetryDelayMs()
    appendDiagnostic('self-update-defer-retry', {
        delay_ms: delayMs,
        retries_left: deferRetriesLeft,
        dispatches_inflight: deferred.dispatches_inflight,
    })
    deferRetriesScheduled += 1
    pendingDeferRetryPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingDeferRetryPromise = null
            refreshStaleDeployedBundleInBackground(onRefreshed, options).finally(resolve)
        }, delayMs)
        timer.unref()
    })
    return pendingDeferRetryPromise
}

export function refreshStaleDeployedBundleInBackground(onRefreshed = null, options = {}) {
    return refreshStaleDeployedBundle(undefined, options)
        .then(async (result) => {
            appendDiagnostic('self-update-check', result)
            if (result.outcome === 'deferred-dispatch-inflight') {
                armDeferRetry(onRefreshed, options, result)
                return
            }
            deferRetriesLeft = MAX_DEFER_RETRIES_PER_TRIGGER
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
            console.error(`gm-mcp: bundle staleness check failed (${error?.message ?? error}); keeping the deployed copy (channel ${process.env.GM_MCP_BUNDLE_URL || DEFAULT_BUNDLE_URL}; event self-update-failed in ${logFilePath()})`)
        })
}

const HOURLY_PASS_INTERVAL_MS = 60 * 60 * 1000

export function scheduleStaleDeployedBundleChecks(onRefreshed = null, hourlyPass = null) {
    const everyTicks = Math.max(1, Math.round(HOURLY_PASS_INTERVAL_MS / checkIntervalMs()))
    let tick = 0
    const pass = () => {
        const runHourly = tick % everyTicks === 0
        tick += 1
        refreshStaleDeployedBundleInBackground(onRefreshed)
        if (!runHourly || typeof hourlyPass !== 'function') return
        Promise.resolve()
            .then(hourlyPass)
            .catch((error) => appendDiagnostic('hourly-pass-failed', { error: describeError(error) }))
    }
    pass()
    const timer = setInterval(pass, checkIntervalMs())
    timer.unref()
    return timer
}
