import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

const home = mkdtempSync(path.join(tmpdir(), 'gm-reaper-home-'))
const root = mkdtempSync(path.join(tmpdir(), 'gm-reaper-root-'))
process.env.AGENTPLUG_HOME = home
mkdirSync(path.join(root, '.gm', 'exec-spool'), { recursive: true })

const { reapReport } = await import('../src/leak-reaper.js')
const { recordChild, attributePid } = await import('../src/child-ledger.js')
const { allocateHttpPort, portIsFree, instanceFilePath } = await import('../src/singleton.js')
const { pidAlive } = await import('../src/dispatch.js')

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

const LEAK_SOURCE = `
const http = require('http')
const fs = require('fs')
const server = http.createServer((req, res) => res.end('leak'))
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.LEAK_PORT_FILE, String(server.address().port))
})
setInterval(() => {}, 1000)
`

const ORPHANER = `
const { spawn } = require('child_process')
const fs = require('fs')
const child = spawn(process.execPath, [process.env.LEAK_SCRIPT], { detached: true, stdio: 'ignore', env: process.env })
child.unref()
fs.writeFileSync(process.env.LEAK_PID_FILE, String(child.pid))
process.exit(0)
`

function waitForFile(file, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (existsSync(file)) {
            try {
                const text = readFileSync(file, 'utf8').trim()
                if (text !== '') return text
            } catch {}
        }
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)'])
    }
    throw new Error(`timed out waiting for ${file}`)
}

const scriptPath = path.join(root, 'leak-server.js')
writeFileSync(scriptPath, LEAK_SOURCE, 'utf8')

function spawnLeak(tag, leaks) {
    const pidFile = path.join(root, `${tag}.pid`)
    const portFile = path.join(root, `${tag}.port`)
    for (const file of [pidFile, portFile]) {
        try { rmSync(file, { force: true }) } catch {}
    }
    spawnSync(process.execPath, ['-e', ORPHANER], {
        env: { ...process.env, LEAK_SCRIPT: scriptPath, LEAK_PID_FILE: pidFile, LEAK_PORT_FILE: portFile },
        stdio: 'ignore',
    })
    const leak = { pid: Number(waitForFile(pidFile)) }
    leaks.push(leak)
    leak.port = Number(waitForFile(portFile))
    return leak
}

const leaks = []
const cleanup = () => {
    for (const leak of leaks) {
        try { process.kill(leak.pid) } catch {}
    }
    for (const dir of [home, root]) {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
}
process.on('exit', cleanup)

console.log('leak-reaper: spawning two orphaned servers that refuse to exit')
const leakA = spawnLeak('a', leaks)
const leakB = spawnLeak('b', leaks)
assert.ok(pidAlive(leakA.pid) === true, 'leak A is running')
assert.ok(pidAlive(leakB.pid) === true, 'leak B is running')

recordChild({ root, pid: leakA.pid, kind: 'exec', verb: 'exec_js', dispatch_id: '1791850000000-500-attribution-proof', session_id: 'session-dead-lane', task: '7', port: leakA.port })
recordChild({ root, pid: leakB.pid, kind: 'exec', verb: 'exec_js', dispatch_id: '1791850000001-500-leak-b', session_id: 'session-dead-lane', task: '8', port: leakB.port })

const client = net.createConnection({ host: '127.0.0.1', port: leakB.port })
await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
})

const first = await reapReport({ roots: [root], apply: false, liveSessionIds: new Set() })
const findingA = first.findings.find((entry) => entry.pid === leakA.pid)
const findingB = first.findings.find((entry) => entry.pid === leakB.pid)

check('attributed leak A is measured as retireable', () => {
    assert.ok(findingA, 'leak A appears in the report')
    assert.equal(findingA.verdict, 'retire', `verdict was ${findingA.verdict}: ${JSON.stringify(findingA.protected_by ?? findingA.unmeasured)}`)
})

check('live-attached leak B is NOT reaped', () => {
    assert.ok(findingB, 'leak B appears in the report')
    assert.equal(findingB.verdict, 'keep', `verdict was ${findingB.verdict}`)
    assert.ok((findingB.protected_by ?? []).includes('zero-attached-clients'), `protected by ${JSON.stringify(findingB.protected_by)}`)
    assert.equal(findingB.attached_clients ?? findingB.predicates.find((p) => p.predicate === 'zero-attached-clients')?.value, 1)
})

check('retire requires every predicate measured, so an unattributed pid is never a candidate', () => {
    const stranger = first.findings.filter((entry) => entry.source === 'attributed-child')
    assert.ok(stranger.every((entry) => entry.pid === leakA.pid || entry.pid === leakB.pid), 'only ledger-owned pids are candidates')
})

check('dry run signals nothing', () => {
    assert.equal(first.retired.length, 0)
    assert.equal(pidAlive(leakA.pid), true)
})

const applied = await reapReport({ roots: [root], apply: true, liveSessionIds: new Set() })
const retiredA = applied.retired.find((entry) => entry.pid === leakA.pid)
check('apply retires the proven orphan with no manual action', () => {
    assert.ok(retiredA, 'leak A was retired')
    assert.equal(retiredA.action, 'signalled')
})

const deadline = Date.now() + 10_000
while (Date.now() < deadline && pidAlive(leakA.pid) === true) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)'])
}
check('the retired pid is gone', () => {
    assert.notEqual(pidAlive(leakA.pid), true, 'leak A is still alive after retirement')
})

client.destroy()
await new Promise((resolve) => setTimeout(resolve, 300))
const second = await reapReport({ roots: [root], apply: true, liveSessionIds: new Set() })
check('B is reaped once its client disconnects', () => {
    const finding = second.findings.find((entry) => entry.pid === leakB.pid)
    assert.ok(finding, 'leak B still in the report')
    assert.equal(finding.verdict, 'retire', `verdict was ${finding.verdict}: ${JSON.stringify(finding.protected_by ?? finding.unmeasured)}`)
})

const freeProbe = net.createServer()
await new Promise((resolve) => freeProbe.listen(0, '127.0.0.1', resolve))
const recycledPort = freeProbe.address().port
await new Promise((resolve) => freeProbe.close(resolve))
writeFileSync(instanceFilePath(recycledPort), JSON.stringify({ port: recycledPort, host: '127.0.0.1', pid: process.pid, version: 'test', entry: 'leak-reaper.test.mjs', supervisor_pid: null, ts: Date.now() }, null, 2), 'utf8')

check('a registry holding a live pid that does not own its port is not a live hold', () => {
    assert.equal(portIsFree(recycledPort), true, 'the port still read as taken')
})

check('the lowest free port is allocated, so ports are reused rather than ratcheting up', () => {
    const allocated = allocateHttpPort({ preferred: recycledPort, from: recycledPort, to: recycledPort + 5 })
    assert.equal(allocated, recycledPort, `allocated ${allocated}`)
})

check('attribution answers which dispatch spawned a pid', () => {
    const answer = attributePid(leakA.pid, { root })
    assert.equal(answer.attributed, true)
    assert.equal(answer.dispatch_id, '1791850000000-500-attribution-proof')
    assert.equal(answer.verb, 'exec_js')
    assert.equal(answer.port, leakA.port)
})

console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} failure(s))`)
process.exit(failures.length === 0 ? 0 : 1)
