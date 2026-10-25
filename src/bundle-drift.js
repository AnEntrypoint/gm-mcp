import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { BUNDLE_VERSION } from './bundle-version.js'
import { compareVersions, parseBundleVersion } from './self-update.js'
import { canonicalEntryPath, launchedEntryPath, serverEntryPath } from './singleton.js'
import { appendDiagnostic } from './server-log.js'

const DEFAULT_INTERVAL_MS = 30_000
const FIRST_CHECK_DELAY_MS = 5_000
const BUNDLE_SHEBANG = '#!/usr/bin/env node'
const BUNDLE_VERSION_ASSIGNMENT = /BUNDLE_VERSION\s*=\s*["']([^"']+)["']/
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

const RELOAD_ENV = 'GM_MCP_BUNDLE_DRIFT_RELOAD'
const INTERVAL_ENV = 'GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const shortHash = (hex) => (typeof hex === 'string' ? hex.slice(0, 12) : null)

function envOff(name) {
    const raw = (process.env[name] || '').trim().toLowerCase()
    return raw !== '' && OFF_VALUES.has(raw)
}

export function bundleDriftIntervalMs() {
    const seconds = Number((process.env[INTERVAL_ENV] || '').trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : DEFAULT_INTERVAL_MS
}

function isBundle(bytes) {
    if (!bytes || bytes.length === 0) return false
    if (!bytes.subarray(0, BUNDLE_SHEBANG.length).toString('utf8').startsWith(BUNDLE_SHEBANG)) return false
    return BUNDLE_VERSION_ASSIGNMENT.test(bytes.toString('utf8'))
}

export function bundleEntryPath() {
    return canonicalEntryPath(launchedEntryPath())
}

let running = null

export function runningBundle() {
    if (running) return running
    const path = bundleEntryPath()
    let bytes = null
    let readError = null
    try {
        bytes = readFileSync(path)
    } catch (error) {
        // The errno is kept so a drift refusal can say why the running bundle could not be read.
        readError = error?.code ?? 'unknown'
        bytes = null
    }
    if (readError !== null) appendDiagnostic('bundle-running-unreadable', { path, code: readError })
    running = {
        path,
        version: BUNDLE_VERSION,
        sha256: bytes ? sha256(bytes) : null,
        bundled: bytes ? isBundle(bytes) : false,
        readable: bytes !== null,
        read_error: readError,
    }
    return running
}

let installed = { size: -1, mtimeMs: -1, sha256: null, version: null }

export function installedBundle() {
    const path = serverEntryPath()
    let stat = null
    try {
        stat = statSync(path)
    } catch {
        return null
    }
    if (stat.size === installed.size && stat.mtimeMs === installed.mtimeMs && installed.path === path && installed.sha256) return installed
    let bytes = null
    try {
        bytes = readFileSync(path)
    } catch {
        return null
    }
    installed = {
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: sha256(bytes),
        version: parseBundleVersion(bytes),
        bundled: isBundle(bytes),
    }
    return installed
}

export function reloadDisabled() {
    return envOff(RELOAD_ENV)
}

function reloadRefusal(runningState, installedState) {
    if (!runningState.readable) return { code: 'running-bundle-unreadable', reason: `this process cannot re-read the file it launched from (${runningState.path})` }
    if (!runningState.bundled) return { code: 'running-not-a-bundle', reason: `this process is running from ${runningState.path}, which is not a single-file bundle, so a reload would restart it on every edit` }
    if (!installedState.bundled) return { code: 'installed-not-a-bundle', reason: `${installedState.path} is not a single-file bundle` }
    if (!installedState.version) return { code: 'installed-version-unknown', reason: `${installedState.path} carries no BUNDLE_VERSION assignment, so it cannot be proven newer than the running ${runningState.version}` }
    if (compareVersions(installedState.version, runningState.version) < 0) {
        return { code: 'no-downgrade', reason: `${installedState.path} carries ${installedState.version} and this process is running ${runningState.version} -- a reload may not move backwards` }
    }
    if (reloadDisabled()) return { code: 'reload-disabled', reason: `${RELOAD_ENV} turns bundle reload off, so this process only reports the staleness` }
    return { code: null, reason: null }
}

let servingTransport = null

// Transports whose drift watch wires a handover in index.js: http replaces its listener, stdio hands over to the HTTP
// singleton, and a stdio relay exits when idle. A stale process on one of these is reloadable, so the no-handover refusal
// is only for a transport with no handover (gm-stale-bundle-stdio-relay-handover-1018).
const HANDOVER_TRANSPORTS = new Set(['http', 'stdio', 'stdio-relay'])

export function setServingTransport(kind) {
    servingTransport = kind
}

// The transport this process serves: 'stdio' unless index.js started the HTTP server.
export function servingTransportKind() {
    return normalizeTransport(servingTransport)
}

// The transport arrives from setServingTransport or a caller, in any case or padding. It is compared against
// HANDOVER_TRANSPORTS by exact string, so it is normalised first; an unset value is stdio.
function normalizeTransport(value) {
    const raw = (typeof value === 'string' ? value : '').trim().toLowerCase()
    return raw === '' ? 'stdio' : raw
}

export function bundleDrift({ transport } = {}) {
    const kind = normalizeTransport(transport ?? servingTransport)
    const runningState = runningBundle()
    const installedState = installedBundle()
    const base = {
        watching: runningState.bundled && installedState !== null,
        path: runningState.path,
        running_version: runningState.version,
        running_sha256: runningState.sha256,
        installed_path: installedState?.path ?? null,
        installed_version: installedState?.version ?? null,
        installed_sha256: installedState?.sha256 ?? null,
    }
    if (!installedState) return { ...base, stale: false, reloadable: false, refusal: { code: 'installed-bundle-absent', reason: `${runningState.path} is not readable` } }
    const stale = runningState.sha256 !== installedState.sha256
    if (!stale) return { ...base, stale: false, reloadable: false, refusal: null }
    const refused = reloadRefusal(runningState, installedState)
    const unhanded = refused.code === null && !HANDOVER_TRANSPORTS.has(kind)
        ? { code: 'no-handover', reason: `a ${kind} server cannot replace itself without dropping its client, so a relaunch serves the installed bundle` }
        : refused
    const refusal = (unhanded.code === null ? handoverRefusalFor(installedState.sha256) : null) ?? unhanded
    return {
        ...base,
        stale: true,
        reloadable: refusal.code === null,
        refusal_code: refusal.code,
        refusal_reason: refusal.reason,
        one_command: refusal.code === null ? null : `restart the gm MCP client (or reconnect the gm MCP server) so it relaunches from ${installedState.path}`,
    }
}

// The last handover attempt for one installed bundle. A failed or deferred handover did not reload, so drift must stop
// reporting that bundle as reloadable until a later handover for the same bundle succeeds.
let handoverRefusal = null

export function recordHandoverRefusal(installedSha256, outcome, reason) {
    handoverRefusal = { installedSha256, code: `handover-${outcome}`, reason: reason ?? outcome }
}

function handoverRefusalFor(installedSha256) {
    if (!handoverRefusal || handoverRefusal.installedSha256 !== installedSha256) return null
    return { code: handoverRefusal.code, reason: handoverRefusal.reason }
}

// Each drift pair (running sha, installed sha, transport) this process has acted on. 'detected' is logged once and stays
// retriable while a handover may still succeed (a deferred one); 'settled' and 'reconnect-needed' are final. A final pair
// is neither logged nor acted on again, and a new installed sha is a new pair.
const driftPairs = new Map()

function driftPairKey(state, transport) {
    return [normalizeTransport(transport ?? servingTransport), state.running_sha256, state.installed_sha256].join('|')
}

export function recordDriftPair(state, transport, status) {
    driftPairs.set(driftPairKey(state, transport), status)
}

export function bundleStalenessLine(state = bundleDrift()) {
    if (!state?.stale) return null
    const installedPath = state.installed_path ?? state.path
    const installed = `${state.installed_version ?? 'unknown version'} (sha ${shortHash(state.installed_sha256)})`
    const running = `${state.running_version} (sha ${shortHash(state.running_sha256)})`
    const action = state.reloadable
        ? 'reloading between dispatches now'
        : `restart required (${state.refusal_reason}): restart the MCP client that launched this server (or reconnect the gm MCP server) so it relaunches from ${installedPath}`
    const runningPath = state.path && state.path !== installedPath ? ` (serving from ${state.path})` : ''
    return `gm-mcp: this server is serving bundle ${running}${runningPath} but ${installed} is installed at ${installedPath} -- ${action}`
}

export function bundleStalenessNotice(state = bundleDrift()) {
    return bundleStalenessAnnouncement(state)
}

const announcedBundles = new Set()

export function bundleStalenessAnnouncement(state = bundleDrift()) {
    if (!state?.stale) return null
    const key = `${state.installed_sha256 ?? ''}|${state.refusal_code ?? ''}|${state.running_sha256 ?? ''}`
    if (announcedBundles.has(key)) return null
    announcedBundles.add(key)
    return bundleStalenessLine(state)
}

export function bundleHealthBlock(state = bundleDrift()) {
    return {
        path: state.path,
        running_version: state.running_version,
        running_sha256: shortHash(state.running_sha256),
        installed_version: state.installed_version,
        installed_sha256: shortHash(state.installed_sha256),
        stale: state.stale === true,
        reloadable: state.reloadable === true,
        refusal: state.refusal_code ?? null,
    }
}

export function startBundleDriftWatch(onDrift, { intervalMs = bundleDriftIntervalMs(), transport } = {}) {
    runningBundle()
    let checking = false
    const tick = async () => {
        if (checking) return
        checking = true
        try {
            const state = bundleDrift({ transport })
            if (state.stale) {
                const pair = driftPairKey(state, transport)
                const status = driftPairs.get(pair)
                if (status === 'settled' || status === 'reconnect-needed') return
                if (status === undefined) {
                    appendDiagnostic('bundle-drift-detected', state)
                    driftPairs.set(pair, 'detected')
                }
                await onDrift(state)
            }
        } catch (error) {
            appendDiagnostic('bundle-drift-check-failed', { error: error?.message ? String(error.message) : String(error) })
        } finally {
            checking = false
        }
    }
    const first = setTimeout(() => { void tick() }, Math.min(intervalMs, FIRST_CHECK_DELAY_MS))
    first.unref?.()
    const timer = setInterval(() => { void tick() }, intervalMs)
    timer.unref?.()
    return () => {
        clearTimeout(first)
        clearInterval(timer)
    }
}
