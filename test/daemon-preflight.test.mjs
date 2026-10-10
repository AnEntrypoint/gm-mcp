import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.GM_MCP_DAEMON_START_GRACE_MS = '400'
process.env.GM_MCP_RUNNER_WATCHDOG = '0'
const agentplugHome = mkdtempSync(path.join(tmpdir(), 'gm-agentplug-home-'))
process.env.AGENTPLUG_HOME = agentplugHome
const { daemonBootGraceActive, daemonNotRunning, readDaemonLiveness, readSpoolDispatchState, scanSpoolQueue } = await import('../src/dispatch.js')

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const scratch = mkdtempSync(path.join(tmpdir(), 'gm-daemon-preflight-'))
const project = (name) => {
    const dir = path.join(scratch, name, '.gm', 'exec-spool')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.runner-ensure.lock'), String(process.pid))
    return dir
}
const writeStatus = (dir, status) => writeFileSync(path.join(dir, '.status.json'), JSON.stringify(status))
const writeGlobalStatus = (status) => writeFileSync(path.join(agentplugHome, 'daemon-status.json'), JSON.stringify(status))
const rootOf = (spoolDir) => path.resolve(spoolDir, '..', '..')
const exitedPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', windowsHide: true }).pid

await test('a live daemon is not reported as down', async () => {
    const dir = project('live')
    writeStatus(dir, { pid: process.pid, ts: Date.now() })
    assert.equal(await daemonNotRunning(rootOf(dir), dir, undefined), undefined)
})

await test('a project that never swept is the registration path, not a dead daemon', async () => {
    const dir = project('registered')
    assert.equal(await daemonNotRunning(rootOf(dir), dir, undefined), undefined)
})

async function waitOutOfBootGrace() {
    for (let i = 0; i < 45 && daemonBootGraceActive(); i += 1) {
        await sleep(1000)
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

await test('a stale heartbeat from a pid that still owns the live daemon is not reported as down', async () => {
    const staleTs = Date.now() - 5 * 60_000
    writeGlobalStatus({ pid: process.pid, ts: staleTs, active_projects: 1 })
    const dir = project('stale-but-live')
    writeStatus(dir, { pid: process.pid, ts: staleTs })
    const liveness = readDaemonLiveness(dir)
    assert.equal(liveness.alive, true)
    assert.equal(liveness.pid_alive, true)
    assert.ok(liveness.heartbeat_age_ms > 60_000, String(liveness.heartbeat_age_ms))
    assert.equal(await daemonNotRunning(rootOf(dir), dir, undefined), undefined)
    writeGlobalStatus({})
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

await test('a cold project explains the wait instead of blaming git or the daemon', async () => {
    const dir = project('cold-non-git')
    const liveness = readDaemonLiveness(dir)
    assert.equal(liveness.alive, null)
    assert.ok(liveness.note.includes('.status.json'), liveness.note)
    const sharedDaemonRunning = liveness.shared_daemon_pid !== undefined
    assert.ok(liveness.note.includes(sharedDaemonRunning ? 'resume_task' : 'no shared daemon process'), liveness.note)
})

const queueProject = (name) => {
    const dir = project(name)
    mkdirSync(path.join(dir, 'in', 'instruction'), { recursive: true })
    return dir
}
const queueFile = (dir, verb, name, ageMs) => {
    const verbDir = path.join(dir, 'in', verb)
    mkdirSync(verbDir, { recursive: true })
    const filePath = path.join(verbDir, name)
    writeFileSync(filePath, '{}')
    const backdated = (Date.now() - ageMs) / 1000
    utimesSync(filePath, backdated, backdated)
    return filePath
}

await test('an unclaimed dispatch reports measured queue pressure, not hypotheses', async () => {
    const dir = queueProject('queue-measured')
    const mine = queueFile(dir, 'instruction', 'mine.txt', 5_000)
    queueFile(dir, 'instruction', 'older.txt', 60_000)
    queueFile(dir, 'codesearch', 'oldest.txt', 120_000)
    const state = readSpoolDispatchState(dir, 'instruction', 'mine')
    assert.equal(state.state, 'queued_not_yet_claimed')
    assert.equal(state.project_claimed_count, 0)
    assert.equal(state.project_unclaimed_count, 3)
    assert.equal(state.unclaimed_ahead_of_mine, 2)
    assert.equal(state.claimed_dispatch_cap, 32)
    assert.equal(state.claim_budget_left, 32)
    assert.equal(state.cap_saturated, false)
    assert.ok(state.oldest_unclaimed_age_ms >= 120_000, state.oldest_unclaimed_age_ms)
    assert.ok(state.note.includes('Not cap saturation'), state.note)
    assert.ok(state.note.includes('resume_task'), state.note)
    assert.ok(!state.note.includes('maximum of 32 claimed dispatches in flight'), state.note)
    assert.ok(existsSync(mine))
})

await test('a project at its claim cap says so plainly', async () => {
    const dir = queueProject('queue-saturated')
    queueFile(dir, 'instruction', 'mine.txt', 1_000)
    for (let i = 0; i < 32; i += 1) queueFile(dir, 'instruction', `busy-${i}.txt.inflight`, 30_000)
    const state = scanSpoolQueue(dir, path.join(dir, 'in', 'instruction', 'mine.txt'))
    assert.equal(state.project_claimed_count, 32)
    assert.equal(state.project_unclaimed_count, 1)
    assert.equal(state.claim_budget_left, 0)
    assert.equal(state.cap_saturated, true)
    const note = readSpoolDispatchState(dir, 'instruction', 'mine').note
    assert.ok(note.includes('AT ITS CLAIM CAP'), note)
    const busy0 = path.join(dir, 'in', 'instruction', 'busy-0.txt.inflight')
    rmSync(busy0)
    writeFileSync(path.join(dir, 'in', 'instruction', 'busy-0.txt'), '{}')
    const withFreeSlot = scanSpoolQueue(dir, path.join(dir, 'in', 'instruction', 'mine.txt'))
    assert.equal(withFreeSlot.project_claimed_count, 31)
    assert.equal(withFreeSlot.project_unclaimed_count, 2)
    assert.equal(withFreeSlot.cap_saturated, false)
})

await test('an unclaimed dispatch past the sweep bound is reported as a stalled claim sweep', async () => {
    const dir = queueProject('queue-stalled')
    queueFile(dir, 'instruction', 'mine.txt', 45_000)
    const state = readSpoolDispatchState(dir, 'instruction', 'mine')
    assert.equal(state.state, 'queued_not_yet_claimed')
    assert.equal(state.cap_saturated, false)
    assert.equal(state.claim_budget_left, 32)
    assert.equal(state.project_unclaimed_count, 1)
    assert.equal(state.claim_sweep_stalled, true)
    assert.ok(state.claim_sweep_stalled_for_ms >= 45_000, state.claim_sweep_stalled_for_ms)
    assert.ok(state.note.includes('CLAIM SWEEP STALLED'), state.note)
    assert.ok(state.note.includes('resume_task'), state.note)
})

await test('a freshly queued dispatch is ordinary queueing, not a stalled sweep', async () => {
    const dir = queueProject('queue-fresh')
    queueFile(dir, 'instruction', 'mine.txt', 2_000)
    const state = readSpoolDispatchState(dir, 'instruction', 'mine')
    assert.equal(state.claim_sweep_stalled, false)
    assert.equal(state.cap_saturated, false)
    assert.ok(state.note.includes('Not cap saturation'), state.note)
    assert.ok(!state.note.includes('CLAIM SWEEP STALLED'), state.note)
})

await test('a cap-saturated project blames the cap, not the sweep', async () => {
    const dir = queueProject('queue-stalled-but-capped')
    queueFile(dir, 'instruction', 'mine.txt', 90_000)
    for (let i = 0; i < 32; i += 1) queueFile(dir, 'instruction', `busy-${i}.txt.inflight`, 30_000)
    const state = readSpoolDispatchState(dir, 'instruction', 'mine')
    assert.equal(state.claim_sweep_stalled, false)
    assert.equal(state.cap_saturated, true)
    assert.ok(state.note.includes('AT ITS CLAIM CAP'), state.note)
})

await test('a hidden .tmp publish file is not counted as a queued dispatch', async () => {
    const dir = queueProject('queue-tmp')
    queueFile(dir, 'instruction', 'mine.txt', 1_000)
    queueFile(dir, 'instruction', '.mine.1.2.tmp', 1_000)
    const state = scanSpoolQueue(dir, path.join(dir, 'in', 'instruction', 'mine.txt'))
    assert.equal(state.project_unclaimed_count, 1)
})

await test('a live daemon block carries the counts it already published', async () => {
    const dir = project('status-counts')
    writeStatus(dir, { pid: process.pid, ts: Date.now(), claimed_step_count: 7, queued_step_count: 3, gm_processor_capacity: 8 })
    const liveness = readDaemonLiveness(dir)
    assert.equal(liveness.claimed_step_count, 7)
    assert.equal(liveness.queued_step_count, 3)
    assert.equal(liveness.gm_processor_capacity, 8)
})

async function removeScratchTree(dir) {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
            return
        } catch (error) {
            if (!existsSync(dir)) return
            if (attempt === 20) throw new Error(`could not remove ${dir} after ${attempt} attempts: ${error.message}`)
            await sleep(250)
        }
    }
}

await removeScratchTree(scratch)
await removeScratchTree(agentplugHome)
console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
