import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.GM_MCP_DAEMON_RESPAWN = '0'
process.env.GM_MCP_RUNNER_WATCHDOG = '0'
import { readDispatchWaitRow } from '../src/dispatch.js'

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

const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-dispatch-wait-'))

function writeLedger({ ageMs, rows }) {
    fs.writeFileSync(path.join(spoolDir, '.dispatch-wait.json'), JSON.stringify({
        daemon_pid: 4242,
        ts: Date.now() - ageMs,
        requests: rows,
    }))
}

const row = (over) => ({
    verb: 'bash',
    task: 'task-1',
    state: 'claimed_waiting_for_serial_lane',
    lane: null,
    stage_age_ms: 8,
    file_age_ms: 40,
    request_path: 'in/bash/task-1.txt',
    out_path: 'out/bash-task-1.json',
    ...over,
})

const read = () => readDispatchWaitRow(spoolDir, 'bash', 'task-1', 'out/bash-task-1.json')

await test('a lane wait that names no lane says the row cannot be a lane this dispatch is on', () => {
    writeLedger({ ageMs: 0, rows: [row()] })
    const { row: read_ } = read()
    assert.equal(read_.state, 'claimed_waiting_for_serial_lane')
    assert.equal(read_.lane, null)
    assert.match(read_.state_meaning, /the daemon holds the request and is waiting for this project serial lane/)
    assert.match(read_.state_meaning, /names no lane/)
    assert.match(read_.state_meaning, /admitted without waiting for one/)
})

await test('a lane wait that names its lane carries the plain state meaning', () => {
    writeLedger({ ageMs: 0, rows: [row({ verb: 'git_commit', lane: 'git' })] })
    const { row: read_ } = readDispatchWaitRow(spoolDir, 'git_commit', 'task-1', 'out/git_commit-task-1.json')
    assert.equal(read_.lane, 'git')
    assert.equal(read_.state_meaning, 'the daemon holds the request and is waiting for this project serial lane (git, store or state)')
})

await test('the null-lane caveat does not attach to a stage that is not a lane wait', () => {
    writeLedger({ ageMs: 0, rows: [row({ state: 'claimed_running' })] })
    assert.equal(read().row.state_meaning, 'the daemon is executing the request')
})

await test('a freshly rewritten ledger is reported as a current reading', () => {
    writeLedger({ ageMs: 0, rows: [row()] })
    const result = read()
    assert.equal(result.row.snapshot_stale, false)
    assert.equal(result.note, undefined)
})

await test('a ledger rewritten seconds ago is reported as a snapshot, not as a live reading', () => {
    writeLedger({ ageMs: 120_000, rows: [row()] })
    const result = read()
    assert.equal(result.row.snapshot_stale, true)
    assert.match(result.note, /last rewritten \d+ ms ago/)
    assert.match(result.note, /not a reading of what the dispatch is doing now/)
    assert.match(result.note, /never on a timer/)
})

await test('a ledger carrying no ts is not claimed to be a snapshot', () => {
    fs.writeFileSync(path.join(spoolDir, '.dispatch-wait.json'), JSON.stringify({ daemon_pid: 1, requests: [row()] }))
    const result = read()
    assert.equal(result.ledger_age_ms, null)
    assert.equal(result.row.snapshot_stale, false)
})

fs.rmSync(spoolDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
