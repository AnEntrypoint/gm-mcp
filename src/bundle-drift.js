// A running gm-mcp process is a snapshot of the bundle file it was launched from: node read that
// file once, and nothing in this process re-reads it. So when something installs a newer bundle
// over that path -- a lane build, dev-sync, the release channel -- the process keeps answering with
// its own boot-time code and says nothing about it. That is the staleness this module measures,
// against the one authority that matters: the bytes now on disk at the path this process launched
// from. The release-channel check in self-update.js cannot see it, because that one compares the
// deployed file against a URL and answers "current" whenever the two agree, whatever this process
// happens to be running.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { BUNDLE_VERSION } from './bundle-version.js'
import { compareVersions, parseBundleVersion } from './self-update.js'
import { launchedEntryPath } from './singleton.js'
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

// An off value turns the switch off; unset or anything else leaves it on. The OFF_VALUES set exists
// for exactly this, and both README.md and AGENTS.md document `=0` as "turn every reload off".
function envOff(name) {
    const raw = (process.env[name] || '').trim().toLowerCase()
    return raw !== '' && OFF_VALUES.has(raw)
}

export function bundleDriftIntervalMs() {
    const seconds = Number((process.env[INTERVAL_ENV] || '').trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : DEFAULT_INTERVAL_MS
}

// Only a single-file bundle is watcheable. A process running from src/ is a dev checkout whose
// entry file changes on every edit, and reloading it would restart on every save.
function isBundle(bytes) {
    if (!bytes || bytes.length === 0) return false
    if (!bytes.subarray(0, BUNDLE_SHEBANG.length).toString('utf8').startsWith(BUNDLE_SHEBANG)) return false
    return BUNDLE_VERSION_ASSIGNMENT.test(bytes.toString('utf8'))
}

export function bundleEntryPath() {
    return launchedEntryPath()
}

let running = null

export function runningBundle() {
    if (running) return running
    const path = bundleEntryPath()
    let bytes = null
    try {
        bytes = readFileSync(path)
    } catch {
        bytes = null
    }
    running = {
        path,
        version: BUNDLE_VERSION,
        sha256: bytes ? sha256(bytes) : null,
        bundled: bytes ? isBundle(bytes) : false,
        readable: bytes !== null,
    }
    return running
}

let installed = { size: -1, mtimeMs: -1, sha256: null, version: null }

// Hashing a ~1 MB bundle costs a few ms, and the drift watch runs forever, so the hash is taken
// only when the file's size or mtime actually moved -- the same file stat'd twice is free.
export function installedBundle() {
    const path = bundleEntryPath()
    let stat = null
    try {
        stat = statSync(path)
    } catch {
        return null
    }
    if (stat.size === installed.size && stat.mtimeMs === installed.mtimeMs && installed.sha256) return installed
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

// A reload is a process replacement, so it may only move to a bundle this one can prove is not
// older than itself. Anything that cannot be proven is reported as stale and left alone: serving
// old code loudly beats replacing this process with worse code. A stdio server is not exempt -- see
// handOverStdioToRefreshedBundle in bundle-refresh.js, which keeps this process as the client's peer
// and moves the serving onto a child, so the transport is no longer a reason to refuse.
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

export function bundleDrift({ transport = process.env.GM_MCP_TRANSPORT || 'stdio' } = {}) {
    const runningState = runningBundle()
    const installedState = installedBundle()
    const base = {
        watching: runningState.bundled && installedState !== null,
        path: runningState.path,
        running_version: runningState.version,
        running_sha256: runningState.sha256,
        installed_version: installedState?.version ?? null,
        installed_sha256: installedState?.sha256 ?? null,
    }
    if (!installedState) return { ...base, stale: false, reloadable: false, refusal: { code: 'installed-bundle-absent', reason: `${runningState.path} is not readable` } }
    const stale = runningState.sha256 !== installedState.sha256
    if (!stale) return { ...base, stale: false, reloadable: false, refusal: null }
    const refusal = reloadRefusal(runningState, installedState)
    return {
        ...base,
        stale: true,
        reloadable: refusal.code === null,
        refusal_code: refusal.code,
        refusal_reason: refusal.reason,
    }
}

export function bundleStalenessLine(state = bundleDrift()) {
    if (!state?.stale) return null
    const installed = `${state.installed_version ?? 'unknown version'} (sha ${shortHash(state.installed_sha256)})`
    const running = `${state.running_version} (sha ${shortHash(state.running_sha256)})`
    const action = state.reloadable
        ? 'reloading between dispatches now'
        : `not reloading -- ${state.refusal_reason}`
    return `gm-mcp: this server is serving bundle ${running} but ${installed} is installed at ${state.path} -- ${action}`
}

// The line is a fact about this process, not about the dispatch it rides on: the same four lines
// appended to every reply of a session is a per-verb tax that says nothing new after the first one.
// One notice per installed bundle per process, re-armed only when the installed bundle itself moves.
const noticedBundles = new Set()

export function bundleStalenessNotice(state = bundleDrift()) {
    if (!state?.stale) return null
    const key = `${state.installed_sha256 ?? ''}|${state.refusal_code ?? ''}|${state.running_sha256 ?? ''}`
    if (noticedBundles.has(key)) return null
    noticedBundles.add(key)
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

// A reload only ever happens between dispatches (see bundle-refresh.js), so a watcher tick that
// lands mid-dispatch reports "deferred" and the next tick tries again.
export function startBundleDriftWatch(onDrift, { intervalMs = bundleDriftIntervalMs(), transport } = {}) {
    let checking = false
    const tick = async () => {
        if (checking) return
        checking = true
        try {
            const state = bundleDrift({ transport })
            if (state.stale) {
                appendDiagnostic('bundle-drift-detected', state)
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
