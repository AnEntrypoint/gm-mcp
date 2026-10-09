import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HEARTBEAT_LIVE_MS = 10 * 60 * 1000
const STALE_HEARTBEAT_MS = 11 * 60 * 1000
const ROW_ID = 'gm-heartbeat-manual-refresh-counts-active-workers-dead'
const WORKER_SESSION = 'spoint-witness-hb-worker'
const BYSTANDER_SESSION = 'spoint-witness-hb-bystander'

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const sourceDispatch = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dispatch.js')
const dispatchFile = path.resolve(flags.dispatch ?? sourceDispatch)

const results = []
const check = (name, ok, detail = '') => {
    results.push(ok === true)
    console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const ageMs = file => Date.now() - fs.statSync(file).mtimeMs

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-heartbeat-witness-'))
let exitCode = 1
try {
    const tools = path.join(scratch, 'tools')
    const agentplugHome = path.join(scratch, 'agentplug')
    fs.mkdirSync(tools)
    fs.mkdirSync(agentplugHome)
    process.env.GM_TOOLS_DIR = tools
    process.env.AGENTPLUG_HOME = agentplugHome
    process.env.GM_MCP_DEV_SYNC = '0'
    const { gmDispatch } = await import(pathToFileURL(dispatchFile).href)

    const root = path.join(scratch, 'project')
    const pool = path.join(root, '.gm', 'pool')
    fs.mkdirSync(pool, { recursive: true })
    const heartbeat = path.join(pool, `${WORKER_SESSION}.live`)
    const bystanderHeartbeat = path.join(pool, `${BYSTANDER_SESSION}.live`)
    const heartbeatText = `session: ${WORKER_SESSION}\nrow: ${ROW_ID}\nstart: 2026-10-09T00:00:00Z\n`
    fs.writeFileSync(heartbeat, heartbeatText)
    const stamp = new Date(Date.now() - STALE_HEARTBEAT_MS)
    fs.utimesSync(heartbeat, stamp, stamp)

    check('heartbeat starts outside the 10-minute live window', ageMs(heartbeat) > HEARTBEAT_LIVE_MS, `age_ms=${Math.round(ageMs(heartbeat))}`)

    const reply = String(await gmDispatch({ verb: 'pool-observe', body: {}, session_id: WORKER_SESSION, cwd: root }, undefined, undefined))
    check('dispatch reached the runner check and stopped there, spawning nothing', reply.includes('runner-not-installed'), reply.split('\n')[0])
    check('one dispatch refreshes the worker heartbeat into the live window', ageMs(heartbeat) <= HEARTBEAT_LIVE_MS, `age_ms=${Math.round(ageMs(heartbeat))}`)
    check('heartbeat body is untouched by the refresh', fs.readFileSync(heartbeat, 'utf8') === heartbeatText)
    const liveNames = fs.readdirSync(pool).filter(name => name.endsWith('.live') && ageMs(path.join(pool, name)) <= HEARTBEAT_LIVE_MS)
    check('pool liveness rule counts the worker live afterwards', liveNames.includes(`${WORKER_SESSION}.live`), `live=${JSON.stringify(liveNames)}`)

    await gmDispatch({ verb: 'pool-observe', body: {}, session_id: BYSTANDER_SESSION, cwd: root }, undefined, undefined)
    check('a session with no heartbeat file gains none', !fs.existsSync(bystanderHeartbeat))

    exitCode = results.every(Boolean) ? 0 : 1
} catch (error) {
    check('witness ran to completion', false, String(error?.stack || error).split('\n').slice(0, 3).join(' | '))
} finally {
    fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`checks ${results.filter(Boolean).length}/${results.length}`)
console.log(exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(exitCode)
