import { agentplugDir } from './paths.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGit } from './git-adapter.js'
import { appendDiagnostic, describeError } from './server-log.js'

const SYNC_INTERVAL_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 120_000
const EXCLUDED_FROM_DIRTY = ['.', ':!.gm', ':!.agentplug*']
const GLOBAL_STAMP_KEY = '*'

function stampPath() {
    return path.join(agentplugDir(), 'dev-sync-stamp.json')
}

function logPath() {
    return path.join(agentplugDir(), 'dev-sync.log')
}

function readStampText() {
    try {
        return readFileSync(stampPath(), 'utf8')
    } catch {
        return ''
    }
}

function parseStamps(text) {
    try {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function writeStampsIfChanged(stamps, previousText) {
    const next = JSON.stringify(stamps)
    if (next === previousText) return
    mkdirSync(path.dirname(stampPath()), { recursive: true })
    writeFileSync(stampPath(), next, 'utf8')
}

function comparablePath(p) {
    const resolved = path.resolve(p)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isTemporaryProjectRoot(root) {
    const rel = path.relative(comparablePath(tmpdir()), comparablePath(root))
    return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..')
}

function submodulePaths(root) {
    const file = path.join(root, '.gitmodules')
    if (!existsSync(file)) return []
    return [...readFileSync(file, 'utf8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1])
}

function syncOne(dir) {
    const rel = path.basename(dir)
    const fetched = runGit(dir, ['fetch', 'origin', '--prune', '--quiet'], FETCH_TIMEOUT_MS)
    if (!fetched.ok) return { repo: rel, action: 'fetch-failed', detail: fetched.err }
    const branch = runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch.ok || branch.out !== 'main') return { repo: rel, action: 'skipped-not-main', detail: branch.out }
    const dirty = runGit(dir, ['status', '--porcelain', '--ignore-submodules=all', '--', ...EXCLUDED_FROM_DIRTY])
    if (!dirty.ok) return { repo: rel, action: 'skipped-status-failed', detail: dirty.err }
    if (dirty.out) return { repo: rel, action: 'skipped-dirty', detail: `${dirty.out.split('\n').length} changed path(s); left untouched` }
    const local = runGit(dir, ['rev-parse', 'HEAD'])
    const remote = runGit(dir, ['rev-parse', 'origin/main'])
    if (!local.ok || !remote.ok) return { repo: rel, action: 'skipped-no-origin-main', detail: remote.err || local.err }
    if (local.out === remote.out) return { repo: rel, action: 'up-to-date', detail: local.out.slice(0, 9) }
    const behind = runGit(dir, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
    if (!behind.ok) return { repo: rel, action: 'skipped-diverged', detail: `local ${local.out.slice(0, 9)} is not an ancestor of origin/main` }
    const merged = runGit(dir, ['merge', '--ff-only', '--quiet', 'origin/main'])
    if (!merged.ok) return { repo: rel, action: 'ff-failed', detail: merged.err }
    return { repo: rel, action: 'fast-forwarded', detail: `${local.out.slice(0, 9)} -> ${remote.out.slice(0, 9)}` }
}

export function runDevSync(root) {
    const parentThenSubmoduleDirs = [root, ...submodulePaths(root).map((p) => path.join(root, p))].filter((d) => existsSync(d))
    const results = parentThenSubmoduleDirs.map((dir) => {
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
    if (argv1 && /^gm-mcp-server\.(mjs|cjs|js)$/i.test(path.basename(argv1)) && existsSync(argv1)) return path.resolve(argv1)
    const installed = path.join(homedir(), '.gm-tools', 'gm-mcp-server.mjs')
    if (existsSync(installed)) return installed
    return fileURLToPath(import.meta.url)
}

export function maybeStartDevSync(root) {
    if ((process.env.GM_MCP_DEV_SYNC || '').trim() === '0') return false
    if (isTemporaryProjectRoot(root) || !existsSync(path.join(root, '.git'))) return false
    const now = Date.now()
    const stampText = readStampText()
    const stamps = parseStamps(stampText)
    const globalLast = Number(stamps[GLOBAL_STAMP_KEY]) || 0
    const last = Number(stamps[root]) || 0
    if (now - globalLast < SYNC_INTERVAL_MS || now - last < SYNC_INTERVAL_MS) return false
    stamps[GLOBAL_STAMP_KEY] = now
    stamps[root] = now
    try {
        writeStampsIfChanged(stamps, stampText)
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
