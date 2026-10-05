import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launcherLockMayBeReclaimed, liveDaemonSweepsProject, pidAlive, recordRunnerEnsureInflight, runnerEnsureInFlight } from '../src/dispatch.js'

let passed = 0
function test(name, fn) {
    try {
        fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'gm-runner-recovery-'))
const spool = (name) => {
    const dir = path.join(scratch, name, '.gm', 'exec-spool')
    mkdirSync(dir, { recursive: true })
    return dir
}
const writeStatus = (dir, status) => writeFileSync(path.join(dir, '.status.json'), JSON.stringify(status))

const exitedPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', windowsHide: true }).pid

test('a live pid is alive and an exited one is not', () => {
    assert.equal(pidAlive(process.pid), true)
    assert.equal(pidAlive(exitedPid), false)
    assert.equal(pidAlive(0), null)
    assert.equal(pidAlive(undefined), null)
})

test('a fresh heartbeat from a dead daemon is not a live sweeper', () => {
    const dir = spool('dead-pid')
    writeStatus(dir, { pid: exitedPid, ts: Date.now() })
    assert.equal(liveDaemonSweepsProject(dir), false)
})

test('a fresh heartbeat from a live daemon is a live sweeper', () => {
    const dir = spool('live-pid')
    writeStatus(dir, { pid: process.pid, ts: Date.now() })
    assert.equal(liveDaemonSweepsProject(dir), true)
})

test('a stale heartbeat from a live daemon is not a live sweeper', () => {
    const dir = spool('stale-heartbeat')
    writeStatus(dir, { pid: process.pid, ts: Date.now() - 60_000 })
    assert.equal(liveDaemonSweepsProject(dir), false)
})

test('a project with no status.json is the registration path, not a live sweeper', () => {
    assert.equal(liveDaemonSweepsProject(spool('never-swept')), false)
})

test('a status.json without a pid falls back to the heartbeat', () => {
    const dir = spool('no-pid')
    writeStatus(dir, { ts: Date.now() })
    assert.equal(liveDaemonSweepsProject(dir), true)
    writeStatus(dir, { ts: Date.now() - 60_000 })
    assert.equal(liveDaemonSweepsProject(dir), false)
})

test('a stale launcher lock held by a live process is never reclaimed', () => {
    assert.equal(launcherLockMayBeReclaimed({ pid: process.pid, ts: Date.now() - 121_000 }), false)
})

test('a launcher lock held by an exited process is reclaimable', () => {
    assert.equal(launcherLockMayBeReclaimed({ pid: exitedPid, ts: Date.now() }), true)
})

test('no runner ensure recorded is not in flight', () => {
    assert.equal(runnerEnsureInFlight('never-ensured'), false)
})

test('a running spool child is in flight, so the watchdog does not stack another on it', () => {
    const root = 'inflight-live'
    recordRunnerEnsureInflight(root, { pid: process.pid, spawnedAtMs: Date.now(), exitCode: null })
    assert.equal(runnerEnsureInFlight(root), true)
    assert.equal(runnerEnsureInFlight(root), true, 're-checking must not consume the entry')
})

test('an exited spool child is not in flight and is forgotten', () => {
    const root = 'inflight-exited'
    recordRunnerEnsureInflight(root, { pid: exitedPid, spawnedAtMs: Date.now(), exitCode: 0 })
    assert.equal(runnerEnsureInFlight(root), false)
    assert.equal(runnerEnsureInFlight(root), false)
})

test('a spool child older than the cap is re-issued instead of blocking supervision forever', () => {
    const root = 'inflight-wedged'
    recordRunnerEnsureInflight(root, { pid: process.pid, spawnedAtMs: Date.now() - 121_000, exitCode: null })
    assert.equal(runnerEnsureInFlight(root), false)
    assert.equal(runnerEnsureInFlight(root), false, 'the wedged entry must not come back')
})

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
