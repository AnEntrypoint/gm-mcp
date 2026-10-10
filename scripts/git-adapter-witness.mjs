import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const moduleFile = path.resolve(flags.module ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'git-adapter.js'))
const toForwardSlashes = p => p.split(path.sep).join('/')
const identityEnv = { GIT_AUTHOR_NAME: 'witness', GIT_AUTHOR_EMAIL: 'witness@example.invalid', GIT_COMMITTER_NAME: 'witness', GIT_COMMITTER_EMAIL: 'witness@example.invalid' }

const results = []
const check = (name, ok, detail = '') => {
    results.push(ok === true)
    console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const canonical = p => (process.platform === 'win32' ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p))
const isSameDir = (candidate, dir) => typeof candidate === 'string' && fs.existsSync(candidate) && canonical(candidate) === canonical(dir)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'git-adapter-witness-'))
process.env.GIT_CEILING_DIRECTORIES = toForwardSlashes(scratch)
let exitCode = 1
try {
    const fixtureGit = args => {
        const run = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, ...identityEnv } })
        if (run.status !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${run.stderr || run.error?.message}`)
        return run.stdout.trim()
    }
    const repo = path.join(scratch, 'repo')
    const nested = path.join(repo, 'sub', 'deep')
    const plain = path.join(scratch, 'plain')
    const bare = path.join(scratch, 'bare.git')
    const missing = path.join(scratch, 'missing')
    fs.mkdirSync(nested, { recursive: true })
    fs.mkdirSync(plain)
    fixtureGit(['init', '-q', repo])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n')
    fixtureGit(['-C', repo, 'add', 'a.txt'])
    fixtureGit(['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
    fixtureGit(['init', '-q', '--bare', bare])
    const head = fixtureGit(['-C', repo, 'rev-parse', 'HEAD'])

    const { runGit, gitToplevel } = await import(pathToFileURL(moduleFile).href)
    check('module exports runGit and gitToplevel as functions', typeof runGit === 'function' && typeof gitToplevel === 'function')

    const inside = runGit(repo, ['rev-parse', '--is-inside-work-tree'])
    check('runGit reports ok when git exits 0', inside.ok === true, JSON.stringify(inside))
    check('runGit trims stdout', inside.out === 'true', JSON.stringify(inside.out))
    check('runGit leaves err empty when git succeeds', inside.err === '', JSON.stringify(inside.err))
    check('runGit returns the commit sha with no trailing newline', runGit(repo, ['rev-parse', 'HEAD']).out === head, JSON.stringify(head))
    const prefix = runGit(nested, ['rev-parse', '--show-prefix'])
    check('runGit runs git inside the cwd it is given', prefix.out === 'sub/deep/', JSON.stringify(prefix.out))

    const failed = runGit(repo, ['no-such-subcommand'])
    check('runGit reports not ok when git exits non-zero', failed.ok === false, JSON.stringify(failed))
    check('runGit returns empty out when git fails', failed.out === '', JSON.stringify(failed.out))
    check('runGit returns trimmed stderr when git fails', /no-such-subcommand/.test(failed.err) && failed.err === failed.err.trim(), JSON.stringify(failed.err))

    const slowAlias = `alias.slow=!"${toForwardSlashes(process.execPath)}" -e "setTimeout(function(){},5000)"`
    const timedOut = runGit(os.tmpdir(), ['-c', slowAlias, 'slow'], 300)
    check('runGit forwards its timeout and reports the kill as not ok', timedOut.ok === false && timedOut.out === '' && /ETIMEDOUT/.test(timedOut.err), JSON.stringify(timedOut))

    const savedPath = process.env.PATH
    let unstartable
    try {
        process.env.PATH = ''
        unstartable = runGit(repo, ['rev-parse', 'HEAD'])
    } finally {
        process.env.PATH = savedPath
    }
    check('runGit reports the spawn error in err when git cannot start', unstartable.ok === false && unstartable.out === '' && /ENOENT/.test(unstartable.err), JSON.stringify(unstartable))

    const topOfRepo = gitToplevel(repo)
    check('gitToplevel returns the work tree root for the repo itself', isSameDir(topOfRepo, repo), JSON.stringify(topOfRepo))
    const topOfNested = gitToplevel(nested)
    check('gitToplevel climbs from a subdirectory to the work tree root', isSameDir(topOfNested, repo), JSON.stringify(topOfNested))
    check('gitToplevel returns a normalized native absolute path', typeof topOfNested === 'string' && path.isAbsolute(topOfNested) && path.resolve(topOfNested) === topOfNested, JSON.stringify(topOfNested))
    check('gitToplevel returns null outside any repository', gitToplevel(plain) === null, JSON.stringify(gitToplevel(plain)))
    check('gitToplevel returns null for a bare repository', gitToplevel(bare) === null, JSON.stringify(gitToplevel(bare)))
    check('gitToplevel returns null for a directory that does not exist', gitToplevel(missing) === null, JSON.stringify(gitToplevel(missing)))

    exitCode = results.every(Boolean) ? 0 : 1
} catch (error) {
    check('witness ran to completion', false, String(error?.stack || error).split('\n').slice(0, 3).join(' | '))
} finally {
    fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`checks ${results.filter(Boolean).length}/${results.length}`)
console.log(exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(exitCode)
