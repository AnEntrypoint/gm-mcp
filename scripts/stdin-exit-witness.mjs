import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUNDLE = path.join(repoRoot, 'bin', 'gm-mcp-server.js')
const EXIT_BUDGET_MS = 5000
const READY_BUDGET_MS = 20000
const READY_LINE = 'connected, serving on stdio'

const HOLDER_SOURCE = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const errFd = fs.openSync(process.env.GM_ERR_FILE, 'a')
const child = spawn(process.execPath, [process.env.GM_BUNDLE], { stdio: ['inherit', 'ignore', errFd] })
process.stdout.write('server-pid ' + child.pid + '\\n')
setInterval(() => {}, 1000)
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sandboxEnv = (scratch) => ({
    ...process.env,
    HOME: path.join(scratch, 'home'),
    USERPROFILE: path.join(scratch, 'home'),
    GM_TOOLS_DIR: path.join(scratch, 'tools'),
    AGENTPLUG_HOME: path.join(scratch, 'agentplug'),
    GM_MCP_LOG_PATH: path.join(scratch, 'diagnostics.log'),
    GM_MCP_NO_HTTP_SINGLETON: '1',
    GM_MCP_HTTP_SUPERVISOR: '0',
    GM_MCP_SELF_UPDATE: '0',
    GM_MCP_DEV_SYNC: '0',
})

const waitForText = async (file, text, budgetMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(text)) return true
        await sleep(50)
    }
    return false
}

const isGone = (pid) => {
    try {
        const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0]
        return state === 'Z' || state === 'X'
    } catch {
        return true
    }
}

const waitGone = async (pid, budgetMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
        if (isGone(pid)) return Date.now()
        await sleep(50)
    }
    return null
}

const stdinCloseScenario = async (scratch) => {
    fs.mkdirSync(scratch, { recursive: true })
    const child = spawn(process.execPath, [BUNDLE], { cwd: scratch, env: sandboxEnv(scratch), stdio: ['pipe', 'ignore', 'pipe'] })
    const errFile = path.join(scratch, 'stdin-close.err')
    child.stderr.on('data', (chunk) => fs.appendFileSync(errFile, chunk))
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
    try {
        if (!await waitForText(errFile, READY_LINE, READY_BUDGET_MS)) return { ready: false, exited: false, elapsed: null }
        const closedAt = Date.now()
        child.stdin.end()
        const timer = sleep(EXIT_BUDGET_MS).then(() => 'timeout')
        const outcome = await Promise.race([exited.then((code) => ({ code })), timer.then(() => 'timeout')])
        return { ready: true, exited: outcome !== 'timeout', elapsed: Date.now() - closedAt }
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
}

const parentDeathScenario = async (scratch) => {
    fs.mkdirSync(scratch, { recursive: true })
    const errFile = path.join(scratch, 'parent-death.err')
    const holder = spawn(process.execPath, ['-e', HOLDER_SOURCE], {
        cwd: scratch,
        env: { ...sandboxEnv(scratch), GM_BUNDLE: BUNDLE, GM_ERR_FILE: errFile },
        stdio: ['pipe', 'pipe', 'inherit'],
    })
    let serverPid = null
    try {
        const pidLine = await new Promise((resolve) => {
            let buffered = ''
            holder.stdout.on('data', (chunk) => {
                buffered += chunk
                const match = /server-pid (\d+)/.exec(buffered)
                if (match) resolve(Number(match[1]))
            })
            setTimeout(() => resolve(null), READY_BUDGET_MS)
        })
        serverPid = pidLine
        if (serverPid === null) return { ready: false, exited: false, elapsed: null }
        if (!await waitForText(errFile, READY_LINE, READY_BUDGET_MS)) return { ready: false, exited: false, elapsed: null }
        const killedAt = Date.now()
        holder.kill('SIGKILL')
        const goneAt = await waitGone(serverPid, EXIT_BUDGET_MS)
        return { ready: true, exited: goneAt !== null, elapsed: goneAt === null ? null : goneAt - killedAt }
    } finally {
        if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
        holder.stdin.end()
        if (serverPid !== null && !isGone(serverPid)) {
            try { process.kill(serverPid, 'SIGKILL') } catch { }
        }
    }
}

const main = async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-exit-witness-'))
    const outcomes = []
    const expect = (label, ok, detail) => {
        outcomes.push(ok)
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
    }
    try {
        const stdinRun = await stdinCloseScenario(path.join(scratch, 'a'))
        expect('stdin close: the server reaches its ready line', stdinRun.ready)
        expect(`stdin close: the server exits within ${EXIT_BUDGET_MS} ms of stdin end`, stdinRun.exited && stdinRun.elapsed <= EXIT_BUDGET_MS, `elapsed ${stdinRun.elapsed} ms`)

        const parentRun = await parentDeathScenario(path.join(scratch, 'b'))
        expect('parent death: the server reaches its ready line under a live holder', parentRun.ready)
        expect(`parent death: the server exits within ${EXIT_BUDGET_MS} ms of its parent dying with stdin still open`, parentRun.exited && parentRun.elapsed <= EXIT_BUDGET_MS, `elapsed ${parentRun.elapsed} ms`)
    } catch (error) {
        expect('witness ran to completion', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
    }
    const passed = outcomes.filter(Boolean).length
    console.log(`checks ${passed}/${outcomes.length}`)
    console.log(outcomes.length > 0 && passed === outcomes.length ? 'RESULT: PASS' : 'RESULT: FAIL')
    process.exitCode = outcomes.length > 0 && passed === outcomes.length ? 0 : 1
}

await main()
