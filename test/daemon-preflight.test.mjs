import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
// Set before importing: dispatch.js reads the grace once at module load, and
// the assertion below is about the verdict, not about waiting 15 s for it.
process.env.GM_MCP_DAEMON_START_GRACE_MS = '400'
const { daemonBootGraceActive, daemonNotRunning } = await import('../src/dispatch.js')

let passed = 0
async function test(name, fn) {
    try {
        await fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'gm-daemon-preflight-'))
const project = (name) => {
    const dir = path.join(scratch, name, '.gm', 'exec-spool')
    mkdirSync(dir, { recursive: true })
    return dir
}
const writeStatus = (dir, status) => writeFileSync(path.join(dir, '.status.json'), JSON.stringify(status))
const rootOf = (spoolDir) => path.resolve(spoolDir, '..', '..')
const exitedPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid

await test('a live daemon is not reported as down', async () => {
    const dir = project('live')
    writeStatus(dir, { pid: process.pid, ts: Date.now() })
    assert.equal(await daemonNotRunning(rootOf(dir), dir, undefined), undefined)
})

await test('a project that never swept is the registration path, not a dead daemon', async () => {
    const dir = project('registered')
    assert.equal(await daemonNotRunning(rootOf(dir), dir, undefined), undefined)
})

// The boot grace is global: while the real daemon has just restarted, a stale
// heartbeat is expected and the pre-flight must stay quiet. Wait it out so the
// dead-project assertions below do not flake on the daemon's recycle schedule.
async function waitOutOfBootGrace() {
    for (let i = 0; i < 45 && daemonBootGraceActive(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
}

await test('a stale heartbeat from a dead pid reports daemon-not-running', async () => {
    await waitOutOfBootGrace()
    const dir = project('dead')
    writeStatus(dir, { pid: exitedPid, ts: Date.now() - 5 * 60_000 })
    const result = await daemonNotRunning(rootOf(dir), dir, undefined)
    assert.equal(result?.error, 'daemon-not-running')
    assert.equal(result.daemon_not_running, true)
    assert.ok(result.heartbeat_age_ms > 60_000)
    assert.ok(result.note.includes('queued_not_yet_claimed'), result.note)
    assert.ok(result.note.includes('agentplug-runner'), result.note)
    assert.ok(existsSync(result.checked_status_file))
    assert.ok(result.daemon_log.endsWith('daemon.log'))
    assert.ok(result.spool_log.endsWith('.watcher.log'))
})

await test('a runner_update_in_progress handoff still dispatches', async () => {
    const dir = project('handoff')
    writeStatus(dir, { pid: exitedPid, ts: Date.now() - 5 * 60_000, runner_update_in_progress: true })
    assert.equal(await daemonNotRunning(rootOf(dir), dir, undefined), undefined)
})

await test('GM_MCP_DAEMON_PREFLIGHT=0 bypasses the check', async () => {
    const dir = project('bypassed')
    writeStatus(dir, { pid: exitedPid, ts: Date.now() - 5 * 60_000 })
    process.env.GM_MCP_DAEMON_PREFLIGHT = '0'
    try {
        assert.equal(await daemonNotRunning(rootOf(dir), dir, undefined), undefined)
    } finally {
        delete process.env.GM_MCP_DAEMON_PREFLIGHT
    }
})

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
