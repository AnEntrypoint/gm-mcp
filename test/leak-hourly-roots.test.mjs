import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'gm-hourly-home-'))
const root = mkdtempSync(path.join(tmpdir(), 'gm-hourly-root-'))
const gone = path.join(home, 'vanished-project')
process.env.AGENTPLUG_HOME = home
mkdirSync(path.join(root, '.gm', 'exec-spool'), { recursive: true })

const { leakWatchReport } = await import('../src/leak-watch.js')
const { recordChild } = await import('../src/child-ledger.js')
const leasesDir = () => path.join(home, 'leases')

const standIn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
const cleanup = () => {
    try { standIn.kill() } catch {}
    for (const dir of [home, root]) {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
}
process.on('exit', cleanup)

// The attributed exec runner: its dispatch was recorded in the PROJECT ledger, not the global one.
recordChild({ root, pid: standIn.pid, kind: 'exec', verb: 'exec_js', dispatch_id: 'hourly-roots-proof', session_id: 'session-hourly', port: null })

// A historical row whose process has already exited: the pass has nothing to retire there, so it is not assessed.
const exited = spawnSync(process.execPath, ['-e', '0'])
recordChild({ root, pid: exited.pid, kind: 'exec', verb: 'exec_js', dispatch_id: 'hourly-roots-exited', session_id: 'session-hourly', port: null })

// Project discovery reads the lease records dispatch.js writes, one per project gm has dispatched into.
// A lease whose project directory no longer exists must be ignored.
mkdirSync(leasesDir(), { recursive: true })
writeFileSync(path.join(leasesDir(), `0000000000000000.${process.pid}.lease`), root, 'utf8')
writeFileSync(path.join(leasesDir(), `1111111111111111.${process.pid}.lease`), gone, 'utf8')

const failures = []
const check = (name, fn) => {
    try {
        fn()
        console.log(`  ok   ${name}`)
    } catch (error) {
        failures.push(name)
        console.log(`  FAIL ${name}: ${error.message}`)
    }
}

// The hourly pass calls leakWatchReport with roots null (see runLeakWatchPass / index.js).
const report = await leakWatchReport({ roots: null, processes: [], now: Date.now(), httpPorts: [], signalPid: () => false })

check('the hourly pass discovers the project root from its lease record', () => {
    assert.ok(Array.isArray(report.scanned_roots), 'report has no scanned_roots list')
    assert.ok(report.scanned_roots.includes(root), `scanned roots were ${JSON.stringify(report.scanned_roots)}`)
})

check('a lease naming a vanished project directory is not scanned', () => {
    assert.ok(!(report.scanned_roots ?? []).includes(gone), 'the vanished project was scanned')
})

check('the attributed project-ledger row is assessed by the hourly pass', () => {
    const assessed = report.reap_counts.retire + report.reap_counts.keep + report.reap_counts.unknown
    assert.ok(assessed >= 1, `no findings were assessed: ${JSON.stringify(report.reap_counts)}`)
})

check('only the live attributed row is assessed, not the exited one', () => {
    const assessed = report.reap_counts.retire + report.reap_counts.keep + report.reap_counts.unknown
    assert.equal(assessed, 1, `findings: ${JSON.stringify(report.reap_counts)}`)
})

console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} failure(s))`)
process.exit(failures.length === 0 ? 0 : 1)
