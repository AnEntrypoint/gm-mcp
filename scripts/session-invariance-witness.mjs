import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const here = path.dirname(fileURLToPath(import.meta.url))
const dispatchModule = path.resolve(flags.module ?? path.join(here, '..', 'src', 'dispatch.js'))
const root = path.resolve(flags.root ?? path.join(here, '..', '..'))
const SESSION_A = 'invariance-a-' + process.pid
const SESSION_B = 'invariance-b-' + process.pid
const READ_ONLY_VERBS = ['health', 'phase-status']
const STRIPPED_KEYS = new Set([
    'dispatch_id', 'session_id', 'elapsed_ms', 'ms', 'timing', 'now', 'now_ms', 'ts', 'ts_ms',
    'pid', 'admission_waited_ms', 'mtimeMs', 'mtime_ms', 'guest_elapsed_ms', 'duration_ms',
    'uptime_ms', 'started_at', 'updated_at', 'requested_at',
    'admission_band', 'admission_decision', 'admission_waited_ms', 'request_fingerprint',
    'dispatch_waited_ms', 'dispatch_wait_split', 'claim_observed', 'exec_timed',
    'stale', 'bundle_stale', 'bundle_served_version', 'bundle_served_sha', 'bundle_installed_version', 'bundle_installed_sha', 'bundle_reloadable',
])
const TIMING_KEY = /(^|_)(ms|age_ms|at)$|^last_event(_|$)/
const SPOOL_NAME = /-\d{10,}-\d+(?=\.json|\b)/g
const DISPATCH_ID = /\d{10,}-\d+-[0-9a-f]{8,}/g
const PID_PATH = /([\\/][\w.-]*?)-\d{2,7}(?=[-.\\/])/g

const normalize = text => text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .filter(line => {
        const key = /^\s*-?\s*([A-Za-z_][\w-]*)\s*:/.exec(line)
        return !(key && (STRIPPED_KEYS.has(key[1]) || TIMING_KEY.test(key[1])))
    })
    .map(line => line.split(root).join('<root>').split(SESSION_A).join('<session>').split(SESSION_B).join('<session>').replace(DISPATCH_ID, '<dispatch>').replace(SPOOL_NAME, '-<ts>').replace(PID_PATH, '$1-<pid>'))
    .join('\n')

const outcomes = []
const expect = (name, ok, detail = '') => {
    outcomes.push(ok === true)
    console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}

let exitCode = 1
try {
    const mod = await import(pathToFileURL(dispatchModule).href)
    if (typeof mod.gmDispatch !== 'function') {
        console.log(`REFUSE: gmDispatch is not exported from ${dispatchModule}; set --module=<path> or GM_DISPATCH_MODULE`)
        process.exitCode = 1
        process.exit(1)
    }
    const dispatch = (verb, session) => mod.gmDispatch({ verb, body: {}, session_id: session, cwd: root }, undefined, undefined)

    const replies = {}
    for (const verb of READ_ONLY_VERBS) {
        const a = normalize(String(await dispatch(verb, SESSION_A)))
        let b = normalize(String(await dispatch(verb, SESSION_B)))
        if (flags.inject === 'true') b += `\ninjected_session_field: ${SESSION_B}`
        replies[verb] = { a, b }
        expect(`${verb} is session-invariant`, a === b, a === b ? `bytes=${a.length}` : `first divergence at line ${firstDivergence(a, b)}: ${JSON.stringify(a.split('\n')[firstDivergence(a, b) - 1])} vs ${JSON.stringify(b.split('\n')[firstDivergence(a, b) - 1])}`)
    }

    expect('every read-only verb replied', Object.values(replies).every(r => r.a.length > 0 && r.b.length > 0))
    exitCode = outcomes.every(Boolean) ? 0 : 1
} catch (error) {
    expect('dispatch module imports and replays to completion', false, String(error?.stack || error).split('\n').slice(0, 3).join(' | '))
}
console.log(`expects ${outcomes.filter(Boolean).length}/${outcomes.length}`)
console.log(exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = exitCode

function firstDivergence(a, b) {
    const al = a.split('\n')
    const bl = b.split('\n')
    for (let i = 0; i < Math.max(al.length, bl.length); i++) {
        if (al[i] !== bl[i]) return i + 1
    }
    return 0
}
