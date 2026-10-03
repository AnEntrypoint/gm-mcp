import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { liveDaemonSweepsProject, pidAlive } from '../src/dispatch.js'

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

const exitedPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid

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

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
