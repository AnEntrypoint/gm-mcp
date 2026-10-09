import { spawnSync } from 'node:child_process'
import path from 'node:path'

const GIT_TIMEOUT_MS = 60_000

export function runGit(cwd, args, timeout = GIT_TIMEOUT_MS) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, windowsHide: true })
    return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || result.error?.message || '').trim() }
}

export function gitToplevel(dir) {
    const top = runGit(dir, ['rev-parse', '--show-toplevel'])
    return top.ok && top.out ? path.resolve(top.out) : null
}
