import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'gm-leak-orphans-home-'))
const root = mkdtempSync(path.join(tmpdir(), 'gm-leak-orphans-root-'))
process.env.AGENTPLUG_HOME = home
mkdirSync(path.join(root, '.gm', 'exec-spool'), { recursive: true })

const { recordChild } = await import('../src/child-ledger.js')
const { formatLeakWatchLine, formatOrphanLine, leakWatchReport } = await import('../src/leak-watch.js')
const {
    DEFAULT_CMDLINE_CHARS,
    DEFAULT_ORPHAN_DUTY,
    DEFAULT_ORPHAN_MIN_AGE_MS,
    DEFAULT_ORPHAN_RSS_MB,
    orphanDuty,
    orphanFindings,
    orphanMinAgeMs,
    orphanRssMb,
    orphanScanEnabled,
    parseProcStat,
    parseProcStatus,
    readProcProcess,
} = await import('../src/orphan-scan.js')

const now = Date.now()
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

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
    for (const dir of [home, root]) {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
}
process.on('exit', cleanup)

const row = (pid, ppid, command, startedAt = null) => ({ pid, ppid, started_at: startedAt, command })

// The 2026-10-15 shape: reparented to pid 1, 500 MB RSS, 18.4 CPU seconds over 2000 seconds
// alive -- duty 0.0092, against a live run of the same binary that was still burning CPU.
const LEAK = { rss_kb: 512_000, cpu_seconds: 18.4, threads: 4, state: 'S', cmdline: '/usr/bin/litebox_runner_linux_userland --oci-image docker.io/linuxserver/webtop:debian-xfce' }
const procOf = (over = {}) => ({ ...LEAK, ...over })
const stubProcs = (map) => (pid) => map[Number(pid)] ?? null

const LEAK_ROW = row(5001, 1, LEAK.cmdline, now - 2000 * SECOND)
const pids = (result) => result.items.map((item) => item.pid)

await test('the thresholds read their env, and junk falls back to the default', () => {
    assert.equal(orphanRssMb(), DEFAULT_ORPHAN_RSS_MB)
    assert.equal(orphanDuty(), DEFAULT_ORPHAN_DUTY)
    assert.equal(orphanMinAgeMs(), DEFAULT_ORPHAN_MIN_AGE_MS)
    assert.equal(DEFAULT_ORPHAN_RSS_MB, 150)
    assert.equal(DEFAULT_ORPHAN_DUTY, 0.02)
    assert.equal(DEFAULT_ORPHAN_MIN_AGE_MS, 900_000)

    const saved = { ...process.env }
    try {
        process.env.GM_MCP_LEAK_ORPHAN_RSS_MB = '300'
        process.env.GM_MCP_LEAK_ORPHAN_DUTY = '0.5'
        process.env.GM_MCP_LEAK_ORPHAN_MIN_AGE_MS = '60000'
        assert.equal(orphanRssMb(), 300)
        assert.equal(orphanDuty(), 0.5)
        assert.equal(orphanMinAgeMs(), 60_000)
        process.env.GM_MCP_LEAK_ORPHAN_RSS_MB = 'not-a-number'
        process.env.GM_MCP_LEAK_ORPHAN_DUTY = '0'
        assert.equal(orphanRssMb(), DEFAULT_ORPHAN_RSS_MB, 'a threshold that is not a number keeps the default')
        assert.equal(orphanDuty(), DEFAULT_ORPHAN_DUTY, '0 is not a duty threshold, it is an unset reading')
    } finally {
        for (const name of ['GM_MCP_LEAK_ORPHAN_RSS_MB', 'GM_MCP_LEAK_ORPHAN_DUTY', 'GM_MCP_LEAK_ORPHAN_MIN_AGE_MS']) {
            if (saved[name] === undefined) delete process.env[name]
            else process.env[name] = saved[name]
        }
    }
})

await test('the orphan scan is opt-out, like the watch it rides on', () => {
    delete process.env.GM_MCP_LEAK_ORPHANS
    assert.equal(orphanScanEnabled(), true)
    process.env.GM_MCP_LEAK_ORPHANS = '0'
    assert.equal(orphanScanEnabled(), false)
    const off = orphanFindings({ table: [LEAK_ROW], roots: [root], now, readProc: stubProcs({ 5001: procOf() }) })
    assert.equal(off.enabled, false)
    assert.equal(off.count, 0)
    delete process.env.GM_MCP_LEAK_ORPHANS
})

await test('a reparented heavyweight that burns no CPU is named with its duty', () => {
    const found = orphanFindings({ table: [LEAK_ROW], roots: [root], now, readProc: stubProcs({ 5001: procOf() }) })
    assert.deepEqual(pids(found), [5001])
    const item = found.items[0]
    assert.equal(item.ppid, 1)
    assert.equal(item.rss_mb, 500)
    assert.equal(item.age_ms, 2000 * SECOND)
    assert.equal(item.cpu_seconds, 18.4)
    assert.equal(item.duty, 0.0092, `duty was ${item.duty}`)
    assert.equal(item.threads, 4)
    assert.equal(item.state, 'S')
    assert.match(item.cmdline, /litebox_runner_linux_userland/)
    assert.deepEqual(found.thresholds, { rss_mb: 150, duty: 0.02, min_age_ms: 900_000 })
})

await test('a process still burning CPU is a live run, not a leak', () => {
    const found = orphanFindings({ table: [LEAK_ROW], roots: [root], now, readProc: stubProcs({ 5001: procOf({ cpu_seconds: 400 }) }) })
    assert.deepEqual(pids(found), [], `duty 0.2 is above the threshold: ${JSON.stringify(found.items)}`)
})

await test('a light process and a young process are both left alone', () => {
    const light = orphanFindings({ table: [LEAK_ROW], roots: [root], now, readProc: stubProcs({ 5001: procOf({ rss_kb: 100_000 }) }) })
    assert.deepEqual(pids(light), [], '97.7 MB is under the 150 MB floor')
    const young = orphanFindings({ table: [row(5002, 1, LEAK.cmdline, now - 30 * SECOND)], roots: [root], now, readProc: stubProcs({ 5002: procOf() }) })
    assert.deepEqual(pids(young), [], 'a 30 s old process has not leaked yet')
    const fresh = orphanFindings({ table: [LEAK_ROW], roots: [root], now, readProc: stubProcs({ 5001: procOf() }), minAgeMs: 3 * HOUR })
    assert.deepEqual(pids(fresh), [], 'a raised floor keeps the same process out')
})

await test('a process that still has a parent was not reparented to init', () => {
    const found = orphanFindings({ table: [row(5003, 4242, LEAK.cmdline, now - 2000 * SECOND)], roots: [root], now, readProc: stubProcs({ 5003: procOf() }) })
    assert.deepEqual(pids(found), [])
})

await test('a gm-mcp process is one of ours, so the census reports it and the orphan list does not', () => {
    const command = `/usr/local/bin/node /opt/gm-mcp/bin/gm-mcp-server.mjs http-supervise --port 8787 --interval 15`
    const found = orphanFindings({ table: [row(5013, 1, command, now - 4 * HOUR)], roots: [root], now, readProc: stubProcs({ 5013: procOf() }) })
    assert.deepEqual(pids(found), [], 'a heavyweight idle gm-mcp supervisor is a census finding, not an orphan')
})

await test('a pid gm spawned is a ledger child, not an orphan', () => {
    const recorded = recordChild({ pid: 5004, root: null, verb: 'bash', kind: 'exec' })
    assert.ok(recorded, 'the ledger row was written')
    const table = [row(5004, 1, LEAK.cmdline, now - 2000 * SECOND), row(5005, 1, LEAK.cmdline, now - 2000 * SECOND)]
    const found = orphanFindings({ table, roots: [root], now, readProc: stubProcs({ 5004: procOf(), 5005: procOf() }) })
    assert.deepEqual(pids(found), [5005], 'the attributed pid is skipped and the unattributed twin is still named')
})

await test('the process running the scan is never its own orphan', () => {
    const table = [row(process.pid, 1, `${process.argv[0]} ${process.argv[1]}`, now - 4 * HOUR), row(1, 0, 's6-svscan', now - 4 * HOUR), row(2, 0, 'kthreadd', now - 4 * HOUR)]
    const found = orphanFindings({ table, roots: [root], now, readProc: stubProcs({ [process.pid]: procOf(), 1: procOf(), 2: procOf() }) })
    assert.deepEqual(pids(found), [], 'self, pid 1 and pid 2 are never candidates')
})

await test('an unmeasured reading is not evidence: no age, no rss or no /proc means not flagged', () => {
    const noAge = orphanFindings({ table: [row(5006, 1, LEAK.cmdline, null)], roots: [root], now, readProc: stubProcs({ 5006: procOf() }) })
    assert.deepEqual(pids(noAge), [], 'a start time the table never gave is not an old process')

    const noRss = orphanFindings({ table: [LEAK_ROW], roots: [root], now, readProc: stubProcs({ 5001: procOf({ rss_kb: null }) }) })
    assert.deepEqual(pids(noRss), [], 'an unmeasured VmRSS is not a heavyweight')

    const noProc = orphanFindings({ table: [LEAK_ROW], roots: [root], now, readProc: stubProcs({}) })
    assert.deepEqual(pids(noProc), [], 'a /proc that cannot be read leaves the duty unmeasured, not low')
})

await test('several orphans are reported heaviest first, with the cmdline truncated', () => {
    const table = [
        row(5007, 1, 'small', now - 2000 * SECOND),
        row(5008, 1, 'big', now - 2000 * SECOND),
        row(5009, 1, 'x'.repeat(400), now - 2000 * SECOND),
    ]
    const found = orphanFindings({
        table,
        roots: [root],
        now,
        readProc: stubProcs({
            5007: procOf({ rss_kb: 200_000, cmdline: 'small' }),
            5008: procOf({ rss_kb: 900_000, cmdline: 'big' }),
            5009: procOf({ cmdline: 'x'.repeat(400) }),
        }),
    })
    assert.deepEqual(pids(found), [5008, 5009, 5007])
    assert.equal(found.count, 3)
    assert.equal(found.items[1].cmdline.length, DEFAULT_CMDLINE_CHARS)
    assert.equal(found.items[2].rss_mb, 195.3)
})

await test('/proc/<pid>/stat is read through the comm field, which may hold spaces and parens', () => {
    // field 3 (state) is token 0 after the last ')', so utime (field 14) is token 11 and
    // starttime (field 22) is token 19.
    const tokens = ['S', '1', '5000', '5000', '0', '-1', '4194304', '100', '0', '0', '0', '1500', '340', '0', '0', '20', '0', '4', '0', '987654']
    const stat = `5010 (litebox runner (x) y) ${tokens.join(' ')} 0 0 0 0 0`
    assert.deepEqual(parseProcStat(stat), { cpu_seconds: 18.4, starttime_ticks: 987_654 })
    assert.equal(parseProcStat(''), null)
    assert.equal(parseProcStat('5010 no-parens-here S 1'), null)
})

await test('/proc/<pid>/status gives rss, threads and state', () => {
    const status = parseProcStatus(['Name:\tlitebox', 'State:\tS (sleeping)', 'Threads:\t4', 'VmRSS:\t  512000 kB', 'VmSize:\t 900000 kB'].join('\n'))
    assert.deepEqual(status, { rss_kb: 512_000, threads: 4, state: 'S' })
    assert.deepEqual(parseProcStatus('Name:\tlitebox'), { rss_kb: null, threads: null, state: null })
    assert.equal(parseProcStatus(''), null)
})

await test('readProcProcess reads /proc directly, with no ps in the path', () => {
    const files = {
        '/proc/5011/stat': `5011 (litebox runner) ${['S', '1', '5000', '5000', '0', '-1', '4194304', '100', '0', '0', '0', '1500', '340', '0', '0', '20', '0', '4', '0', '987654'].join(' ')} 0`,
        '/proc/5011/status': 'State:\tS (sleeping)\nThreads:\t4\nVmRSS:\t  512000 kB\n',
        '/proc/5011/cmdline': '/usr/bin/litebox\0--oci-image\0webtop\0',
    }
    const readFile = (target) => {
        if (files[target] === undefined) throw new Error(`ENOENT ${target}`)
        return files[target]
    }
    assert.deepEqual(readProcProcess(5011, { readFile }), {
        pid: 5011,
        rss_kb: 512_000,
        cpu_seconds: 18.4,
        threads: 4,
        state: 'S',
        cmdline: '/usr/bin/litebox --oci-image webtop',
    })
    assert.equal(readProcProcess(9999, { readFile }), null, 'a pid with no /proc entry is unmeasured')
    assert.equal(readProcProcess(0, { readFile }), null)
    assert.equal(readProcProcess(null, { readFile }), null)
})

await test('the report carries the orphans section, and it is notable on its own', async () => {
    const report = await leakWatchReport({ roots: [root], processes: [LEAK_ROW], now, httpPorts: [], readProc: stubProcs({ 5001: procOf() }) })
    assert.equal(report.orphans.count, 1)
    assert.equal(report.orphans.items[0].pid, 5001)
    assert.equal(report.population.retireable, 0, 'an orphan gm never spawned is not a reap finding')
    assert.equal(report.notable, true)
    assert.equal(report.auto_apply.applied.length, 0)
    assert.match(formatLeakWatchLine(report), /1 orphaned heavyweight process\(es\)/)
    assert.match(formatLeakWatchLine(report), /500 MB/)
    assert.match(formatOrphanLine(report.orphans.items[0]), /^ {2}ORPHAN pid 5001 -- 500 MB RSS, 2000s alive, 18\.4s cpu \(duty 0\.0092\)/)
})

await test('a host with only live processes reports no orphans and nothing is signalled', async () => {
    const signalled = []
    const report = await leakWatchReport({
        roots: [root],
        processes: [row(5012, 4242, 'busy', now - 2000 * SECOND)],
        now,
        httpPorts: [],
        apply: true,
        readProc: stubProcs({ 5012: procOf({ cpu_seconds: 400 }) }),
        signalPid: (pid) => { signalled.push(pid); return true },
    })
    assert.equal(report.orphans.count, 0)
    assert.equal(report.notable, false)
    assert.deepEqual(signalled, [], 'orphan detection never signals anything')
    assert.equal(report.auto_apply.applied.length, 0)
})

console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failures.length} failure(s))`)
process.exit(failures.length === 0 ? 0 : 1)
