import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendDiagnostic, describeError } from './server-log.js'

const SYNC_INTERVAL_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 60_000
const EXCLUDED_FROM_DIRTY = ['.', ':!.gm', ':!.agentplug*']

function stampPath() {
    return path.join(homedir(), '.agentplug', 'dev-sync-stamp.json')
}

function logPath() {
    return path.join(homedir(), '.agentplug', 'dev-sync.log')
}

function readStamps() {
    try {
        return JSON.parse(readFileSync(stampPath(), 'utf8'))
    } catch {
        return {}
    }
}

function git(cwd, args, timeout = GIT_TIMEOUT_MS) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, windowsHide: true })
    return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || result.error?.message || '').trim() }
}

function submodulePaths(root) {
    const file = path.join(root, '.gitmodules')
    if (!existsSync(file)) return []
    return [...readFileSync(file, 'utf8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1])
}

function syncOne(dir) {
    const rel = path.basename(dir)
    const fetched = git(dir, ['fetch', 'origin', '--prune', '--quiet'], FETCH_TIMEOUT_MS)
    if (!fetched.ok) return { repo: rel, action: 'fetch-failed', detail: fetched.err }
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch.ok || branch.out !== 'main') return { repo: rel, action: 'skipped-not-main', detail: branch.out }
    const dirty = git(dir, ['status', '--porcelain', '--', ...EXCLUDED_FROM_DIRTY])
    if (!dirty.ok) return { repo: rel, action: 'skipped-status-failed', detail: dirty.err }
    if (dirty.out) return { repo: rel, action: 'skipped-dirty', detail: `${dirty.out.split('\n').length} changed path(s); left untouched` }
    const local = git(dir, ['rev-parse', 'HEAD'])
    const remote = git(dir, ['rev-parse', 'origin/main'])
    if (!local.ok || !remote.ok) return { repo: rel, action: 'skipped-no-origin-main', detail: remote.err || local.err }
    if (local.out === remote.out) return { repo: rel, action: 'up-to-date', detail: local.out.slice(0, 9) }
    const behind = git(dir, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
    if (!behind.ok) return { repo: rel, action: 'skipped-diverged', detail: `local ${local.out.slice(0, 9)} is not an ancestor of origin/main` }
    const merged = git(dir, ['merge', '--ff-only', '--quiet', 'origin/main'])
    if (!merged.ok) return { repo: rel, action: 'ff-failed', detail: merged.err }
    return { repo: rel, action: 'fast-forwarded', detail: `${local.out.slice(0, 9)} -> ${remote.out.slice(0, 9)}` }
}

export function runDevSync(root) {
    const dirs = submodulePaths(root).map((p) => path.join(root, p)).filter((d) => existsSync(d))
    const results = dirs.map((dir) => {
        try {
            return syncOne(dir)
        } catch (error) {
            return { repo: path.basename(dir), action: 'error', detail: describeError(error) }
        }
    })
    const report = { root, ts: Date.now(), results }
    try {
        mkdirSync(path.dirname(logPath()), { recursive: true })
        appendFileSync(logPath(), `${JSON.stringify(report)}\n`, 'utf8')
    } catch {
    }
    appendDiagnostic('dev-sync', { root, changed: results.filter((r) => r.action === 'fast-forwarded').length, skipped: results.filter((r) => r.action.startsWith('skipped')).length })
    return report
}

function serverEntry() {
    const argv1 = process.argv[1]
    if (argv1 && /\.(mjs|cjs|js)$/i.test(argv1) && existsSync(argv1)) return path.resolve(argv1)
    return fileURLToPath(import.meta.url)
}

// Runs on dispatch, so a dispatch never waits on git. The stamp is per project and
// written before the child starts, so concurrent dispatches cannot start a second sync.
export function maybeStartDevSync(root) {
    if ((process.env.GM_MCP_DEV_SYNC || '').trim() === '0') return false
    const stamps = readStamps()
    const last = Number(stamps[root]) || 0
    if (Date.now() - last < SYNC_INTERVAL_MS) return false
    stamps[root] = Date.now()
    try {
        mkdirSync(path.dirname(stampPath()), { recursive: true })
        writeFileSync(stampPath(), JSON.stringify(stamps), 'utf8')
    } catch {
        return false
    }
    const child = spawn(process.execPath, [serverEntry(), 'dev-sync', '--root', root], {
        cwd: homedir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    })
    child.on('error', (error) => appendDiagnostic('dev-sync-spawn-error', { root, error: describeError(error) }))
    child.unref()
    return true
}
