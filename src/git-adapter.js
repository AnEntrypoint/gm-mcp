import { spawnSync } from 'node:child_process'
import path from 'node:path'

const GIT_TIMEOUT_MS = 60_000

// gm asks the same repo-layout question -- `rev-parse --show-toplevel` above all -- on every
// MCP call that needs a repo root, and every question is a process spawn. The answer is a pure
// function of the on-disk gitdir layout, so it is answered once per (directory, question) and
// asked again only after a git command that can move that layout runs in a directory sharing a
// path prefix with the cached one. Nothing that gates a write is in the flag list:
// `status --porcelain`, `hash-object` and gating `ls-files` still reach git every time, and
// each of them drops the answers it can invalidate.
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

export function runGit(cwd, args, timeout = GIT_TIMEOUT_MS) {
    const question = layoutQuestion(cwd, args)
    if (question) {
        const cached = layoutCache.get(question.key)
        if (cached) return { ...cached }
    }
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, windowsHide: true })
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
