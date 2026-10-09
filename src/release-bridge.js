import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { compareVersions, selfUpdateFreezeReason } from './self-update.js'
import { agentplugDir, toolsDir } from './paths.js'
import { inflightDispatchCount, pidAlive } from './dispatch.js'
import { appendDiagnostic } from './server-log.js'

const RUNNER_REPO = 'AnEntrypoint/agentplug-bin'
const GUEST_REPO = 'AnEntrypoint/plugkit-bin'
const GUEST_ASSET = 'plugkit-slim.wasm'
const INSTALLED_GUEST_FILE = 'gm.wasm'
const GUEST_DIR = 'plugins'
const STATE_FILE = 'gm-mcp-release-bridge.json'
const LOCK_FILE = 'gm-mcp-release-bridge.lock'
const RUNNER_PIN_FILE = 'agentplug-runner.local-build.json'
const RUNNER_FREEZE_FILE = 'agentplug-runner.no-self-update'
const RUNNER_FREEZE_ENV = 'AGENTPLUG_NO_SELF_UPDATE'
const GUEST_SIDELOAD_FILE = 'gm.local-dev-sideload.json'
const GUEST_BUILD_FILE = 'gm.build.json'
const RUNNER_VERSION_FILE = 'agentplug-runner.version'
const LAST_RUNNER_SWAP_FILE = 'last-completed-runner-swap.json'
const SOURCE_HEAD_LINE = /^source-head:\s*([0-9a-f]{7,40})\s*$/im
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000
const LOCK_STALE_MS = 15 * 60 * 1000
const API_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 180_000
const PROBE_TIMEOUT_MS = 20_000
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]
const SEMVER = /^\d+\.\d+\.\d+$/
const RELEASE_TAG = /^v?(\d+\.\d+\.\d+)$/
const execFileAsync = promisify(execFile)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

function readText(file) {
    try {
        return readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

function writeAtomic(file, text) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
        writeFileSync(temp, text, { flag: 'wx' })
        renameSync(temp, file)
    } catch (error) {
        rmSync(temp, { force: true })
        throw error
    }
}

function writeAtomicIfChanged(file, text) {
    if (readText(file) === text) return false
    writeAtomic(file, text)
    return true
}

function runnerFileName() {
    return process.platform === 'win32' ? 'agentplug-runner.exe' : 'agentplug-runner'
}

export function runnerAssetName(platform = process.platform, arch = process.arch) {
    const os = { linux: 'linux', darwin: 'macos', win32: 'windows' }[platform]
    const cpu = { x64: 'x64', arm64: 'arm64' }[arch]
    if (!os || !cpu) return null
    return os === 'windows' ? `agentplug-runner-windows-${cpu}.exe` : `agentplug-runner-${os}-${cpu}`
}

export function parseReleaseTag(tag) {
    const found = RELEASE_TAG.exec(String(tag ?? '').trim())
    return found ? found[1] : null
}

export function parseSha256Sidecar(text) {
    const token = String(text ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    return /^[0-9a-f]{64}$/.test(token) ? token : null
}

function assertReleaseAssetUrl(url, repo) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(`/${repo}/releases/download/`)) {
        throw new Error(`refusing a release asset outside ${repo}: ${url}`)
    }
    return parsed.href
}

async function fetchLatestRelease(repo) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gm-mcp-release-bridge' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${repo} releases/latest`)
    const body = await response.json()
    const tag = body && typeof body === 'object' ? body.tag_name : undefined
    const version = parseReleaseTag(tag)
    if (!version) throw new Error(`${repo} latest tag ${JSON.stringify(tag)} is not X.Y.Z`)
    return { repo, version, assets: Array.isArray(body.assets) ? body.assets : [], body: typeof body?.body === 'string' ? body.body : '' }
}

function publishedDigest(release, assetName) {
    const digest = release.assets.find((candidate) => candidate.name === assetName)?.digest
    return typeof digest === 'string' && digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null
}

export function sourceHeadOf(body) {
    const found = SOURCE_HEAD_LINE.exec(typeof body === 'string' ? body : '')
    return found ? found[1].toLowerCase() : null
}

function runnerSwapRecorded(version, installedSha) {
    const home = agentplugDir()
    const record = readJson(path.join(home, LAST_RUNNER_SWAP_FILE))
    return record?.version === version && record?.sha256 === installedSha && readText(path.join(home, RUNNER_VERSION_FILE))?.trim() === version
}

function recordRunnerSwap(version, installedSha) {
    const home = agentplugDir()
    mkdirSync(home, { recursive: true })
    writeAtomic(path.join(home, RUNNER_VERSION_FILE), version)
    writeAtomic(path.join(home, LAST_RUNNER_SWAP_FILE), `${JSON.stringify({ version, swapped_at_ts: Date.now(), sha256: installedSha })}\n`)
}

function recordGuestBuild(dir, release, wasmSha256, wasmBytes) {
    writeAtomic(path.join(dir, GUEST_BUILD_FILE), `${JSON.stringify({
        plugin: 'gm',
        version: release.version,
        source_sha: sourceHeadOf(release.body),
        wasm_sha256: wasmSha256,
        wasm_bytes: wasmBytes,
        installed_at: Math.floor(Date.now() / 1000),
        origin: 'release',
    })}\n`)
}

function reconcileGuestBuildRecord(dir, wasmPath, release) {
    const published = publishedDigest(release, GUEST_ASSET)
    if (!published || !existsSync(wasmPath)) return
    const installed = readFileSync(wasmPath)
    const installedSha = sha256(installed)
    if (installedSha !== published) return
    const current = readJson(path.join(dir, GUEST_BUILD_FILE))
    if (current?.version === release.version && current?.wasm_sha256 === installedSha && current?.source_sha === sourceHeadOf(release.body)) return
    recordGuestBuild(dir, release, installedSha, installed.length)
}

function releaseAssetUrl(release, name) {
    const asset = release.assets.find((candidate) => candidate.name === name)
    if (!asset) throw new Error(`release ${release.version} of ${release.repo} has no ${name} asset`)
    return assertReleaseAssetUrl(asset.browser_download_url, release.repo)
}

async function download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
    return Buffer.from(await response.arrayBuffer())
}

async function fetchVerified(release, assetName) {
    const expected = parseSha256Sidecar((await download(releaseAssetUrl(release, `${assetName}.sha256`))).toString('utf8'))
    if (!expected) throw new Error(`${assetName}.sha256 is not a sha256 sidecar`)
    const bytes = await download(releaseAssetUrl(release, assetName))
    const actual = sha256(bytes)
    if (actual !== expected) throw new Error(`${assetName} sha256 ${actual} does not match its sidecar ${expected}`)
    return { bytes, sha256: actual }
}

export async function probeRunner(file) {
    try {
        const { stdout } = await execFileAsync(file, ['--build-info'], { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS })
        const doc = JSON.parse(stdout)
        if (typeof doc.version !== 'string') return null
        return { version: doc.version, release_build: doc.release_build === true }
    } catch {
        return null
    }
}

function swapIn(target, candidate, backupLabel) {
    try {
        let backup = null
        if (existsSync(target)) {
            backup = `${target}.${backupLabel}-${stamp()}`
            if (existsSync(backup)) throw new Error(`backup ${backup} already exists; refusing to overwrite it`)
            renameSync(target, backup)
        }
        try {
            renameSync(candidate, target)
        } catch (error) {
            if (backup) renameSync(backup, target)
            throw error
        }
        return backup
    } catch (error) {
        rmSync(candidate, { force: true })
        throw error
    }
}

export function bridgeFreezeReason() {
    const gmMcp = selfUpdateFreezeReason()
    if (gmMcp) return gmMcp
    const envValue = process.env[RUNNER_FREEZE_ENV]
    if (envValue !== undefined && !OFF_VALUES.has(envValue.trim().toLowerCase())) {
        return `${RUNNER_FREEZE_ENV}=${JSON.stringify(envValue)} freezes runner updates`
    }
    const marker = path.join(agentplugDir(), RUNNER_FREEZE_FILE)
    if (existsSync(marker)) return `${marker} exists, which freezes runner updates`
    return null
}

async function reconcileRunner(release) {
    const asset = runnerAssetName()
    if (!asset) return { outcome: 'skipped', reason: `no runner asset for ${process.platform}-${process.arch}` }
    const runnerPath = path.join(toolsDir(), runnerFileName())
    if (!existsSync(runnerPath)) return { outcome: 'skipped', reason: 'runner-not-installed' }
    const installed = await probeRunner(runnerPath)
    if (!installed) return { outcome: 'skipped', reason: 'installed-version-unknown' }
    if (!installed.release_build) return { outcome: 'skipped', reason: 'local-build' }
    if (compareVersions(release.version, installed.version) <= 0) {
        const liveSha = sha256(readFileSync(runnerPath))
        if (liveSha === publishedDigest(release, asset) && !runnerSwapRecorded(installed.version, liveSha)) recordRunnerSwap(installed.version, liveSha)
        return { outcome: 'current', version: installed.version }
    }
    if (readJson(path.join(agentplugDir(), 'daemon-status.json'))?.runner_update_in_progress) {
        return { outcome: 'deferred', reason: 'runner-update-in-progress' }
    }
    const installedSha = sha256(readFileSync(runnerPath))
    if (readJson(path.join(agentplugDir(), RUNNER_PIN_FILE))?.sha256 === installedSha) {
        return { outcome: 'refused', reason: 'local-build-pinned', installed_sha256: installedSha }
    }

    const { bytes, sha256: newSha } = await fetchVerified(release, asset)
    const candidate = path.join(toolsDir(), `${runnerFileName()}.bridge-${process.pid}-${Date.now()}.new`)
    writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o755 })
    try {
        const staged = await probeRunner(candidate)
        if (!staged || staged.version !== release.version || !staged.release_build) {
            throw new Error(`staged runner reports ${JSON.stringify(staged)}, expected release build ${release.version}`)
        }
    } catch (error) {
        rmSync(candidate, { force: true })
        throw error
    }
    const backup = swapIn(runnerPath, candidate, `bak-${installed.version}`)
    recordRunnerSwap(release.version, newSha)
    return { outcome: 'swapped', from: installed.version, to: release.version, sha256: newSha, previous_sha256: installedSha, backup }
}

async function reconcileGuest(release) {
    const dir = path.join(agentplugDir(), GUEST_DIR)
    const wasmPath = path.join(dir, INSTALLED_GUEST_FILE)
    const versionPath = path.join(dir, 'gm.version')
    if (existsSync(path.join(dir, GUEST_SIDELOAD_FILE))) return { outcome: 'skipped', reason: 'local-dev-sideload' }
    const recorded = readText(versionPath)?.trim() ?? null
    if (recorded !== null && !SEMVER.test(recorded)) return { outcome: 'skipped', reason: 'local-dev-sideload', recorded }
    if (existsSync(wasmPath) && recorded === null) return { outcome: 'skipped', reason: 'installed-version-unknown' }
    if (recorded !== null && compareVersions(release.version, recorded) <= 0) {
        reconcileGuestBuildRecord(dir, wasmPath, release)
        return { outcome: 'current', version: recorded }
    }

    const { bytes, sha256: newSha } = await fetchVerified(release, GUEST_ASSET)
    if (!WASM_MAGIC.every((byte, index) => bytes[index] === byte)) throw new Error(`${GUEST_ASSET} is not a wasm module`)
    mkdirSync(dir, { recursive: true })
    const candidate = `${wasmPath}.bridge-${process.pid}-${Date.now()}.tmp`
    writeFileSync(candidate, bytes, { flag: 'wx' })
    const backup = swapIn(wasmPath, candidate, `bak-${recorded ?? 'unversioned'}`)
    writeAtomic(versionPath, release.version)
    recordGuestBuild(dir, release, newSha, bytes.length)
    return { outcome: 'swapped', from: recorded, to: release.version, sha256: newSha, backup }
}

function processIsRunner(pid) {
    if (!existsSync('/proc/self/exe')) return true
    try {
        return path.basename(readlinkSync(`/proc/${pid}/exe`)).startsWith('agentplug-runner')
    } catch {
        return false
    }
}

export function signalDaemonForSwap(want) {
    const home = agentplugDir()
    const status = readJson(path.join(home, 'daemon-status.json'))
    const pid = Number(status?.pid)
    if (!Number.isInteger(pid) || pid <= 0) return { outcome: 'no-daemon' }
    const ownerText = readText(path.join(home, 'daemon-owner.lock'))?.trim()
    if (ownerText && Number(ownerText) !== pid) return { outcome: 'refused', reason: 'daemon-owner.lock names a different pid than daemon-status.json', pid }
    if (pidAlive(pid) !== true) return { outcome: 'no-daemon', pid }

    const runnerCurrent = want.exe_sha256 == null || status.runner_version_parity?.exe_sha256 === want.exe_sha256
    const guestCurrent = want.gm_sha256 == null || status.loaded_plugin_content_sha256?.gm === want.gm_sha256
    if (runnerCurrent && guestCurrent) return { outcome: 'already-current', pid }
    if (status.runner_update_in_progress) return { outcome: 'deferred', reason: 'runner-update-in-progress', pid }
    if (inflightDispatchCount() > 0) return { outcome: 'deferred', reason: 'dispatch-in-flight', pid }
    if (!processIsRunner(pid)) return { outcome: 'refused', reason: 'pid is not an agentplug-runner process', pid }
    process.kill(pid, 'SIGTERM')
    return { outcome: 'signalled', pid, signal: 'SIGTERM' }
}

function acquireLock() {
    const lockPath = path.join(agentplugDir(), LOCK_FILE)
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = openSync(lockPath, 'wx', 0o600)
            try {
                writeFileSync(fd, `${process.pid} ${Date.now()}`, 'utf8')
            } finally {
                closeSync(fd)
            }
            return lockPath
        } catch (error) {
            if (error?.code !== 'EEXIST') return null
        }
        const holder = Number.parseInt((readText(lockPath) ?? '').trim().split(/\s+/)[0], 10)
        let ageMs
        try {
            ageMs = Date.now() - statSync(lockPath).mtimeMs
        } catch {
            continue
        }
        if (pidAlive(holder) === true && ageMs < LOCK_STALE_MS) return null
        try {
            const stalePath = `${lockPath}.${process.pid}.${Date.now()}.stale`
            renameSync(lockPath, stalePath)
            rmSync(stalePath, { force: true })
        } catch {
            return null
        }
    }
    return null
}

export async function runReleaseBridge() {
    if ((process.env.GM_MCP_RELEASE_BRIDGE || '').trim() === '0') return { outcome: 'disabled' }
    const frozen = bridgeFreezeReason()
    if (frozen) return { outcome: 'frozen', reason: frozen }

    mkdirSync(agentplugDir(), { recursive: true })
    const lockPath = acquireLock()
    if (!lockPath) return { outcome: 'busy' }
    try {
        const statePath = path.join(agentplugDir(), STATE_FILE)
        const state = readJson(statePath) ?? {}
        if (state.pending_signal) {
            const pending = state.pending_signal
            const signal = signalDaemonForSwap(pending.want)
            if (signal.outcome !== 'deferred') state.pending_signal = null
            if (signal.outcome === 'signalled') appendDiagnostic('release-bridge-signal', { ...signal, want: pending.want })
        }

        const intervalMs = Number(process.env.GM_MCP_RELEASE_BRIDGE_INTERVAL_MS) > 0
            ? Number(process.env.GM_MCP_RELEASE_BRIDGE_INTERVAL_MS)
            : DEFAULT_INTERVAL_MS
        const lastChecked = Number(state.last_checked_ts) || 0
        if (Date.now() - lastChecked < intervalMs) {
            writeAtomicIfChanged(statePath, `${JSON.stringify(state, null, 2)}\n`)
            return { outcome: 'checked-recently', next_check_ms: intervalMs - (Date.now() - lastChecked) }
        }
        writeAtomic(statePath, `${JSON.stringify({ ...state, last_checked_ts: Date.now() }, null, 2)}\n`)

        let runner
        try {
            runner = await reconcileRunner(await fetchLatestRelease(RUNNER_REPO))
        } catch (error) {
            runner = { outcome: 'failed', error: error?.message ?? String(error) }
        }
        let guest
        try {
            guest = await reconcileGuest(await fetchLatestRelease(GUEST_REPO))
        } catch (error) {
            guest = { outcome: 'failed', error: error?.message ?? String(error) }
        }

        let signal = null
        if (runner.outcome === 'swapped' || guest.outcome === 'swapped') {
            const runnerSha = runner.outcome === 'swapped' ? runner.sha256 : null
            const want = { exe_sha256: runnerSha, gm_sha256: guest.outcome === 'swapped' ? guest.sha256 : null }
            signal = signalDaemonForSwap(want)
            state.pending_signal = signal.outcome === 'deferred' ? { want, ts: Date.now(), reason: signal.reason } : null
        }
        const summary = { outcome: 'checked', runner, guest, signal }
        writeAtomic(statePath, `${JSON.stringify({ ...state, last_checked_ts: Date.now(), last_runner: runner, last_guest: guest, last_signal: signal }, null, 2)}\n`)
        appendDiagnostic('release-bridge', summary)
        return summary
    } finally {
        rmSync(lockPath, { force: true })
    }
}

export function runReleaseBridgeInBackground() {
    runReleaseBridge()
        .then((result) => {
            if (result.outcome === 'checked-recently' || result.outcome === 'disabled' || result.outcome === 'frozen' || result.outcome === 'busy') return
            const swapped = [result.runner, result.guest].filter((step) => step?.outcome === 'swapped')
            for (const step of swapped) {
                console.error(`gm-mcp: release bridge swapped ${step === result.runner ? 'agentplug-runner' : 'gm guest plugin'} ${step.from ?? 'unknown'} -> ${step.to} (${step.backup ? `previous kept as ${step.backup}` : 'no previous file existed'})`)
            }
            if (result.signal?.outcome === 'signalled') console.error(`gm-mcp: release bridge signalled the shared daemon pid ${result.signal.pid} to pick up the new build; the next dispatch respawns it`)
        })
        .catch((error) => {
            appendDiagnostic('release-bridge-failed', { error: error?.message ? String(error.message) : String(error) })
            console.error(`gm-mcp: release bridge failed (${error?.message ?? error}); keeping the installed runner and guest`)
        })
}
