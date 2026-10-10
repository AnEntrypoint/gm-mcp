import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LOG_NAME = 'gm-mcp-server.log'
const REPEAT_WINDOW_MS = 60 * 1000
const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_REPEAT_KEYS = 512
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const T0_ISO = new Date(T0).toISOString()

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const modulePath = path.resolve(flags.module ?? path.join(scriptDir, '..', 'src', 'server-log.js'))
const fixtureRoot = path.resolve(flags.fixture ?? os.tmpdir())

const results = []
const expect = (name, got, want) => {
    const same = typeof want === 'object' && want !== null
        ? JSON.stringify(got) === JSON.stringify(want)
        : Object.is(got, want)
    results.push(same)
    console.log(same ? `ok   ${name}` : `FAIL ${name} -- got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const realDateNow = Date.now
const realStderrWrite = process.stderr.write
let clock = T0
let stderrLines = []
Date.now = () => clock

const captureStderr = () => {
    stderrLines = []
    process.stderr.write = chunk => {
        stderrLines.push(String(chunk))
        return true
    }
}

const setEnv = (name, value) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

let loads = 0
const loadFresh = () => {
    loads += 1
    return import(`${pathToFileURL(modulePath).href}?instance=${loads}`)
}

const linesOf = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
const recordsOf = file => linesOf(file).map(line => JSON.parse(line))

const scenario = async (name, body) => {
    captureStderr()
    clock = T0
    try {
        await body()
    } catch (error) {
        expect(`${name} runs to completion`, String(error?.stack ?? error).split('\n')[0], 'no exception')
    }
}

const runScenarios = async scratch => {
    await scenario('logFilePath resolves the override, then the tools directory', async () => {
        const mod = await loadFresh()
        const toolsDir = path.join(scratch, 'tools')
        const overridePath = path.join(scratch, 'override', 'server.log')
        setEnv('GM_TOOLS_DIR', toolsDir)
        setEnv('GM_MCP_LOG_PATH', `  ${overridePath}  `)
        expect('GM_MCP_LOG_PATH is trimmed, then used as the log file', mod.logFilePath(), overridePath)
        setEnv('GM_MCP_LOG_PATH', '   ')
        expect('a whitespace-only GM_MCP_LOG_PATH falls back to GM_TOOLS_DIR', mod.logFilePath(), path.join(toolsDir, LOG_NAME))
        setEnv('GM_MCP_LOG_PATH', undefined)
        setEnv('GM_TOOLS_DIR', `  ${toolsDir}  `)
        expect('GM_TOOLS_DIR is trimmed and the file is named gm-mcp-server.log', mod.logFilePath(), path.join(toolsDir, LOG_NAME))
        setEnv('GM_MCP_LOG_PATH', 'relative/server.log')
        expect('a relative GM_MCP_LOG_PATH resolves against the working directory', mod.logFilePath(), path.resolve('relative', 'server.log'))
        expect('logFilePath creates nothing on disk', fs.existsSync(toolsDir), false)
    })

    await scenario('appendDiagnostic writes one record and mirrors it to stderr', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'one', 'server.log')
        setEnv('GM_MCP_LOG_PATH', file)
        const returned = mod.appendDiagnostic('probe-once', { n: 1, ms: 5 })
        const lines = linesOf(file)
        const rec = lines[0] ? JSON.parse(lines[0]) : {}
        expect('one append writes one file line', lines.length, 1)
        expect('the call writes one gm-mcp: line to stderr', stderrLines, [`gm-mcp: ${returned}\n`])
        expect('the return value is the record that was written', returned, lines[0])
        expect('record keys are ts, pid, event, then the caller fields', Object.keys(rec), ['ts', 'pid', 'event', 'n', 'ms'])
        expect('record ts is the ISO time of the call', rec.ts, T0_ISO)
        expect('record pid is the writing process', rec.pid, process.pid)
        expect('record event is the event name', rec.event, 'probe-once')
        expect('caller fields are kept verbatim', [rec.n, rec.ms], [1, 5])
        expect('a missing log directory is created', fs.existsSync(path.dirname(file)), true)
    })

    await scenario('appendDiagnostic never throws, even when the log path or stderr fails', async () => {
        const mod = await loadFresh()
        const dirAsLog = path.join(scratch, 'is-a-directory')
        fs.mkdirSync(dirAsLog, { recursive: true })
        setEnv('GM_MCP_LOG_PATH', dirAsLog)
        let threw = false
        let returned = ''
        try {
            returned = mod.appendDiagnostic('unwritable', { k: 1 })
        } catch {
            threw = true
        }
        expect('a log path that is a directory does not throw', threw, false)
        expect('the record is still returned', returned.includes('"event":"unwritable"'), true)
        expect('the record still reaches stderr', stderrLines.length, 1)

        const brokenStderrFile = path.join(scratch, 'broken-stderr', 'server.log')
        setEnv('GM_MCP_LOG_PATH', brokenStderrFile)
        process.stderr.write = () => {
            throw new Error('stderr closed')
        }
        let threwOnStderr = false
        try {
            mod.appendDiagnostic('broken-stderr', {})
        } catch {
            threwOnStderr = true
        }
        captureStderr()
        expect('a failing stderr write does not throw out of appendDiagnostic', threwOnStderr, false)
        expect('a failing stderr write does not stop the file record', recordsOf(brokenStderrFile).map(r => r.event), ['broken-stderr'])
    })

    await scenario('with no GM_MCP_LOG_PATH the record goes to GM_TOOLS_DIR', async () => {
        const mod = await loadFresh()
        const tools = path.join(scratch, 'tools-fresh')
        setEnv('GM_MCP_LOG_PATH', undefined)
        setEnv('GM_TOOLS_DIR', tools)
        mod.appendDiagnostic('default-path')
        const records = recordsOf(path.join(tools, LOG_NAME))
        expect('the default log file is created under GM_TOOLS_DIR and holds the record', records.map(r => r.event), ['default-path'])
        expect('a bare call records only the envelope', Object.keys(records[0] ?? {}), ['ts', 'pid', 'event'])
    })

    await scenario('repeats of the same event and fields are suppressed within the window', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'dedup', 'server.log')
        setEnv('GM_MCP_LOG_PATH', file)
        clock = T0
        mod.appendDiagnostic('dup', { k: 'a', ms: 1 })
        clock = T0 + 1000
        mod.appendDiagnostic('dup', { k: 'a', ms: 2 })
        clock = T0 + 2000
        mod.appendDiagnostic('dup', { k: 'a', pid: 999 })
        clock = T0 + 3000
        mod.appendDiagnostic('dup', { k: 'a', inflight: 4, dispatches_inflight: 5 })
        clock = T0 + 4000
        mod.appendDiagnostic('dup', { k: 'b' })
        expect('ms, pid, inflight and dispatches_inflight do not make a repeat distinct', recordsOf(file).map(r => r.k), ['a', 'b'])
        expect('every call still reaches stderr', stderrLines.length, 5)
    })

    await scenario('a repeat is written at exactly 60 s, preceded by a count of what it replaced', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'window', 'server.log')
        setEnv('GM_MCP_LOG_PATH', file)
        const start = T0 + 100000
        clock = start
        mod.appendDiagnostic('edge', { x: 1 })
        clock = start + REPEAT_WINDOW_MS - 1
        mod.appendDiagnostic('edge', { x: 1 })
        expect('a repeat at 59,999 ms is suppressed', recordsOf(file).length, 1)
        clock = start + REPEAT_WINDOW_MS
        mod.appendDiagnostic('edge', { x: 1 })
        let records = recordsOf(file)
        expect('a repeat at exactly 60,000 ms is written after a summary line', records.map(r => r.event), ['edge', 'repeat-suppressed', 'edge'])
        const summary = records[1]
        expect('the summary names the suppressed event', summary.of, 'edge')
        expect('the summary counts the one suppressed repeat', summary.count, 1)
        expect('the summary states the window', summary.window_ms, REPEAT_WINDOW_MS)
        expect('the summary is stamped with the write time', summary.ts, new Date(start + REPEAT_WINDOW_MS).toISOString())
        clock = start + REPEAT_WINDOW_MS + 1000
        mod.appendDiagnostic('edge', { x: 1 })
        clock = start + 2 * REPEAT_WINDOW_MS
        mod.appendDiagnostic('edge', { x: 1 })
        records = recordsOf(file)
        expect('the next window restarts its own count', records.filter(r => r.event === 'repeat-suppressed').map(r => r.count), [1, 1])
    })

    await scenario('field order does not change whether a repeat is distinct', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'order', 'server.log')
        setEnv('GM_MCP_LOG_PATH', file)
        clock = T0
        mod.appendDiagnostic('ordered', { a: 1, b: 2 })
        clock = T0 + 1
        mod.appendDiagnostic('ordered', { b: 2, a: 1 })
        mod.appendDiagnostic('ordered', { a: 1, b: 3 })
        expect('reordered identical fields are one key, and a changed value is another', recordsOf(file).map(r => [r.a, r.b]), [[1, 2], [1, 3]])
    })

    await scenario('different events never share a repeat key', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'events', 'server.log')
        setEnv('GM_MCP_LOG_PATH', file)
        clock = T0
        mod.appendDiagnostic('evA', { x: 1 })
        mod.appendDiagnostic('evB', { x: 1 })
        expect('the same fields under two events are both written', recordsOf(file).map(r => r.event), ['evA', 'evB'])
    })

    await scenario('the repeat table is capped at 512 keys and cleared when pruning frees nothing', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'cap', 'server.log')
        setEnv('GM_MCP_LOG_PATH', file)
        clock = T0
        for (let i = 0; i < MAX_REPEAT_KEYS; i += 1) mod.appendDiagnostic('cap', { i })
        expect('512 distinct keys are all written', linesOf(file).length, MAX_REPEAT_KEYS)
        mod.appendDiagnostic('cap', { i: MAX_REPEAT_KEYS })
        mod.appendDiagnostic('cap', { i: 0 })
        clock = T0 + 1
        mod.appendDiagnostic('cap', { i: 0 })
        expect('after the 513th key clears the table, an earlier key is written again', recordsOf(file).filter(r => r.i === 0).length, 2)
        expect('a key tracked after the clear is suppressed on repeat', linesOf(file).length, MAX_REPEAT_KEYS + 2)
    })

    await scenario('stale keys are pruned before the table is cleared', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'prune', 'server.log')
        setEnv('GM_MCP_LOG_PATH', file)
        clock = T0
        for (let i = 0; i < 300; i += 1) mod.appendDiagnostic('old', { i })
        clock = T0 + REPEAT_WINDOW_MS
        for (let i = 0; i < 300; i += 1) mod.appendDiagnostic('new', { i })
        clock = T0 + REPEAT_WINDOW_MS + 1
        mod.appendDiagnostic('new', { i: 5 })
        expect('the 300 fresh keys are all written and the repeat of one is suppressed', recordsOf(file).filter(r => r.event === 'new').length, 300)
    })

    await scenario('a log is rotated to .1 only once it grows past 2 MiB', async () => {
        const mod = await loadFresh()
        const file = path.join(scratch, 'rotate', 'server.log')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const probeLine = `${JSON.stringify({ ts: T0_ISO, pid: process.pid, event: 'rotate', n: 1 })}\n`
        fs.writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES - Buffer.byteLength(probeLine, 'utf8')))
        setEnv('GM_MCP_LOG_PATH', file)
        clock = T0
        mod.appendDiagnostic('rotate', { n: 1 })
        expect('a log that lands exactly on 2 MiB is not rotated', fs.statSync(file).size, MAX_LOG_BYTES)
        expect('no .1 file exists at exactly 2 MiB', fs.existsSync(`${file}.1`), false)
        mod.appendDiagnostic('rotate', { n: 2 })
        expect('a log one line past 2 MiB is renamed to .1', fs.existsSync(`${file}.1`), true)
        expect('the live log is gone after rotation', fs.existsSync(file), false)
        expect('the rotated file keeps the oversized content', fs.statSync(`${file}.1`).size > MAX_LOG_BYTES, true)
        mod.appendDiagnostic('rotate', { n: 3 })
        expect('the next append starts a fresh live log', recordsOf(file).map(r => r.n), [3])
    })

    await scenario('describeError', async () => {
        const mod = await loadFresh()
        const failure = new Error('boom')
        expect('an Error is described by its stack', mod.describeError(failure), failure.stack)
        const stacklessFailure = new TypeError('bad')
        stacklessFailure.stack = ''
        expect('an Error without a stack is described as name: message', mod.describeError(stacklessFailure), 'TypeError: bad')
        expect('a string is described as itself', mod.describeError('plain'), 'plain')
        expect('a number is described by String()', mod.describeError(42), '42')
        expect('null is described by String()', mod.describeError(null), 'null')
    })
}

const main = async () => {
    fs.mkdirSync(fixtureRoot, { recursive: true })
    const scratch = fs.mkdtempSync(path.join(fixtureRoot, 'server-log-witness-'))
    const savedLogPath = process.env.GM_MCP_LOG_PATH
    const savedToolsDir = process.env.GM_TOOLS_DIR
    try {
        console.log(`module under test: ${modulePath}`)
        await runScenarios(scratch)
    } finally {
        Date.now = realDateNow
        process.stderr.write = realStderrWrite
        setEnv('GM_MCP_LOG_PATH', savedLogPath)
        setEnv('GM_TOOLS_DIR', savedToolsDir)
        fs.rmSync(scratch, { recursive: true, force: true })
    }
}

try {
    await main()
} catch (error) {
    expect('witness ran to completion', String(error?.stack ?? error).split('\n')[0], 'no exception')
}

const passed = results.filter(Boolean).length
const ok = results.length > 0 && passed === results.length
console.log(`checks ${passed}/${results.length}`)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = ok ? 0 : 1
