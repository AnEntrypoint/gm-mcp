import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'gm-leak-watch-home-'))
const root = mkdtempSync(path.join(tmpdir(), 'gm-leak-watch-root-'))
process.env.AGENTPLUG_HOME = home
mkdirSync(path.join(root, '.gm', 'exec-spool'), { recursive: true })

const { liveSessionNameOf } = await import('../src/process-table.js')
const { scheduleStaleDeployedBundleChecks } = await import('../src/self-update.js')
const {
    ancestorVerdict,
    autoApplyDecision,
    autoApplyEnabled,
    censusGmProcesses,
    duplicateSupervisorFindings,
    formatLeakWatchLine,
    leakWatchEnabled,
    leakWatchReport,
    parentWalker,
    populationOf,
    populationWarnAt,
    runLeakWatchPass,
} = await import('../src/leak-watch.js')

const ENTRY = '/opt/gm-mcp/bin/gm-mcp-server.mjs'
const NODE = '/usr/local/bin/node'
const now = Date.now()
const HOUR = 60 * 60 * 1000

const liveStandIn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
const livePid = liveStandIn.pid

let passed = 0
const failures = []
const test = async (name, fn) => {
    try {
        await fn()
        passed += 1
        console.log(`  ok   ${name}`)
    } catch (error) {
        failures.push(name)
        console.log(`  FAIL ${name}: ${error.message}`)
    }
}

const cleanup = () => {
    try { liveStandIn.kill() } catch {}
    for (const dir of [home, root]) {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
}
process.on('exit', cleanup)

const row = (pid, ppid, command, startedAt = null) => ({ pid, ppid, started_at: startedAt, command })
const stdioServer = (pid, ppid, startedAt) => row(pid, ppid, `${NODE} ${ENTRY}`, startedAt)
const supervisorOn = (pid, port, startedAt) => row(pid, 1, `${NODE} ${ENTRY} http-supervise --port ${port} --interval 15`, startedAt)

const PARENT_COMMAND = '/usr/local/bin/node /opt/other/relay.mjs'
const orphanTable = (startedAt = now - 3 * HOUR) => [
    stdioServer(livePid, process.pid, startedAt),
    row(process.pid, 1, PARENT_COMMAND, now - 4 * HOUR),
]

const stubSignaller = (collected) => (pid) => {
    collected.push(pid)
    return true
}

await test('the census counts gm-mcp servers and supervisors, and not the shell counting them', () => {
    const table = [
        stdioServer(101, 1),
        row(102, 1, `${NODE} ${ENTRY} --http --port 8787 --host 127.0.0.1`),
        supervisorOn(103, 8787),
        row(104, 1, 'sh -c "pgrep -f gm-mcp-server | wc -l"'),
        row(105, 1, `/usr/bin/python3 ${ENTRY}`),
    ]
    const census = censusGmProcesses(table)
    assert.deepEqual(census.servers.map((entry) => entry.pid), [101, 102])
    assert.deepEqual(census.supervisors.map((entry) => entry.pid), [103])
    assert.equal(census.servers[1].transport, 'http')
    assert.equal(census.servers[1].port, 8787)
})

await test('the population warns at a threshold instead of at the OOM cliff', () => {
    const eight = { servers: Array.from({ length: 8 }, (_, index) => stdioServer(200 + index, 1, now - HOUR)), supervisors: [] }
    assert.equal(populationOf(eight, { warnAt: 8, now }).above_warn, true)
    assert.equal(populationOf(eight, { warnAt: 8, now }).gm_processes, 8)
    const seven = { servers: eight.servers.slice(0, 7), supervisors: [] }
    assert.equal(populationOf(seven, { warnAt: 8, now }).above_warn, false)
    assert.equal(populationOf(eight, { warnAt: 8, now }).oldest_age_ms, HOUR)
    assert.equal(populationOf({ servers: [], supervisors: [] }, { warnAt: 8, now }).oldest_age_ms, null)

    assert.equal(populationWarnAt(), 8)
    process.env.GM_MCP_LEAK_POPULATION_WARN = '3'
    assert.equal(populationWarnAt(), 3)
    delete process.env.GM_MCP_LEAK_POPULATION_WARN
})

await test('a desktop session is classified by what it is, so age never retires it', () => {
    assert.equal(liveSessionNameOf('/usr/bin/selkies --port 8081'), 'selkies')
    assert.equal(liveSessionNameOf('xfdesktop'), 'xfdesktop')
    assert.equal(liveSessionNameOf('s6-svscan'), 's6-svscan')
    assert.equal(liveSessionNameOf('C:\\Program Files\\Claude\\claude.exe --mcp-config x'), null)
    assert.equal(liveSessionNameOf(`${NODE} ${ENTRY}`), null)
    assert.equal(liveSessionNameOf(''), null)
    assert.equal(liveSessionNameOf(null), null)
})

await test('duplicate supervisors on one port are counted, and the keeper is named', () => {
    const findings = duplicateSupervisorFindings({
        processes: [supervisorOn(7001, 8787, now - 3 * HOUR), supervisorOn(7002, 8787, now - HOUR), supervisorOn(7003, 8788, now - HOUR)],
        now,
    })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].port, 8787)
    assert.deepEqual(findings[0].pids, [7001, 7002])
    assert.equal(findings[0].kept_pid, 7002)
    assert.deepEqual(findings[0].duplicates, [7001])
})

await test('two supervisors whose order cannot be measured name no duplicate', () => {
    const findings = duplicateSupervisorFindings({ processes: [supervisorOn(7001, 8787, now - HOUR), supervisorOn(7002, 8787, now - HOUR)], now })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].kept_pid, null)
    assert.deepEqual(findings[0].duplicates, [])
})

await test('a clean host is not notable and nothing is signalled', async () => {
    const signalled = []
    const report = await leakWatchReport({ roots: [root], processes: [], now, signalPid: stubSignaller(signalled) })
    assert.equal(report.population.gm_processes, 0)
    assert.equal(report.notable, false)
    assert.equal(report.auto_apply.enabled, false)
    assert.deepEqual(report.auto_apply.applied, [])
    assert.deepEqual(signalled, [])
})

await test('an unattributed stdio server is visible before it is a leak', async () => {
    const report = await leakWatchReport({ roots: [root], processes: orphanTable(), now })
    assert.equal(report.population.gm_processes, 1)
    assert.equal(report.population.unattributed_servers, 1)
    assert.equal(report.population.retireable, 1)
    assert.equal(report.notable, true, 'an unattributed server is notable even below the population threshold')
    assert.equal(report.auto_apply.enabled, false)
    assert.deepEqual(report.auto_apply.applied, [])
    assert.match(formatLeakWatchLine(report), /1 gm-mcp process\(es\)/)
    assert.match(formatLeakWatchLine(report), /1 unattributed, 1 retireable/)
})

await test('the population warning fires once the count reaches the threshold', async () => {
    const table = [stdioServer(201, 1, now - HOUR), stdioServer(202, 1, now - HOUR)]
    const report = await leakWatchReport({ roots: [root], processes: table, now, warnAt: 2 })
    assert.equal(report.population.above_warn, true)
    assert.match(formatLeakWatchLine(report), /ABOVE the population warning threshold/)
})

await test('auto-apply is opt-in, and the watch itself is opt-out', () => {
    delete process.env.GM_MCP_LEAK_AUTO_APPLY
    assert.equal(autoApplyEnabled(), false)
    process.env.GM_MCP_LEAK_AUTO_APPLY = '1'
    assert.equal(autoApplyEnabled(), true)
    process.env.GM_MCP_LEAK_AUTO_APPLY = '0'
    assert.equal(autoApplyEnabled(), false)
    delete process.env.GM_MCP_LEAK_AUTO_APPLY

    delete process.env.GM_MCP_LEAK_WATCH
    assert.equal(leakWatchEnabled(), true)
    process.env.GM_MCP_LEAK_WATCH = '0'
    assert.equal(leakWatchEnabled(), false)
    delete process.env.GM_MCP_LEAK_WATCH
})

await test('the hourly pass is off when GM_MCP_LEAK_WATCH=0', async () => {
    process.env.GM_MCP_LEAK_WATCH = '0'
    try {
        assert.deepEqual(await runLeakWatchPass({ processes: orphanTable() }), { outcome: 'disabled' })
    } finally {
        delete process.env.GM_MCP_LEAK_WATCH
    }
})

await test('an old unattributed stdio server with no client above it is auto-retired', async () => {
    const signalled = []
    const report = await leakWatchReport({
        roots: [root],
        processes: orphanTable(),
        now,
        apply: true,
        httpPorts: [],
        signalPid: stubSignaller(signalled),
    })
    assert.deepEqual(signalled, [livePid], 'only the retireable stand-in is signalled')
    assert.equal(report.auto_apply.applied.length, 1)
    assert.equal(report.auto_apply.applied[0].pid, livePid)
    assert.equal(report.auto_apply.applied[0].transport, 'stdio')
    assert.deepEqual(report.auto_apply.skipped, [])
})

await test('the pid that answers /health is never auto-retired', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: livePid, version: 'test' }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const signalled = []
    try {
        const report = await leakWatchReport({
            roots: [root],
            processes: orphanTable(),
            now,
            apply: true,
            httpPorts: [port],
            signalPid: stubSignaller(signalled),
        })
        assert.equal(report.population.retireable, 1, 'the reaper alone would retire it')
        assert.deepEqual(signalled, [], 'the shared HTTP server is exempt')
        assert.equal(report.auto_apply.applied.length, 0)
        assert.deepEqual(report.auto_apply.skipped[0].blocked_by, ['not-shared-http-pid'])
    } finally {
        await new Promise((resolve) => server.close(resolve))
    }
})

await test('the per-pass budget caps what one pass may retire', async () => {
    const signalled = []
    const report = await leakWatchReport({
        roots: [root],
        processes: orphanTable(),
        now,
        apply: true,
        httpPorts: [],
        maxPerPass: 0,
        signalPid: stubSignaller(signalled),
    })
    assert.deepEqual(signalled, [])
    assert.deepEqual(report.auto_apply.skipped[0].blocked_by, ['per-pass-budget'])
})

const retireableFinding = (overrides = {}) => ({
    verdict: 'retire',
    transport: 'stdio',
    pid: 4242,
    started_at: now - 3 * HOUR,
    age_ms: 3 * HOUR,
    ...overrides,
})
const noAncestors = { client: null, session: null, unmeasured: false }
const blockedBy = (options) => autoApplyDecision({ finding: retireableFinding(), ancestors: noAncestors, ...options }).blocked_by

await test('the auto-retire guards each name what blocked them', () => {
    assert.deepEqual(autoApplyDecision({ finding: retireableFinding(), ancestors: noAncestors }).blocked_by, [])
    assert.deepEqual(blockedBy({ ancestors: { client: { pid: 7, command: '/usr/local/bin/claude --mcp-config /tmp/mcp.json' }, session: null, unmeasured: false } }), ['no-live-client-ancestor'])
    assert.deepEqual(blockedBy({ ancestors: { client: null, session: { pid: 8, command: '/usr/bin/xfdesktop' }, unmeasured: false } }), ['not-live-session'])
    assert.deepEqual(blockedBy({ ancestors: { client: null, session: null, unmeasured: true } }), ['ancestors-measured'])
    assert.deepEqual(blockedBy({ sharedPids: new Set([4242]) }), ['not-shared-http-pid'])
    assert.deepEqual(blockedBy({ finding: retireableFinding({ transport: 'http' }) }), ['candidate-is-stdio-server'])
    assert.deepEqual(blockedBy({ finding: retireableFinding({ verdict: 'keep' }) }), ['verdict-retire'])
    assert.deepEqual(blockedBy({ finding: retireableFinding({ pid: process.pid }) }), ['not-self'])
    assert.deepEqual(blockedBy({ finding: retireableFinding({ pid: 1 }) }), ['not-self'])
    assert.deepEqual(blockedBy({ appliedCount: 3, maxPerPass: 3 }), ['per-pass-budget'])
})

await test('an unmeasured start time is never read as an old age', () => {
    assert.deepEqual(blockedBy({ finding: retireableFinding({ started_at: null }) }), ['age-measured', 'age-over-floor'])
    assert.deepEqual(blockedBy({ finding: retireableFinding({ started_at: now - 60_000 }) }), ['age-over-floor'])
    assert.deepEqual(blockedBy({ finding: retireableFinding({ started_at: now - 31 * 60_000 }) }), [])
})

await test('an hourly pass that throws is recorded, and never rejected into the process', async () => {
    const previousSelfUpdate = process.env.GM_MCP_SELF_UPDATE
    const previousLogPath = process.env.GM_MCP_LOG_PATH
    process.env.GM_MCP_SELF_UPDATE = '0'
    process.env.GM_MCP_LOG_PATH = path.join(home, 'leak-watch.log')
    const unhandled = []
    const recordUnhandled = (error) => unhandled.push(error)
    process.on('unhandledRejection', recordUnhandled)
    let timer = null
    try {
        timer = scheduleStaleDeployedBundleChecks(null, async () => {
            throw new Error('hourly pass blew up')
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.deepEqual(unhandled, [], `the rejection escaped: ${unhandled.map((error) => error?.message).join(', ')}`)
    } finally {
        if (timer !== null) clearInterval(timer)
        process.off('unhandledRejection', recordUnhandled)
        if (previousSelfUpdate === undefined) delete process.env.GM_MCP_SELF_UPDATE
        else process.env.GM_MCP_SELF_UPDATE = previousSelfUpdate
        if (previousLogPath === undefined) delete process.env.GM_MCP_LOG_PATH
        else process.env.GM_MCP_LOG_PATH = previousLogPath
    }
})

await test('the ancestor walk sees a client or a desktop session several hops up', () => {
    const table = [
        stdioServer(4242, 500),
        row(500, 501, PARENT_COMMAND, now - HOUR),
        row(501, 1, '/usr/bin/xfdesktop', now - HOUR),
    ]
    const walk = parentWalker(table)
    assert.deepEqual(walk(4242, 500).map((step) => step.pid), [500, 501])
    const verdict = ancestorVerdict(walk(4242, 500))
    assert.equal(verdict.session.pid, 501)
    assert.equal(verdict.client, null)

    const clientTable = [stdioServer(4242, 500), row(500, 501, 'node /opt/relay.mjs', now - HOUR), row(501, 1, '/usr/local/bin/claude --mcp-config /tmp/mcp.json', now - HOUR)]
    const clientVerdict = ancestorVerdict(parentWalker(clientTable)(4242, 500))
    assert.equal(clientVerdict.client.pid, 501)
    assert.equal(clientVerdict.unmeasured, false)

    const brokenTable = [stdioServer(4242, 500)]
    assert.equal(ancestorVerdict(parentWalker(brokenTable)(4242, 500)).unmeasured, true)
})

console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failures.length} failure(s))`)
process.exit(failures.length === 0 ? 0 : 1)
