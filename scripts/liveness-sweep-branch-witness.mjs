#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildBundle } from './build.mjs'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const LOCAL_BRANCHES = ['lease-files', 'main']
const DROPPED_BRANCH = 'liveness-sweep-fallback'
const failures = []

function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
    if (!ok) failures.push(name)
}

function git(args) {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', env: gitEnv, timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
}

function nonEmptyLines(text) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

try {
    const local = nonEmptyLines(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).sort()
    check('local branches are exactly lease-files and main', JSON.stringify(local) === JSON.stringify(LOCAL_BRANCHES), `local: ${local.join(', ')}`)
} catch (error) {
    check('local branches readable', false, error.message.split('\n')[0])
}

try {
    const heads = nonEmptyLines(git(['ls-remote', '--heads', 'origin'])).map((line) => line.split('\t')[1].replace('refs/heads/', ''))
    check(`origin has no ${DROPPED_BRANCH}`, !heads.includes(DROPPED_BRANCH), `origin heads: ${heads.join(', ')}`)
} catch (error) {
    check('origin reachable with ls-remote', false, error.message.split('\n')[0])
}

try {
    const worktreeBlocks = git(['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)
    const leaseBlock = worktreeBlocks.find((block) => block.includes('branch refs/heads/lease-files'))
    const leasePath = leaseBlock?.split(/\r?\n/).find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    console.log(`info lease-files checked out at: ${leasePath ?? 'no worktree'}`)
} catch (error) {
    check('worktree list readable', false, error.message.split('\n')[0])
}

const srcAndBinMatchMain = spawnSync('git', ['-C', repoRoot, 'diff', '--quiet', 'main', '--', 'src', 'bin'], { env: gitEnv, timeout: 60000 }).status === 0
check('working src and bin equal main', srcAndBinMatchMain)

const built = await buildBundle(false)
const shipped = fs.readFileSync(path.join(repoRoot, 'bin', 'gm-mcp-server.js'), 'utf8')
check('bin/gm-mcp-server.js is a fresh build of src', shipped === built.outputFiles[0].text, `${shipped.length} bytes`)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-liveness-witness-'))
try {
    process.env.AGENTPLUG_HOME = home
    const dispatch = await import(pathToFileURL(path.join(repoRoot, 'src', 'dispatch.js')).href)
    const now = Date.now()
    const stale = now - 60000
    const globalFile = path.join(home, 'daemon-status.json')
    const sweep = (status, globalStatus) => {
        const spool = fs.mkdtempSync(path.join(home, 'spool-'))
        if (status !== undefined) fs.writeFileSync(path.join(spool, '.status.json'), JSON.stringify(status))
        fs.rmSync(globalFile, { force: true })
        if (globalStatus !== undefined) fs.writeFileSync(globalFile, JSON.stringify(globalStatus))
        return dispatch.liveDaemonSweepsProject(spool)
    }
    const cases = [
        ['no status file is not live', undefined, undefined, false],
        ['fresh own heartbeat of a live pid is live', { pid: process.pid, ts: now }, undefined, true],
        ['stale own heartbeat with no global heartbeat is not live', { pid: process.pid, ts: stale }, undefined, false],
        ['stale own heartbeat falls back to a fresh global heartbeat of the same live pid', { pid: process.pid, ts: stale }, { pid: process.pid, ts: now }, true],
        ['fresh global heartbeat of a different pid does not revive', { pid: process.pid, ts: stale }, { pid: process.ppid, ts: now }, false],
        ['stale global heartbeat does not revive', { pid: process.pid, ts: stale }, { pid: process.pid, ts: stale }, false],
        ['dead pid is not live even with fresh heartbeats', { pid: 2147483646, ts: now }, { pid: 2147483646, ts: now }, false],
    ]
    for (const [name, status, globalStatus, expected] of cases) {
        const got = sweep(status, globalStatus)
        check(`sweep: ${name}`, got === expected, `got ${got}, expected ${expected}`)
    }
} catch (error) {
    check('liveDaemonSweepsProject loads from src/dispatch.js and runs', false, error.message.split('\n')[0])
} finally {
    fs.rmSync(home, { recursive: true, force: true })
}

console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? ` (failed: ${failures.join('; ')})` : ''}`)
process.exit(failures.length === 0 ? 0 : 1)
