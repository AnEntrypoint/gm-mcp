import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const srcDir = path.resolve(flags.src ?? path.join(path.dirname(SCRIPT), '..', 'src'))
const moduleFile = path.join(srcDir, 'transport-guard.js')
const INSTALLERS = ['installStdioGuards', 'keepServingOnAsyncFailure', 'logSignalExits']
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
const DIVERTED_TEXT_CAP = 400
const STDOUT_FIXTURES = [
    { as: 'string', text: '{"jsonrpc":"2.0","id":"f1","result":{}}\n', frame: true },
    { as: 'buffer', text: '{"jsonrpc":"2.0","id":"f2"}\n', frame: true },
    { as: 'string', text: '{"jsonrpc":"2.0","id":"f3","result":{"items":[1,2]}}\n', frame: true },
    { as: 'string', text: 'plain text line\n', frame: false },
    { as: 'string', text: '[{"jsonrpc":"2.0","id":"x"}]\n', frame: false },
    { as: 'string', text: '{not json\n', frame: false },
    { as: 'string', text: ' {"jsonrpc":"2.0","id":"x"}\n', frame: false },
    { as: 'string', text: '{"jsonrpc":"2.0","id":"x"} trailing\n', frame: false },
    { as: 'string', text: 'null\n', frame: false },
    { as: 'string', text: '', frame: false },
    { as: 'string', text: `${'z'.repeat(500)}\n`, frame: false },
]

const parseJson = text => {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}
const isJsonObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const linesOf = text => text.split('\n').filter(line => line.length > 0)
const normalized = value => path.resolve(String(value ?? '')).replace(/\\/g, '/').toLowerCase()

const runChild = async () => {
    const guard = await import(pathToFileURL(flags.module).href)
    const emitFrame = value => process.stdout.write(`${JSON.stringify(value)}\n`)
    switch (flags.child) {
        case 'install': {
            emitFrame({ probe: 'install', returned: guard.installStdioGuards() })
            break
        }
        case 'stdout': {
            guard.installStdioGuards()
            let syncCallbacks = 0
            const returns = JSON.parse(process.env.TG_STDOUT_FIXTURES).map(({ as, text }) => process.stdout.write(
                as === 'buffer' ? Buffer.from(text, 'utf8') : text,
                () => { syncCallbacks += 1 },
            ))
            emitFrame({ probe: 'stdout', returns, sync_callbacks: syncCallbacks })
            console.log('hello', 1, { a: 1 })
            console.info('info', 'line')
            emitFrame({ probe: 'done' })
            break
        }
        case 'async': {
            guard.installStdioGuards()
            setTimeout(() => { throw new Error('tg-uncaught-probe') }, 5)
            setTimeout(() => { Promise.reject(new Error('tg-rejection-probe')) }, 10)
            setTimeout(() => {
                process.stdin.emit('error', new Error('tg-stdin-probe'))
                process.stderr.emit('error', new Error('tg-stderr-probe'))
            }, 15)
            setTimeout(() => emitFrame({ probe: 'async', alive: true }), 25)
            break
        }
        case 'signal': {
            guard.logSignalExits()
            process.emit(flags.sig)
            emitFrame({ probe: 'after-signal' })
            break
        }
        case 'pipe': {
            guard.installStdioGuards()
            for (const code of ['EPIPE', 'EPIPE', 'ECONNRESET', undefined]) {
                const error = new Error(`stream ${code ?? 'without-code'} probe`)
                if (code) error.code = code
                process.stdout.emit('error', error)
            }
            process.stdin.emit('end')
            emitFrame({ probe: 'pipe', alive: true })
            break
        }
        default:
            throw new Error(`unknown child scenario: ${flags.child}`)
    }
}

const runParent = async () => {
    const outcomes = []
    const expect = (label, got, want) => {
        const ok = JSON.stringify(got) === JSON.stringify(want)
        outcomes.push(ok)
        const show = value => String(JSON.stringify(value)).slice(0, 240)
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${show(got)} want ${show(want)}`}`)
    }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-guard-witness-'))
    try {
        const home = path.join(scratch, 'home')
        const tools = path.join(scratch, 'tools')
        const agentplugHome = path.join(scratch, 'agentplug')
        const logFile = path.join(scratch, 'diagnostics.log')
        for (const dir of [home, tools, agentplugHome]) fs.mkdirSync(dir, { recursive: true })
        const sandbox = {
            HOME: home,
            USERPROFILE: home,
            GM_TOOLS_DIR: tools,
            AGENTPLUG_HOME: agentplugHome,
            GM_MCP_LOG_PATH: logFile,
            GM_MCP_DEV_SYNC: '0',
        }
        Object.assign(process.env, sandbox)

        const guard = await import(pathToFileURL(moduleFile).href)
        const { inflightDispatchCount } = await import(pathToFileURL(path.join(srcDir, 'dispatch.js')).href)
        const { BUNDLE_VERSION } = await import(pathToFileURL(path.join(srcDir, 'bundle-version.js')).href)

        expect('exports: the module exports exactly the three installers', Object.keys(guard).sort(), [...INSTALLERS].sort())
        expect('exports: every installer is a function', INSTALLERS.map(name => typeof guard[name]), INSTALLERS.map(() => 'function'))
        expect('import: the dispatch.js inflight counter reads 0 when no dispatch runs', inflightDispatchCount(), 0)
        expect('import: the bundle version is a dotted version string', /^\d+\.\d+\.\d+$/.test(BUNDLE_VERSION), true)

        const runSandboxed = (scenario, env = {}, extraArgs = []) => {
            const result = spawnSync(process.execPath, [SCRIPT, `--child=${scenario}`, `--module=${moduleFile}`, ...extraArgs], {
                cwd: scratch,
                env: { ...process.env, ...env },
                encoding: 'utf8',
                timeout: 60000,
                windowsHide: true,
            })
            const records = fs.existsSync(logFile)
                ? linesOf(fs.readFileSync(logFile, 'utf8'))
                    .filter(line => line.startsWith('{'))
                    .map(parseJson)
                    .filter(record => record?.pid === result.pid)
                : []
            return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', records }
        }

        const install = runSandboxed('install')
        const installObjects = linesOf(install.stdout).map(parseJson).filter(isJsonObject)
        const starts = install.records.filter(record => record.event === 'start')
        const start = starts[0] ?? {}
        expect('install: the child exits 0', install.status, 0)
        expect('install: installStdioGuards returns true', installObjects.find(o => o.probe === 'install')?.returned, true)
        expect('install: exactly one start diagnostic reaches the sandbox log', starts.length, 1)
        expect('install: start reports the module bundle version', start.bundle_version, BUNDLE_VERSION)
        expect('install: start argv is the witness invocation', [path.basename(String(start.argv?.[0] ?? '')), start.argv?.[1], start.argv?.length], [path.basename(SCRIPT), '--child=install', 3])
        expect('install: start reports the sandbox working directory', normalized(start.cwd), normalized(scratch))
        expect('install: start reports the running node version', start.node, process.version)
        expect('install: start log is the sandbox log file', normalized(start.log), normalized(logFile))
        expect('install: the exit guard records code 0', install.records.filter(record => record.event === 'exit').map(record => record.code), [0])

        const stdout = runSandboxed('stdout', { TG_STDOUT_FIXTURES: JSON.stringify(STDOUT_FIXTURES) })
        const stdoutLines = linesOf(stdout.stdout)
        const stdoutObjects = stdoutLines.map(parseJson)
        const probe = stdoutObjects.find(o => isJsonObject(o) && o.probe === 'stdout') ?? {}
        const diverted = stdout.records.filter(record => record.event === 'stdout-write-diverted')
        const divertedFixtures = STDOUT_FIXTURES.filter(fixture => !fixture.frame)
        const stderrPlain = linesOf(stdout.stderr).filter(line => !line.startsWith('gm-mcp: '))
        expect('stdout: the child exits 0', stdout.status, 0)
        expect('stdout: every stdout line is a JSON object frame', stdoutObjects.every(isJsonObject), true)
        expect('stdout: frames pass through in write order and nothing else reaches stdout', stdoutObjects.filter(isJsonObject).map(o => o.id ?? o.probe), ['f1', 'f2', 'f3', 'stdout', 'done'])
        expect('stdout: diverted writes are recorded with their text capped at 400 characters', diverted.map(record => record.text), divertedFixtures.map(fixture => fixture.text.slice(0, DIVERTED_TEXT_CAP)))
        expect('stdout: diverted records report the full chunk length as bytes', diverted.map(record => record.bytes), divertedFixtures.map(fixture => fixture.text.length))
        expect('stdout: diverted writes invoke their callback synchronously', probe.sync_callbacks, divertedFixtures.length)
        expect('stdout: every write returns true', (probe.returns ?? []).every(value => value === true), true)
        expect('console: console.log is rerouted to stderr with its arguments joined', stderrPlain.includes('hello 1 [object Object]'), true)
        expect('console: console.info is rerouted to the same stderr path', stderrPlain.includes('info line'), true)
        expect('console: no console output reaches stdout', stdoutLines.some(line => line.includes('hello') || line.includes('info line')), false)

        const asyncRun = runSandboxed('async')
        const asyncEvents = name => asyncRun.records.filter(record => record.event === name)
        const asyncFrames = linesOf(asyncRun.stdout).map(parseJson).filter(isJsonObject)
        expect('async: the child survives an uncaught exception, a rejection and stream errors, then exits 0', asyncRun.status, 0)
        expect('async: the uncaught exception is logged with its message', asyncEvents('uncaught-exception').map(record => String(record.error).includes('tg-uncaught-probe')), [true])
        expect('async: the unhandled rejection is logged with its message', asyncEvents('unhandled-rejection').map(record => String(record.error).includes('tg-rejection-probe')), [true])
        expect('async: the stdin error is logged with its message', asyncEvents('stdin-error').map(record => String(record.error).includes('tg-stdin-probe')), [true])
        expect('async: the stderr error is logged with its message', asyncEvents('stderr-error').map(record => String(record.error).includes('tg-stderr-probe')), [true])
        expect('async: the exit guard records code 0', asyncEvents('exit').map(record => record.code), [0])
        expect('async: every failure record reports dispatches_inflight 0', ['uncaught-exception', 'unhandled-rejection', 'stdin-error', 'stderr-error', 'exit'].flatMap(name => asyncEvents(name)).map(record => record.dispatches_inflight), [0, 0, 0, 0, 0])
        expect('async: the process kept serving after the failures', asyncFrames.some(frame => frame.probe === 'async' && frame.alive === true), true)

        for (const signal of SIGNALS) {
            const run = runSandboxed('signal', {}, [`--sig=${signal}`])
            const exits = run.records.filter(record => record.event === 'exit')
            expect(`signal ${signal}: the handler exits the process with code 0`, run.status, 0)
            expect(`signal ${signal}: the exit record names reason signal, the signal and dispatches_inflight 0`, exits.map(record => [record.reason, record.signal, record.dispatches_inflight]), [['signal', signal, 0]])
            expect(`signal ${signal}: control never returns to the caller after the handler`, run.stdout.includes('after-signal'), false)
        }

        const pipe = runSandboxed('pipe')
        const pipeGone = pipe.records.filter(record => record.event === 'stdout-pipe-gone')
        const pipeFrames = linesOf(pipe.stdout).map(parseJson).filter(isJsonObject)
        expect('pipe: the child exits 0 after the client stops reading', pipe.status, 0)
        expect('pipe: one stdout-pipe-gone record per distinct error code', pipeGone.map(record => record.code), ['EPIPE', 'ECONNRESET', 'unknown'])
        expect('pipe: each record carries its stream error', pipeGone.map(record => String(record.error).includes('probe')), [true, true, true])
        expect('pipe: each record says the server stays up', pipeGone.map(record => String(record.note).includes('server stays up')), [true, true, true])
        expect('pipe: each record reports dispatches_inflight 0', pipeGone.map(record => record.dispatches_inflight), [0, 0, 0])
        expect('pipe: the stdin end is logged once', pipe.records.filter(record => record.event === 'stdin-ended').length, 1)
        expect('pipe: the process kept serving after the pipe loss', pipeFrames.some(frame => frame.probe === 'pipe' && frame.alive === true), true)
    } catch (error) {
        expect('witness ran to completion', String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '), 'ran to completion')
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
    }
    const passed = outcomes.filter(Boolean).length
    const exitCode = outcomes.length > 0 && passed === outcomes.length ? 0 : 1
    console.log(`checks ${passed}/${outcomes.length}`)
    console.log(exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
    process.exitCode = exitCode
}

if (flags.child) {
    await runChild()
} else {
    await runParent()
}
