import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const GIT_TIMEOUT_MS = 60_000
export const INDEX_LOCK_STALE_MS = 60 * 60 * 1000

const LAYOUT_QUESTION_FLAGS = new Set([
    '--show-toplevel',
    '--show-prefix',
    '--show-cdup',
    '--git-dir',
    '--absolute-git-dir',
    '--is-inside-work-tree',
    '--is-inside-git-dir'
])

const LAYOUT_CACHE_MAX_ENTRIES = 512
const layoutCache = new Map()

const layoutDirKey = (dir) => path.resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const layoutDirsOverlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')

function layoutQuestion(cwd, args) {
    let dir = cwd
    let rest = args
    if (args[0] === '-C' && args.length > 2) {
        dir = path.resolve(cwd, args[1])
        rest = args.slice(2)
    }
    if (rest.length !== 2 || rest[0] !== 'rev-parse' || !LAYOUT_QUESTION_FLAGS.has(rest[1])) return null
    const key = layoutDirKey(dir)
    return { dir: key, key: key + '\0' + rest[1] }
}

function forgetLayoutDir(dir) {
    const stale = layoutDirKey(dir)
    for (const key of layoutCache.keys()) {
        if (layoutDirsOverlap(key.split('\0')[0], stale)) layoutCache.delete(key)
    }
}

function spawnGit(cwd, args, timeout) {
    return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, windowsHide: true })
}

export function isIndexLockContention(text) {
    return /index\.lock/i.test(text) && /unable to create|file exists|another git process|could not lock|unable to lock/i.test(text)
}

export function runGit(cwd, args, timeout = GIT_TIMEOUT_MS) {
    const question = layoutQuestion(cwd, args)
    if (question) {
        const cached = layoutCache.get(question.key)
        if (cached) return { ...cached }
    }
    let result = spawnGit(cwd, args, timeout)
    if (result.status !== 0 && isIndexLockContention(`${result.stdout || ''}\n${result.stderr || ''}`) && recoverStaleIndexLock(cwd).state === 'quarantined') {
        result = spawnGit(cwd, args, timeout)
    }
    const answer = { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || result.error?.message || '').trim() }
    if (!question) {
        forgetLayoutDir(cwd)
    } else if (answer.ok) {
        if (layoutCache.size >= LAYOUT_CACHE_MAX_ENTRIES && !layoutCache.has(question.key)) layoutCache.clear()
        layoutCache.set(question.key, answer)
    } else {
        forgetLayoutDir(question.dir)
    }
    return answer
}

export function gitToplevel(dir) {
    const top = runGit(dir, ['rev-parse', '--show-toplevel'])
    return top.ok && top.out ? path.resolve(top.out) : null
}

function gitLayoutOf(dir) {
    let root = path.resolve(dir)
    for (;;) {
        const dotGit = path.join(root, '.git')
        if (fs.existsSync(dotGit)) {
            if (fs.statSync(dotGit).isDirectory()) return { root, gitDir: fs.realpathSync(dotGit) }
            const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
            return pointer ? { root, gitDir: fs.realpathSync(path.resolve(root, pointer[1])) } : null
        }
        const parent = path.dirname(root)
        if (parent === root) return null
        root = parent
    }
}

function holdsFile(pid, file) {
    let fds
    try {
        fds = fs.readdirSync(`/proc/${pid}/fd`)
    } catch {
        return false
    }
    return fds.some((fd) => {
        try {
            return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === file
        } catch {
            return false
        }
    })
}

function indexLockHolders(lock) {
    if (process.platform === 'linux') {
        let pids
        try {
            pids = fs.readdirSync('/proc')
        } catch {
            return null
        }
        return pids.filter((pid) => /^\d+$/.test(pid) && holdsFile(pid, lock))
    }
    if (process.platform === 'darwin') {
        const probe = spawnSync('lsof', ['-t', '--', lock], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
        if (probe.error || (probe.status !== 0 && probe.status !== 1)) return null
        return probe.status === 1 ? [] : probe.stdout.split(/\s+/).filter(Boolean)
    }
    return undefined
}

function holderLabels(holders) {
    if (holders === undefined) return []
    if (holders === null) return ['unknown: this platform cannot list the holders of a file']
    return holders.map((pid) => {
        try {
            const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
            return `pid ${pid} ${cmdline.slice(0, 160)}`.trim()
        } catch {
            return `pid ${pid}`
        }
    })
}

export function recoverStaleIndexLock(dir, { nowMs = Date.now(), staleAfterMs = INDEX_LOCK_STALE_MS } = {}) {
    const layout = gitLayoutOf(dir)
    if (layout === null) return { state: 'no_repo' }
    const lock = path.join(layout.gitDir, 'index.lock')
    let stat
    try {
        stat = fs.lstatSync(lock)
    } catch {
        return { state: 'absent', lock }
    }
    const ageMs = Math.max(0, Math.round(nowMs - stat.mtimeMs))
    const holders = indexLockHolders(lock)
    const base = { lock, size: stat.size, age_ms: ageMs, owners: holderLabels(holders) }
    if (!stat.isFile()) return { state: 'refused', reason: 'not_a_file', ...base }
    if (stat.size !== 0) return { state: 'refused', reason: 'nonempty', ...base }
    if (ageMs < staleAfterMs) return { state: 'refused', reason: 'fresh', ...base }
    if (holders === null || (Array.isArray(holders) && holders.length > 0)) return { state: 'refused', reason: 'held', ...base }
    const quarantineDir = path.join(layout.root, '.gm', 'quarantine', `index-lock-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}`)
    const quarantined = path.join(quarantineDir, 'index.lock')
    try {
        fs.mkdirSync(quarantineDir, { recursive: true })
        fs.renameSync(lock, quarantined)
    } catch (error) {
        return { state: 'refused', reason: 'held', ...base, owners: [...base.owners, `rename failed: ${error.code ?? error.message}`] }
    }
    return { state: 'quarantined', quarantined, ...base }
}
