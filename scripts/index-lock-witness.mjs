import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isIndexLockContention, recoverStaleIndexLock, runGit } from '../src/git-adapter.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'index-lock-witness-'))
const repo = path.join(scratch, 'repo')
const cases = {}
const check = (name, ok, detail) => {
    cases[name] = { ok: Boolean(ok), detail }
}
const sh = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

try {
    fs.mkdirSync(repo)
    sh(['init', '-q'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    const lock = path.join(repo, '.git', 'index.lock')
    const now = Date.now()
    const oldTime = new Date(now - 2 * 60 * 60 * 1000)

    check('contention_text_matches_git_refusal', isIndexLockContention("fatal: Unable to create '/x/.git/index.lock': File exists.") && !isIndexLockContention('fatal: pathspec did not match any files'), null)

    check('no_lock_is_absent', recoverStaleIndexLock(repo).state === 'absent', null)

    fs.writeFileSync(lock, '')
    const fresh = recoverStaleIndexLock(repo, { nowMs: now })
    check('fresh_zero_byte_refused_and_kept', fresh.state === 'refused' && fresh.reason === 'fresh' && fs.existsSync(lock), fresh.reason)

    fs.writeFileSync(lock, 'x')
    fs.utimesSync(lock, oldTime, oldTime)
    const nonempty = recoverStaleIndexLock(repo, { nowMs: now })
    check('nonempty_old_refused_and_kept', nonempty.state === 'refused' && nonempty.reason === 'nonempty' && fs.existsSync(lock), nonempty.reason)

    fs.writeFileSync(lock, '')
    fs.utimesSync(lock, oldTime, oldTime)
    if (process.platform === 'linux' || process.platform === 'darwin') {
        const fd = fs.openSync(lock, 'r')
        try {
            const held = recoverStaleIndexLock(repo, { nowMs: now })
            check('old_zero_byte_held_by_live_pid_refused_with_owner', held.state === 'refused' && held.reason === 'held' && held.owners.some((owner) => owner.startsWith(`pid ${process.pid}`)) && fs.existsSync(lock), held.owners)
        } finally {
            fs.closeSync(fd)
        }
    }

    fs.utimesSync(lock, oldTime, oldTime)
    const stale = recoverStaleIndexLock(repo, { nowMs: now })
    const quarantineRoot = path.join(repo, '.gm', 'quarantine') + path.sep
    check('stale_zero_byte_quarantined_not_deleted', stale.state === 'quarantined' && !fs.existsSync(lock) && fs.statSync(stale.quarantined).size === 0 && stale.quarantined.startsWith(quarantineRoot), stale.quarantined ?? stale.reason)

    fs.writeFileSync(lock, '')
    fs.utimesSync(lock, oldTime, oldTime)
    const added = runGit(repo, ['add', 'a.txt'])
    const staged = sh(['diff', '--cached', '--name-only']).stdout.trim()
    check('runGit_quarantines_then_git_add_succeeds', added.ok && !fs.existsSync(lock) && staged === 'a.txt', added.err || staged)

    fs.writeFileSync(lock, '')
    const blocked = runGit(repo, ['status', '--porcelain', '--', 'a.txt'])
    const blockedAdd = runGit(repo, ['reset', '-q', '--', 'a.txt'])
    check('runGit_fresh_lock_still_refuses', !blockedAdd.ok && isIndexLockContention(blockedAdd.err) && fs.existsSync(lock) && blocked.ok !== undefined, blockedAdd.err)

    const ok = Object.values(cases).every((item) => item.ok)
    console.log(JSON.stringify({ ok, cases }, null, 2))
    process.exitCode = ok ? 0 : 1
} finally {
    fs.rmSync(scratch, { recursive: true, force: true })
}
