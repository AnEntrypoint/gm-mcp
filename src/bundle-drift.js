import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { BUNDLE_VERSION } from './bundle-version.js'
import { parseBundleVersion } from './self-update.js'
import { canonicalEntryPath, launchedEntryPath, serverEntryPath } from './singleton.js'
import { appendDiagnostic } from './server-log.js'
import { consolidate } from './triage-verbs.js'

const DEFAULT_INTERVAL_MS = 30_000
const FIRST_CHECK_DELAY_MS = 5_000
const CONSOLIDATE_INTERVAL_MS = 10 * 60_000
const CONSOLIDATE_CLEAN_LINE = /dirty=0 ahead=0 behind=0/
const BUNDLE_SHEBANG = '#!/usr/bin/env node'
const BUNDLE_VERSION_ASSIGNMENT = /BUNDLE_VERSION\s*=\s*["']([^"']+)["']/

const INTERVAL_ENV = 'GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const shortHash = (hex) => (typeof hex === 'string' ? hex.slice(0, 12) : null)

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
        // The errno is kept for the bundle-running-unreadable diagnostic.
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

let servingTransport = null

export function setServingTransport(kind) {
    servingTransport = kind
}

// The transport this process serves: 'stdio' unless index.js started the HTTP server.
export function servingTransportKind() {
    return normalizeTransport(servingTransport)
}

// The transport arrives from setServingTransport or a caller, in any case or padding; an unset value is stdio.
function normalizeTransport(value) {
    const raw = (typeof value === 'string' ? value : '').trim().toLowerCase()
    return raw === '' ? 'stdio' : raw
}

// A running server keeps the bundle it launched with. A newer installed bundle takes effect when the next session starts,
// so drift is reported here and never reloaded or handed over to a child.
export function bundleDrift() {
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
    if (!installedState) return { ...base, stale: false, stale_reason: null, reloadable: false, refusal: { code: 'installed-bundle-absent', reason: `${runningState.path} is not readable` } }
    const stale = runningState.sha256 !== installedState.sha256
    const stale_reason = !stale ? null : installedState.version === runningState.version ? 'sha' : 'version'
    if (!stale) return { ...base, stale: false, stale_reason, reloadable: false, refusal: null }
    return {
        ...base,
        stale: true,
        stale_reason,
        reloadable: false,
        refusal_code: 'no-handover',
        refusal_reason: 'this process keeps the bundle it launched with',
        one_command: `run /mcp and reconnect the gm client so it relaunches from ${installedState.path}`,
    }
}

// Each drift pair (running sha, installed sha, transport) this process has acted on. 'detected' is logged once; 'reconnect-needed'
// is final. A final pair is neither logged nor announced again, and a new installed sha is a new pair.
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
    const runningPath = state.path && state.path !== installedPath ? ` (serving from ${state.path})` : ''
    return `gm-mcp: this server is serving bundle ${running}${runningPath} but ${installed} is installed at ${installedPath} -- restart required (${state.refusal_reason}): run /mcp and reconnect the gm client so it relaunches from ${installedPath}`
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
        stale_reason: state.stale_reason ?? null,
        reloadable: state.reloadable === true,
        refusal: state.refusal_code ?? null,
    }
}

export function startBundleDriftWatch(onDrift, { intervalMs = bundleDriftIntervalMs(), transport, consolidateRoot } = {}) {
    runningBundle()
    let checking = false
    const tick = async () => {
        if (checking) return
        checking = true
        try {
            const state = bundleDrift()
            if (state.stale) {
                const pair = driftPairKey(state, transport)
                const status = driftPairs.get(pair)
                if (status === 'reconnect-needed') return
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
    const stopConsolidate = consolidateRoot ? startConsolidateCheck(consolidateRoot) : () => {}
    return () => {
        clearTimeout(first)
        clearInterval(timer)
        stopConsolidate()
    }
}

// Dry-run consolidate of the served checkout, every CONSOLIDATE_INTERVAL_MS. A checkout that is dirty, ahead or behind of
// origin/main is announced in the diagnostic log. Apply stays an explicit consolidate call, since it resets the checkout.
function startConsolidateCheck(rootOf) {
    let checking = false
    const tick = async () => {
        const root = rootOf()
        if (checking || !root || !existsSync(path.join(root, '.git'))) return
        checking = true
        try {
            const reply = await consolidate({ cwd: root, dry_run: true })
            const drifted = reply.lines.filter((line) => !CONSOLIDATE_CLEAN_LINE.test(line))
            if (reply.exit !== 0 || drifted.length > 0) appendDiagnostic('consolidate-drift', { root, exit: reply.exit, result: reply.result, lines: drifted })
        } catch (error) {
            appendDiagnostic('consolidate-check-failed', { root, error: error?.message ? String(error.message) : String(error) })
        } finally {
            checking = false
        }
    }
    const first = setTimeout(() => { void tick() }, FIRST_CHECK_DELAY_MS)
    first.unref?.()
    const timer = setInterval(() => { void tick() }, CONSOLIDATE_INTERVAL_MS)
    timer.unref?.()
    return () => {
        clearTimeout(first)
        clearInterval(timer)
    }
}
