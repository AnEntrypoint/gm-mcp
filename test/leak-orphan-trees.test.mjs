import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'gm-leak-trees-home-'))
process.env.AGENTPLUG_HOME = home
mkdirSync(path.join(home, 'empty'), { recursive: true })

const { formatLeakWatchLine, formatOrphanTreeLine, leakWatchReport } = await import('../src/leak-watch.js')
const {
    DEFAULT_TREE_MAX_DEPTH,
    DEFAULT_TREE_MAX_MEMBERS,
    orphanFindings,
    parseProcStatPpid,
    readProcPpidIndex,
} = await import('../src/orphan-scan.js')

const now = Date.now()
const SECOND = 1000

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

process.on('exit', () => {
    try { rmSync(home, { recursive: true, force: true }) } catch {}
})

const row = (pid, ppid, command, startedAt = null) => ({ pid, ppid, started_at: startedAt, command })
const HEAVY = { rss_kb: 512_000, cpu_seconds: 1, threads: 4, state: 'S', cmdline: 'litebox-runner' }
const LIGHT_KB = 1024
const procsOf = (map) => (pid) => map[Number(pid)] ?? null
const orphanRoot = (pid, startedAgoSec = 2000) => row(pid, 1, 'litebox-runner', now - startedAgoSec * SECOND)
const findTrees = (over) => orphanFindings({ table: [], roots: [], now, ...over })

await test('an orphan root and its two children are one tree, with members counted and RSS summed', () => {
    const table = [orphanRoot(6001)]
    const ppidMap = new Map([[6001, 1], [6002, 6001], [6003, 6001], [6004, 6002]])
    const readProc = procsOf({
        6001: HEAVY,
        6002: { rss_kb: 256_000, cpu_seconds: 400 },
        6003: { rss_kb: 128_000, cpu_seconds: 400 },
        6004: { rss_kb: 102_400, cpu_seconds: 400 },
    })
    const found = findTrees({ table, ppidMap, readProc })
    assert.deepEqual(found.items.map((item) => item.pid), [6001], 'only the ppid-1 root is an orphan item')
    assert.equal(found.trees.length, 1)
    const [tree] = found.trees
    assert.equal(tree.root_pid, 6001)
    assert.equal(tree.member_count, 3)
    assert.deepEqual(tree.members.map((member) => member.pid), [6002, 6003, 6004])
    assert.deepEqual(tree.members.map((member) => member.depth), [1, 1, 2])
    assert.equal(tree.rss_mb, 975, 'root 500 + 250 + 125 + 100')
    assert.equal(tree.max_depth, 2)
    assert.equal(tree.unmeasured_members, 0)
    assert.equal(tree.truncated, null)
    assert.equal(Object.hasOwn(found.items[0], 'tree'), false, 'items keep their existing shape')
})

await test('a child whose parent is a live process belongs to no orphan tree', () => {
    const table = [orphanRoot(7100), row(7001, 4242, 'busy', now - 2000 * SECOND)]
    const ppidMap = new Map([[7100, 1], [7101, 7100], [7001, 4242], [7002, 7001]])
    const readProc = procsOf({ 7100: HEAVY, 7001: HEAVY, 7002: HEAVY, 7101: { rss_kb: LIGHT_KB } })
    const found = findTrees({ table, ppidMap, readProc })
    assert.deepEqual(found.items.map((item) => item.pid), [7100])
    const members = found.trees.flatMap((tree) => tree.members.map((member) => member.pid))
    assert.deepEqual(members, [7101], 'the live parent 7001 and its child 7002 are not in the tree')
})

await test('a ppid index that loops back to the root terminates and counts each pid once', () => {
    const table = [orphanRoot(8001)]
    const ppidMap = new Map([[8001, 8003], [8002, 8001], [8003, 8002], [8010, 8011], [8011, 8010]])
    const found = findTrees({ table, ppidMap, readProc: procsOf({ 8001: HEAVY, 8002: { rss_kb: LIGHT_KB }, 8003: { rss_kb: LIGHT_KB } }) })
    assert.equal(found.trees[0].member_count, 2, 'the loop back to 8001 is the root, already seen')
    assert.deepEqual(found.trees[0].members.map((member) => member.pid), [8002, 8003])
    assert.equal(found.trees[0].truncated, null)
})

await test('the depth bound stops a chain at 16 levels and says it was truncated', () => {
    const table = [orphanRoot(9001)]
    const ppidMap = new Map([[9001, 1]])
    for (let pid = 9002; pid <= 9021; pid += 1) ppidMap.set(pid, pid - 1)
    const found = findTrees({ table, ppidMap, readProc: procsOf({ 9001: HEAVY }) })
    assert.equal(DEFAULT_TREE_MAX_DEPTH, 16)
    const [tree] = found.trees
    assert.equal(tree.member_count, 16)
    assert.equal(tree.max_depth, 16)
    assert.equal(tree.truncated, 'depth', 'a level-17 child existed, so the cut is a truncation')
})

await test('the depth bound does not claim truncation when the chain ends inside it', () => {
    const table = [orphanRoot(9050)]
    const ppidMap = new Map([[9050, 1], [9051, 9050], [9052, 9051]])
    const found = findTrees({ table, ppidMap, readProc: procsOf({ 9050: HEAVY }) })
    assert.equal(found.trees[0].member_count, 2)
    assert.equal(found.trees[0].truncated, null)
})

await test('the count bound stops a wide tree and says it was truncated', () => {
    const table = [orphanRoot(9101)]
    const ppidMap = new Map([[9101, 1]])
    for (let pid = 9102; pid <= 9111; pid += 1) ppidMap.set(pid, 9101)
    const found = findTrees({ table, ppidMap, readProc: procsOf({ 9101: HEAVY }), treeMaxMembers: 4 })
    assert.equal(DEFAULT_TREE_MAX_MEMBERS, 512)
    const [tree] = found.trees
    assert.equal(tree.member_count, 4)
    assert.deepEqual(tree.members.map((member) => member.pid), [9102, 9103, 9104, 9105])
    assert.equal(tree.truncated, 'count')
})

await test('a member /proc cannot read is counted as unmeasured, not as zero RSS', () => {
    const table = [orphanRoot(9201)]
    const ppidMap = new Map([[9201, 1], [9202, 9201], [9203, 9201]])
    const found = findTrees({ table, ppidMap, readProc: procsOf({ 9201: HEAVY, 9203: { rss_kb: LIGHT_KB } }) })
    const [tree] = found.trees
    assert.equal(tree.member_count, 2)
    assert.equal(tree.unmeasured_members, 1)
    assert.equal(tree.members[0].rss_mb, null)
    assert.equal(tree.rss_mb, 501, 'root 500 + the one measured member at 1 MB')
})

await test('the scanning process and its lineage are never a tree member', () => {
    const table = [orphanRoot(9301)]
    const ppidMap = new Map([[9301, 1], [9302, 9301], [process.pid, 9302], [9303, process.pid]])
    const found = findTrees({ table, ppidMap, readProc: procsOf({ 9301: HEAVY }) })
    const [tree] = found.trees
    assert.equal(tree.member_count, 0, 'the walk stops at the scanner, so nothing below it is reported')
    assert.equal(tree.skipped_lineage, 1)
    assert.ok(!tree.members.some((member) => member.pid === 9303))
})

await test('a non-orphan root produces no tree, and an empty table produces none either', () => {
    const none = findTrees({ table: [row(9401, 4242, 'busy', now - 2000 * SECOND)], ppidMap: new Map([[9402, 9401]]), readProc: procsOf({ 9401: HEAVY }) })
    assert.deepEqual(none.trees, [])
    assert.equal(findTrees({ table: [], ppidMap: new Map(), readProc: procsOf({}) }).trees.length, 0)
    const disabled = orphanFindings({ table: [orphanRoot(9402)], roots: [], now, enabled: false })
    assert.deepEqual(disabled.trees, [])
})

await test('the /proc ppid index reads only numeric pids and skips the ones that vanish', () => {
    const files = {
        '/fake/1/stat': '1 (systemd) S 0 1 1 0 -1 4194560',
        '/fake/42/stat': '42 (node (x) y) S 7 42 42 0 -1 4194560',
    }
    const readFile = (target) => {
        if (files[target] === undefined) throw new Error(`ENOENT ${target}`)
        return files[target]
    }
    const index = readProcPpidIndex({ procRoot: '/fake', readFile, listDir: () => ['1', '42', 'self', '7', 'net'] })
    assert.deepEqual([...index.entries()], [[1, 0], [42, 7]])
    assert.equal(parseProcStatPpid('12 (a) b) S 5 0'), 5, 'comm with a paren is counted from the last paren')
    assert.equal(parseProcStatPpid(''), null)
    assert.equal(readProcPpidIndex({ procRoot: '/nope', listDir: () => { throw new Error('ENOENT') } }).size, 0)
})

await test('the report and the line carry the tree as one finding per orphan root', async () => {
    const table = [orphanRoot(6001)]
    const ppidMap = new Map([[6001, 1], [6002, 6001], [6003, 6001], [6004, 6002]])
    const readProc = procsOf({ 6001: HEAVY, 6002: { rss_kb: 256_000 }, 6003: { rss_kb: 128_000 }, 6004: { rss_kb: 102_400 } })
    const report = await leakWatchReport({ roots: [path.join(home, 'empty')], processes: table, now, httpPorts: [], readProc, ppidMap })
    assert.equal(report.orphans.count, 1, 'one orphan root, not four processes')
    assert.equal(report.orphans.trees[0].member_count, 3)
    assert.match(formatLeakWatchLine(report), /1 orphan tree\(s\) with descendants: 6001 \(\+3, 975 MB\)/)
    assert.equal(formatOrphanTreeLine(report.orphans.trees[0]), '  TREE root 6001 -- 3 descendant(s), 975 MB RSS with root, depth 2 -- pids 6002,6003,6004')
    assert.equal(report.notable, true)
    assert.equal(report.auto_apply.applied.length, 0, 'the tree pass never signals anything')
})

console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failures.length} failure(s))`)
process.exit(failures.length === 0 ? 0 : 1)
