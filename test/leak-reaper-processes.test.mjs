import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'gm-reaper-proc-home-'))
const root = mkdtempSync(path.join(tmpdir(), 'gm-reaper-proc-root-'))
process.env.AGENTPLUG_HOME = home
mkdirSync(path.join(root, '.gm', 'exec-spool'), { recursive: true })

const { readProcessTable } = await import('../src/process-table.js')
const { classifyGmServerCommand, flagPortOf } = await import('../src/gm-cmdline.js')
const { assessUnattributedServers, reapReport, liveMcpClientInParentChain } = await import('../src/leak-reaper.js')
const { listHttpSupervisors, retireDuplicateHttpSupervisors, supervisorStateFilePath } = await import('../src/singleton.js')

const ENTRY = '/opt/gm-mcp/bin/gm-mcp-server.mjs'
const NODE = '/usr/local/bin/node'
const now = Date.now()

const liveServerStandIn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
const liveServerStandInPid = liveServerStandIn.pid

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
    try { liveServerStandIn.kill() } catch {}
    for (const dir of [home, root]) {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
}
process.on('exit', cleanup)

const row = (pid, ppid, command, startedAt = null) => ({ pid, ppid, started_at: startedAt, command })

await test('the posix table is read as pid, ppid, start time and command', () => {
    const text = [
        `  101     1 Mon Oct 13 12:34:56 2025 ${NODE} ${ENTRY}`,
        `  102   101 Mon Oct 13 12:35:56 2025 ${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`,
        '',
    ].join('\n')
    const exec = (file, args) => {
        assert.equal(file, 'ps')
        if (!args.some((arg) => arg.includes('lstart='))) throw new Error('ps: lstart unsupported here')
        return text
    }
    const table = readProcessTable({ exec, platform: 'linux' })
    assert.equal(table.length, 2)
    assert.equal(table[0].pid, 101)
    assert.equal(table[0].ppid, 1)
    assert.equal(table[0].command, `${NODE} ${ENTRY}`)
    assert.equal(table[0].started_at, Date.parse('Mon Oct 13 12:34:56 2025'))
    assert.equal(table[1].pid, 102)
    assert.equal(table[1].ppid, 101)
})

await test('a ps without lstart still yields a table, with the start time unmeasured', () => {
    const exec = (file, args) => {
        if (args.some((arg) => arg.includes('lstart='))) throw new Error('ps: illegal option -- o')
        return `  101     1 ${NODE} ${ENTRY}\n`
    }
    const table = readProcessTable({ exec, platform: 'linux' })
    assert.equal(table.length, 1)
    assert.equal(table[0].pid, 101)
    assert.equal(table[0].command, `${NODE} ${ENTRY}`)
    assert.equal(table[0].started_at, null)
})

await test('the win32 table carries the CIM creation date and the parent', () => {
    const text = `101|1|20251013123456.000000-420|${NODE} ${ENTRY}\n102|101|20251013123556.000000-420|${NODE} ${ENTRY} http-supervise --port 8787\n`
    const table = readProcessTable({ exec: () => text, platform: 'win32' })
    assert.equal(table.length, 2)
    assert.equal(table[0].pid, 101)
    assert.equal(table[0].ppid, 1)
    assert.equal(table[0].started_at, Date.UTC(2025, 9, 13, 12, 34, 56) + 420 * 60_000)
    assert.equal(table[1].command, `${NODE} ${ENTRY} http-supervise --port 8787`)
})

await test('a command is classified only when node runs the gm-mcp entry', () => {
    assert.deepEqual(classifyGmServerCommand(`${NODE} ${ENTRY}`), { entry: ENTRY, transport: 'stdio', port: null })
    assert.deepEqual(classifyGmServerCommand(`"${NODE}" "${ENTRY}" --http --port 8787 --host 127.0.0.1`), { entry: ENTRY, transport: 'http', port: 8787 })
    assert.deepEqual(classifyGmServerCommand(`${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`), { entry: ENTRY, transport: 'supervisor', port: 8787 })
    assert.equal(classifyGmServerCommand(`${NODE} /opt/other.mjs --http`), null)
    assert.equal(classifyGmServerCommand(`/usr/bin/python3 ${ENTRY}`), null)
    assert.equal(classifyGmServerCommand(''), null)
    assert.equal(flagPortOf(['--port=8899']), 8899)
    assert.equal(flagPortOf(['--port']), null)
})

await test('an unattributed stdio server with no client above it is retireable', async () => {
    const table = [
        row(liveServerStandInPid, process.pid, `${NODE} ${ENTRY}`, now - 5_000),
        row(process.pid, 1, `node ${process.argv[1]}`, now - 10_000),
    ]
    const findings = await assessUnattributedServers({ roots: [root], processes: table, now })
    const finding = findings.find((entry) => entry.pid === liveServerStandInPid)
    assert.ok(finding, 'the stdio server appears in the report')
    assert.equal(finding.source, 'unattributed-server')
    assert.equal(finding.transport, 'stdio')
    assert.equal(finding.attributed, false)
    assert.equal(finding.verdict, 'retire', `verdict was ${finding.verdict}: ${JSON.stringify(finding.protected_by ?? finding.unmeasured)}`)
    const value = (name) => finding.predicates.find((entry) => entry.predicate === name)?.value
    assert.equal(value('orphan-evidence'), 'unattributed')
    assert.equal(value('not-live-http-instance'), 'stdio-no-port')
    assert.equal(value('no-live-mcp-client'), 'no-client-in-parent-chain')
})

await test('a stdio server with a live MCP client above it is kept', async () => {
    const table = [
        row(liveServerStandInPid, process.pid, `${NODE} ${ENTRY}`, now - 5_000),
        row(process.pid, 1, '/usr/local/bin/claude --mcp-config /tmp/mcp.json', now - 10_000),
    ]
    const findings = await assessUnattributedServers({ roots: [root], processes: table, now })
    const finding = findings.find((entry) => entry.pid === liveServerStandInPid)
    assert.equal(finding.verdict, 'keep', `verdict was ${finding.verdict}`)
    assert.ok((finding.protected_by ?? []).includes('no-live-mcp-client'), `protected by ${JSON.stringify(finding.protected_by)}`)
    assert.match(finding.predicates.find((entry) => entry.predicate === 'no-live-mcp-client').value, /^client:/)
})

await test('a server whose port still answers /health is never a candidate', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: 4242, version: 'test' }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
        const table = [
            row(liveServerStandInPid, process.pid, `${NODE} ${ENTRY} --http --port ${port} --host 127.0.0.1`, now - 5_000),
            row(process.pid, 1, `node ${process.argv[1]}`, now - 10_000),
        ]
        const findings = await assessUnattributedServers({ roots: [root], processes: table, now })
        const finding = findings.find((entry) => entry.pid === liveServerStandInPid)
        assert.equal(finding.transport, 'http')
        assert.equal(finding.verdict, 'keep', `verdict was ${finding.verdict}`)
        assert.deepEqual(finding.protected_by, ['not-live-http-instance'])
        assert.equal(finding.predicates.find((entry) => entry.predicate === 'not-live-http-instance').value, `health-answers-on-port-${port}`)
    } finally {
        await new Promise((resolve) => server.close(resolve))
    }
})

await test('a reparented server (ppid 1) is abandoned as well as unattributed', async () => {
    const table = [row(liveServerStandInPid, 1, `${NODE} ${ENTRY}`, now - 5_000)]
    const findings = await assessUnattributedServers({ roots: [root], processes: table, now })
    const finding = findings.find((entry) => entry.pid === liveServerStandInPid)
    assert.equal(finding.verdict, 'retire', `verdict was ${finding.verdict}: ${JSON.stringify(finding.protected_by ?? finding.unmeasured)}`)
    assert.equal(finding.predicates.find((entry) => entry.predicate === 'orphan-evidence').value, 'unattributed+parent-abandoned')
})

await test('an unreadable ancestor leaves the client question unmeasured, so nothing is retired', async () => {
    const table = [
        row(liveServerStandInPid, process.pid, `${NODE} ${ENTRY}`, now - 5_000),
        row(process.pid, 1, '', now - 10_000),
    ]
    const chain = liveMcpClientInParentChain(liveServerStandInPid, process.pid, table)
    assert.equal(chain.value, null)
    const findings = await assessUnattributedServers({ roots: [root], processes: table, now })
    const finding = findings.find((entry) => entry.pid === liveServerStandInPid)
    assert.equal(finding.verdict, 'unknown', `verdict was ${finding.verdict}`)
    assert.deepEqual(finding.unmeasured, ['no-live-mcp-client'])
})

await test('a supervisor process is left to the supervisor sweep, not the reaper', async () => {
    const table = [row(liveServerStandInPid, 1, `${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`)]
    const findings = await assessUnattributedServers({ roots: [root], processes: table, now })
    assert.equal(findings.length, 0)
})

await test('reap --json carries the new pass, and a dry run still signals nothing', async () => {
    const table = [
        row(liveServerStandInPid, process.pid, `${NODE} ${ENTRY}`, now - 5_000),
        row(process.pid, 1, `node ${process.argv[1]}`, now - 10_000),
    ]
    const report = await reapReport({ roots: [root], apply: false, unattributed: table })
    assert.deepEqual(report.unattributed_scan, { enabled: true, scanned: 2 })
    const finding = report.findings.find((entry) => entry.source === 'unattributed-server')
    assert.ok(finding, 'the unattributed server is in the report')
    assert.equal(finding.pid, liveServerStandInPid)
    assert.equal(report.retired.length, 0)

    const skipped = await reapReport({ roots: [root], apply: false, unattributed: false })
    assert.deepEqual(skipped.unattributed_scan, { enabled: false, scanned: 0 })
    assert.equal(skipped.findings.filter((entry) => entry.source === 'unattributed-server').length, 0)
})

const supervisorRows = (startedAt) => [
    row(7001, 1, `${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`, startedAt[0]),
    row(7002, 1, `${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`, startedAt[1]),
    row(7003, 1, `${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`, startedAt[2]),
]

await test('only supervisor processes on a port are read as supervisors', () => {
    const rows = listHttpSupervisors({ processes: [
        ...supervisorRows([now - 1000, now - 2000, now - 3000]),
        row(7004, 1, `${NODE} ${ENTRY} --http --port 8787 --host 127.0.0.1`),
        row(7005, 1, `${NODE} ${ENTRY} http-supervise --port 8788 --interval 15`),
    ] })
    assert.deepEqual(rows.map((entry) => entry.pid), [7001, 7002, 7003, 7005])
    assert.deepEqual([...new Set(rows.map((entry) => entry.port))], [8787, 8788])
})

await test('the freshest supervisor is kept and the older duplicates are retired', () => {
    const signalled = []
    const retired = retireDuplicateHttpSupervisors({
        processes: [...supervisorRows([now - 17 * 86_400_000, now - 86_400_000, now - 3_600_000]), row(process.pid, 1, `${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`, now - 30 * 86_400_000)],
        now,
        signalPid: (pid) => { signalled.push(pid); return true },
    })
    assert.deepEqual(signalled.slice().sort((left, right) => left - right), [7001, 7002])
    assert.equal(retired.length, 2)
    assert.ok(retired.every((entry) => entry.kept_pid === 7003 && entry.port === 8787 && entry.reason === 'duplicate-supervisor'))
    assert.equal(signalled.includes(process.pid), false, 'the sweep never signals itself')
})

await test('a fresh claim in the state file outranks an older start time', () => {
    writeFileSync(supervisorStateFilePath(8787), JSON.stringify({ port: 8787, pid: liveServerStandInPid, ts: now, interval_ms: 15_000, server_pid: 8000 }, null, 2), 'utf8')
    const signalled = []
    const retired = retireDuplicateHttpSupervisors({
        processes: [row(liveServerStandInPid, 1, `${NODE} ${ENTRY} http-supervise --port 8787 --interval 15`, now - 30 * 86_400_000), ...supervisorRows([now - 17 * 86_400_000, now - 86_400_000, now - 3_600_000])],
        now,
        signalPid: (pid) => { signalled.push(pid); return true },
    })
    assert.deepEqual(signalled.slice().sort((left, right) => left - right), [7001, 7002, 7003])
    assert.ok(retired.every((entry) => entry.kept_pid === liveServerStandInPid))
    rmSync(supervisorStateFilePath(8787), { force: true })
})

await test('two supervisors that cannot be ordered are both left alone', () => {
    rmSync(supervisorStateFilePath(8787), { force: true })
    const signalled = []
    const retired = retireDuplicateHttpSupervisors({
        processes: supervisorRows([now - 60_000, now - 60_000, now - 60_000]),
        now,
        signalPid: (pid) => { signalled.push(pid); return true },
    })
    assert.deepEqual(signalled, [])
    assert.deepEqual(retired, [])
})

await test('one supervisor on a port is not a duplicate', () => {
    const signalled = []
    const retired = retireDuplicateHttpSupervisors({
        processes: [supervisorRows([now - 1000, now - 2000, now - 3000])[0]],
        now,
        signalPid: (pid) => { signalled.push(pid); return true },
    })
    assert.deepEqual(signalled, [])
    assert.deepEqual(retired, [])
})

console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failures.length} failure(s))`)
process.exit(failures.length === 0 ? 0 : 1)
