import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import * as yaml from 'js-yaml'
import { cleanResponse, compactWireResponse, untruncatedKeysFor, PLAIN_TEXT_OUTPUT_INLINE_MAX, FILE_READ_INLINE_MAX, LONG_TEXT_INLINE_MAX_CEILING } from './response-compact.js'
import { appendDiagnostic } from './server-log.js'

// An exit guard reads this: a process that quits mid-dispatch strands the
// spool ticket it already wrote and drops the reply nobody else will poll for.
let inflightDispatches = 0

export function inflightDispatchCount() {
    return inflightDispatches
}

function gitToplevel(dir) {
    try {
        const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
        return top ? path.resolve(top) : null
    } catch {
        return null
    }
}

function projectRootFor(dir) {
    const resolved = path.resolve(dir)
    return gitToplevel(resolved) || resolved
}

const DEFAULT_CWD_ENV_VARS = ['GM_MCP_DEFAULT_CWD', 'CLAUDE_PROJECT_DIR']

// A cwd-less dispatch used to resolve against this server's own process.cwd().
// One shared HTTP gm-mcp server serves every project (138 measured) and was
// started from the user's home directory, which is not a git repo -- so every
// cwd-less dispatch silently registered and ran in $HOME/.gm: instruction
// state, PRD rows and last-instruction-hash files all landed in the wrong
// project while the caller's own spool stayed empty, which reads exactly like
// "the daemon never answered". An explicit root, or a loud refusal.
function resolveDispatchRoot(cwd) {
    if (typeof cwd === 'string' && cwd.trim()) return { root: projectRootFor(cwd.trim()), root_source: 'cwd' }
    for (const name of DEFAULT_CWD_ENV_VARS) {
        const value = process.env[name]
        if (typeof value === 'string' && value.trim()) return { root: projectRootFor(value.trim()), root_source: `env:${name}` }
    }
    const launched = path.resolve(process.cwd())
    if (process.env.GM_MCP_ALLOW_PROCESS_CWD === '1') return { root: projectRootFor(launched), root_source: 'process_cwd' }
    const top = gitToplevel(launched)
    if (top && top === launched) return { root: launched, root_source: 'process_cwd' }
    return {
        error: 'cwd-required',
        refused_root: launched,
        root_source: 'process_cwd',
        refused_reason: top
            ? `process.cwd() is ${launched}, inside git repository ${top} but not at its root`
            : `process.cwd() is ${launched}, which is not inside a git repository`,
        note: `this dispatch named no project, and this gm-mcp server is a shared one whose own cwd is not a project root, so the old behaviour would have run it in ${launched}/.gm -- the wrong project, with its instruction state, PRD rows and spool files written there and nothing appearing in yours. Pass cwd (the project root containing .gm/exec-spool) on every dispatch, or set GM_MCP_DEFAULT_CWD to one explicit root for cwd-less calls. GM_MCP_ALLOW_PROCESS_CWD=1 restores the silent fallback.`,
        accepted_fields: ['cwd'],
    }
}

function inlineMaxForVerb({ verb, isPlainText, fullResponse, maxChars }) {
    const requested = Number(maxChars)
    if (Number.isFinite(requested) && requested > 0) return Math.min(Math.floor(requested), LONG_TEXT_INLINE_MAX_CEILING)
    if (fullResponse) return LONG_TEXT_INLINE_MAX_CEILING
    if (isPlainText) return PLAIN_TEXT_OUTPUT_INLINE_MAX
    if (verb === 'fs_read') return FILE_READ_INLINE_MAX
    return undefined
}

let counter = 0
function nextN(sessionId) {
    counter += 1
    return `${sessionId}-${process.pid}-${Date.now()}-${counter}`
}

const UNEXPANDED_INTERPOLATION = /\$\{[^}]*\}|\$\(|\$env:|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|`/i

function unsafeSpoolName(role, value) {
    if (typeof value !== 'string' || !value) return null
    if (value.includes('\0') || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
        return `${role} ${JSON.stringify(value)} is not a single spool name component: it carries a NUL byte, a path separator, or is a dot component`
    }
    const found = UNEXPANDED_INTERPOLATION.exec(value)
    if (!found) return null
    return `${role} ${JSON.stringify(value)} still carries the unexpanded interpolation ${JSON.stringify(found[0])} -- the spool ABI is in/<verb>/<session_id>-<N>.txt, so this would land as a literal path component that no daemon ever claims; pass the expanded value`
}

function publishSpoolRequest(inDir, inPath, task, body) {
    const unsafe = unsafeSpoolName('task', task)
    if (unsafe) throw new Error(unsafe)
    fs.mkdirSync(inDir, { recursive: true })
    const tempPath = path.join(inDir, `.${task}.${process.pid}.${Date.now()}.tmp`)
    try {
        fs.writeFileSync(tempPath, body, 'utf8')
        fs.renameSync(tempPath, inPath)
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
}

function normalizedObjectBody(verb, body) {
    if (body === undefined || body === null) return { value: {} }
    if (typeof body === 'string') {
        let parsed
        try {
            parsed = JSON.parse(body)
        } catch (error) {
            return { error: `${verb} body is a JSON string that cannot be parsed: ${error.message}. Pass body as an object, or pass a valid JSON object string.` }
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { error: `${verb} body string must decode to a JSON object; received ${Array.isArray(parsed) ? 'an array' : typeof parsed}.` }
        }
        return { value: parsed }
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
        return { error: `${verb} body must be a JSON object; received ${Array.isArray(body) ? 'an array' : typeof body}.` }
    }
    return { value: body }
}

const CODESEARCH_INTEGER_FIELDS = ['limit', 'head_limit', 'k', 'max_results', 'maxResults', 'max_matches', 'max_files', 'max_chars', 'timeout_ms']
const CODESEARCH_BOOLEAN_FIELDS = ['case_insensitive', 'whole_word', 'comments_only']

function withCodesearchScalarsCoerced(verb, body) {
    if (verb !== 'codesearch') return body
    const coerced = { ...body }
    for (const field of CODESEARCH_INTEGER_FIELDS) {
        if (typeof coerced[field] === 'string' && /^[0-9]+$/.test(coerced[field].trim())) coerced[field] = Number(coerced[field])
    }
    for (const field of CODESEARCH_BOOLEAN_FIELDS) {
        if (coerced[field] === 'true' || coerced[field] === 'false') coerced[field] = coerced[field] === 'true'
    }
    return coerced
}

const PLAIN_TEXT_BODY_FIELDS = ['raw_body', 'code', 'script', 'command', 'source', 'text', 'body']

function plainTextFromBody(body) {
    if (typeof body === 'string') return body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
    const present = PLAIN_TEXT_BODY_FIELDS.filter(field => typeof body[field] === 'string')
    return present.length === 1 ? body[present[0]] : undefined
}

const GLOB_FILTER_FIELDS = ['glob', 'path_glob', 'include']
const GLOB_EXCLUDE_FIELDS = ['exclude_glob', 'exclude_globs']

export function withGlobFiltersCoerced(verb, body) {
    if (!body || typeof body !== 'object') return { value: body }
    const coerced = { ...body }
    for (const field of [...GLOB_FILTER_FIELDS, ...GLOB_EXCLUDE_FIELDS]) {
        const value = coerced[field]
        if (value === null || value === undefined) continue
        const single = `${verb} body.${field}`
        if (typeof value === 'string') {
            const trimmed = value.trim()
            if (!trimmed) return { error: `${single} is an empty string -- a blank glob is dropped before the scan runs, so it silently searched everything; omit the field to search unscoped` }
            coerced[field] = trimmed
            continue
        }
        if (!Array.isArray(value)) {
            return { error: `${single} must be a string or an array of strings; received ${typeof value}. This filter takes one glob, e.g. {"${field}":"**/*.rs"} or {"${field}":["**/*.rs","!**/dist/**"]}` }
        }
        if (value.length === 0) return { error: `${single} is an empty array -- a blank glob is dropped before the scan runs; omit the field to search unscoped` }
        const patterns = []
        for (const element of value) {
            if (typeof element !== 'string' || !element.trim()) {
                return { error: `${single} is an array whose entries must all be non-empty glob strings; received ${JSON.stringify(element)}` }
            }
            patterns.push(element.trim())
        }
        coerced[field] = patterns
    }
    return { value: coerced }
}

function objectBodyDiagnostic(verb, body) {
    if (verb === 'prd-add' && (typeof body.id !== 'string' || !body.id.trim())) {
        return 'prd-add requires a non-empty body.id. A blank id would create an unaddressable PRD row; provide a stable identifier before dispatching.'
    }
    if (verb !== 'git_merge' || typeof body.ref === 'string' && body.ref.trim()) return undefined
    if (typeof body.branch === 'string' && body.branch.trim()) {
        return 'git_merge requires body.ref. body.branch is not a git_merge field; call again with {"ref":"' + body.branch + '"}.'
    }
    return 'git_merge requires a non-empty body.ref, for example {"ref":"origin/main"}.'
}

const RUNNER_DIR = path.join(os.homedir(), '.gm-tools')
const RUNNER_PATH = path.join(RUNNER_DIR, process.platform === 'win32' ? 'agentplug-runner.exe' : 'agentplug-runner')
const AGENTPLUG_DIR = path.join(os.homedir(), '.agentplug')
const GLOBAL_DAEMON_STATUS_PATH = path.join(AGENTPLUG_DIR, 'daemon-status.json')
const GLOBAL_DAEMON_OWNER_LOCK_PATH = path.join(AGENTPLUG_DIR, 'daemon-owner.lock')
const GLOBAL_DAEMON_LOG_PATH = path.join(AGENTPLUG_DIR, 'daemon.log')

// Recovery windows for a daemon that exits on purpose and is restarted from
// here -- see AGENTS.md ("Runner recovery").
const ENSURE_INTERVAL_MS = 2_000
const ENSURE_LEASE_MS = 3_000
const ENSURE_BOOT_GRACE_MS = 30_000
const WATCHDOG_INTERVAL_MS = 5_000
const lastEnsuredAtByRoot = new Map()
const watchdogTimersByRoot = new Map()

function runnerBinaryMissing() {
    return !fs.existsSync(RUNNER_PATH)
}

function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
        return null
    }
}

export function pidAlive(pid) {
    const value = Number(pid)
    if (!Number.isInteger(value) || value <= 0) return null
    try {
        process.kill(value, 0)
        return true
    } catch (error) {
        return error?.code === 'EPERM' ? true : false
    }
}

function globalDaemonPid() {
    const status = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    if (pidAlive(status?.pid) === true) return status.pid
    try {
        const owner = Number.parseInt(fs.readFileSync(GLOBAL_DAEMON_OWNER_LOCK_PATH, 'utf8').trim(), 10)
        if (pidAlive(owner) === true) return owner
    } catch {
    }
    return null
}

export function daemonBootGraceActive() {
    const status = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    const bootTs = status?.daemon_boot_ts
    if (typeof bootTs !== 'number') return false
    if (Date.now() - bootTs >= ENSURE_BOOT_GRACE_MS) return false
    return globalDaemonPid() !== null || Date.now() - (status.ts || 0) < 10_000
}

export function liveDaemonSweepsProject(spoolDir) {
    const status = readJsonFile(path.join(spoolDir, '.status.json'))
    if (!status) return false
    if (!(Date.now() - (status.ts || 0) < DAEMON_HEARTBEAT_STALE_MS)) return false
    const alive = pidAlive(status.pid)
    return alive !== false
}

const GLOBAL_LAUNCHER_LOCK_PATH = path.join(AGENTPLUG_DIR, 'spool-launch.lock')

function readLauncherLock() {
    try {
        const [pid, ts, role] = fs.readFileSync(GLOBAL_LAUNCHER_LOCK_PATH, 'utf8').trim().split(/\s+/)
        return { pid: Number(pid), ts: Number(ts), role: role || null }
    } catch {
        return null
    }
}

// The lock names whichever process holds it, so a reader can tell a spawned
// runner from the server that claimed it. It is only ever stolen, never
// signalled: the pid it names is read back from disk long after the fact, and
// pid reuse or a contended write can leave another session's live gm-mcp
// server in it -- killing that pid is how this server used to take a whole
// session's MCP connection down with it. A wedged runner is already bounded by
// ENSURE_CHILD_MAX_AGE_MS and the per-root in-flight guard, and a fresh
// `agentplug-runner spool` against a live daemon only registers and exits.
function claimGlobalLauncher() {
    fs.mkdirSync(AGENTPLUG_DIR, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(GLOBAL_LAUNCHER_LOCK_PATH, `${process.pid} ${Date.now()} server`, { flag: 'wx', mode: 0o600 })
            return true
        } catch (error) {
            if (error?.code !== 'EEXIST') return false
        }
        const held = readLauncherLock()
        const heldAgeMs = held?.ts ? Date.now() - held.ts : Number.POSITIVE_INFINITY
        if (held && heldAgeMs < ENSURE_CHILD_MAX_AGE_MS && pidAlive(held.pid) !== false) return false
        appendDiagnostic('launcher-lock-stolen', {
            lock: GLOBAL_LAUNCHER_LOCK_PATH,
            held_pid: held?.pid ?? null,
            held_role: held?.role ?? null,
            held_age_ms: Number.isFinite(heldAgeMs) ? Math.round(heldAgeMs) : null,
            held_pid_alive: pidAlive(held?.pid),
        })
        try {
            fs.unlinkSync(GLOBAL_LAUNCHER_LOCK_PATH)
        } catch {
            return false
        }
    }
    return false
}

function claimRunnerEnsure(root) {
    const lockPath = path.join(root, '.gm', 'exec-spool', '.runner-ensure.lock')
    const claim = () => {
        const fd = fs.openSync(lockPath, 'wx', 0o600)
        try {
            fs.writeFileSync(fd, `${process.pid} ${Date.now()}`, 'utf8')
        } finally {
            fs.closeSync(fd)
        }
        return true
    }
    try {
        return claim()
    } catch (error) {
        if (error?.code !== 'EEXIST') return false
    }
    try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
        if (ageMs <= ENSURE_LEASE_MS) return false
        const holderPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0], 10)
        if (ageMs < ENSURE_CHILD_MAX_AGE_MS && pidAlive(holderPid) === true) return false
        const stalePath = `${lockPath}.${process.pid}.${Date.now()}.stale`
        fs.renameSync(lockPath, stalePath)
        fs.unlinkSync(stalePath)
    } catch {
        return false
    }
    try {
        return claim()
    } catch {
        return false
    }
}

// A cold `agentplug-runner spool` takes tens of seconds (it registers the
// project, then waits out the shared daemon's wasm compile). The watchdog wakes
// every WATCHDOG_INTERVAL_MS, so without this guard one cold start spawns a new
// runner every ENSURE_INTERVAL_MS -- a pile of processes that all contend for
// daemon.lock and none of which finish faster. ENSURE_CHILD_MAX_AGE_MS caps it:
// a `spool` that outlives the cap is treated as wedged and re-issued, so a hung
// child can never block supervision forever.
const ENSURE_CHILD_MAX_AGE_MS = 120_000
const inflightEnsuresByRoot = new Map()
const consecutiveFailedEnsuresByRoot = new Map()
const ENSURE_BACKOFF_CEILING_MS = 60_000

export function runnerEnsureInFlight(root, now = Date.now()) {
    const entry = inflightEnsuresByRoot.get(root)
    if (!entry) return false
    if (entry.exitCode !== null && entry.exitCode !== undefined) {
        inflightEnsuresByRoot.delete(root)
        return false
    }
    if (pidAlive(entry.pid) === false) {
        inflightEnsuresByRoot.delete(root)
        return false
    }
    if (now - entry.spawnedAtMs >= ENSURE_CHILD_MAX_AGE_MS) {
        inflightEnsuresByRoot.delete(root)
        return false
    }
    return true
}

function ensureSpoolRunnerRunning(root) {
    if (runnerBinaryMissing()) return
    if (liveDaemonSweepsProject(path.join(root, '.gm', 'exec-spool'))) {
        consecutiveFailedEnsuresByRoot.delete(root)
        return
    }
    const now = Date.now()
    if (runnerEnsureInFlight(root, now)) return
    if (now - (lastEnsuredAtByRoot.get(root) || 0) < ENSURE_INTERVAL_MS) return
    if (daemonBootGraceActive()) {
        lastEnsuredAtByRoot.set(root, now)
        return
    }
    const failures = consecutiveFailedEnsuresByRoot.get(root) || 0
    lastEnsuredAtByRoot.set(root, now + Math.min(ENSURE_BACKOFF_CEILING_MS, ENSURE_INTERVAL_MS * (2 ** failures)) - ENSURE_INTERVAL_MS)
    if (!claimRunnerEnsure(root)) return
    if (!claimGlobalLauncher()) return
    consecutiveFailedEnsuresByRoot.set(root, failures + 1)
    let child
    try {
        child = spawn(RUNNER_PATH, ['spool'], {
            cwd: root,
            env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        })
    } catch (error) {
        appendDiagnostic('runner-spawn-failed', { root, runner: RUNNER_PATH, error: String(error?.message || error) })
        try {
            fs.unlinkSync(GLOBAL_LAUNCHER_LOCK_PATH)
        } catch {
        }
        return
    }
    try {
        fs.writeFileSync(GLOBAL_LAUNCHER_LOCK_PATH, `${child.pid} ${now} runner`, 'utf8')
    } catch {
    }
    const entry = { pid: child.pid, spawnedAtMs: now, exitCode: null }
    const settle = (code) => {
        entry.exitCode = code ?? 0
        if (inflightEnsuresByRoot.get(root) === entry) inflightEnsuresByRoot.delete(root)
    }
    child.on('error', () => settle(-1))
    child.on('exit', (code) => settle(code))
    recordRunnerEnsureInflight(root, entry)
    try {
        fs.writeFileSync(path.join(root, '.gm', 'exec-spool', '.runner-ensure.lock'), `${child.pid} ${now}`, 'utf8')
    } catch {
    }
    child.unref()
}

// Seam for the recovery tests: seeds the in-flight map so runnerEnsureInFlight
// can be asserted without spawning a real runner.
export function recordRunnerEnsureInflight(root, entry) {
    inflightEnsuresByRoot.set(root, entry)
}

// A timer per root keeps the daemon up between dispatches, so the next dispatch
// lands on a live sweeper instead of reviving one inside its own poll budget.
function startRunnerWatchdog(root) {
    if (process.env.GM_MCP_RUNNER_WATCHDOG === '0') return
    if (watchdogTimersByRoot.has(root)) return
    const timer = setInterval(() => {
        try {
            ensureSpoolRunnerRunning(root)
        } catch {
        }
    }, WATCHDOG_INTERVAL_MS)
    timer.unref?.()
    watchdogTimersByRoot.set(root, timer)
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(t)
            signal?.removeEventListener('abort', onAbort)
            reject(new Error('aborted'))
        }
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function waitForSpoolChange(outDir, outPath, waitMs, fallbackMs, signal) {
    return new Promise((resolve, reject) => {
        let watcher
        let wakeTimer
        let fallbackTimer
        let settled = false
        const finish = (wakeSource, error) => {
            if (settled) return
            settled = true
            clearTimeout(wakeTimer)
            clearTimeout(fallbackTimer)
            watcher?.close()
            signal?.removeEventListener('abort', onAbort)
            if (error) reject(error)
            else resolve(wakeSource)
        }
        const onAbort = () => finish(undefined, new Error('aborted'))
        const wake = (_event, filename) => {
            if (!filename || filename.toString() === path.basename(outPath)) finish('filesystem_event')
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
            watcher = fs.watch(outDir, { persistent: false }, wake)
            watcher.on('error', () => {
                watcher?.close()
                watcher = undefined
            })
        } catch {
            watcher = undefined
        }
        if (fs.existsSync(outPath)) return finish('already_landed')
        wakeTimer = setTimeout(() => finish('deadline'), Math.max(1, waitMs))
        fallbackTimer = setTimeout(() => finish('fallback_poll'), Math.min(Math.max(25, fallbackMs), Math.max(1, waitMs)))
    })
}

const BROWSER_PLAIN_TEXT_VERBS = ['serp', 'browser', 'cdp']

const EXEC_FAMILY_VERBS = ['exec_js', 'nodejs', 'javascript', 'node', 'js', 'bash', 'sh', 'shell', 'zsh', 'python', 'py', 'powershell', 'ps1', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno']

const PLAIN_TEXT_BODY_VERBS = new Set([...EXEC_FAMILY_VERBS, ...BROWSER_PLAIN_TEXT_VERBS])

const DEADLINE_AWARE_JSON_VERBS = ['codesearch', 'codeinsight', 'instruction', 'recall']

const TIMEOUT_MS_PREFIX_VERBS = new Set([...EXEC_FAMILY_VERBS, ...DEADLINE_AWARE_JSON_VERBS])

const TIMEOUT_MS_PREFIX_LINE = /^\s*timeout(?:Ms|_ms)=/

const TIMEOUT_MS_PREFIX_VALUE = /^\s*timeout(?:Ms|_ms)=(\d+)/

const DEFAULT_TIMEOUT_SECONDS = 120

const EXEC_DEFAULT_LIMIT_SECONDS = 300

const POLL_MARGIN_PAST_EXEC_TIMEOUT_MS = 5000

const CLIENT_DEADLINE_MARGIN_MS = 1500

function unpackExecOutputEnvelope(verb, parsed) {
    if (!EXEC_FAMILY_VERBS.includes(verb) || !parsed || typeof parsed.data !== 'string') return parsed
    try {
        const inner = JSON.parse(parsed.data)
        return inner && typeof inner === 'object' && !Array.isArray(inner) ? { ...parsed, data: inner } : parsed
    } catch {
        return parsed
    }
}

export function pollTimeoutMs(verb, raw_body, timeout_seconds) {
    const explicitSeconds = Number(timeout_seconds)
    if (explicitSeconds > 0) return Math.max(1000, explicitSeconds * 1000 - CLIENT_DEADLINE_MARGIN_MS)
    const bodyPrefix = TIMEOUT_MS_PREFIX_VERBS.has(verb) && typeof raw_body === 'string' ? TIMEOUT_MS_PREFIX_VALUE.exec(raw_body) : null
    if (bodyPrefix) return Math.max(DEFAULT_TIMEOUT_SECONDS * 1000, Number(bodyPrefix[1]) + POLL_MARGIN_PAST_EXEC_TIMEOUT_MS)
    return DEFAULT_TIMEOUT_SECONDS * 1000
}

// The MCP client kills the tool call on its own schedule -- 60 s measured
// repeatedly (59998/60033 ms) -- long before gm's own 120 s poll budget runs
// out. Polling past it is pure loss: the reply is thrown away and the caller
// sees a bare transport timeout with no task id, no dispatch_state and no
// resume handle. Poll to the client's deadline instead and return a structured
// timed_out with everything needed to resume.
const CLIENT_DEADLINE_DEFAULT_SECONDS = 60

function clientDeadlineSeconds() {
    const raw = Number(process.env.GM_MCP_CLIENT_DEADLINE_SECONDS)
    if (!Number.isFinite(raw) || raw < 0) return CLIENT_DEADLINE_DEFAULT_SECONDS
    return raw
}

export function applyClientDeadline(requestedMs) {
    const seconds = clientDeadlineSeconds()
    if (seconds <= 0) return { ms: requestedMs, clamped: false, client_deadline_seconds: 0, requested_ms: requestedMs }
    const ceilingMs = seconds * 1000 - CLIENT_DEADLINE_MARGIN_MS
    if (ceilingMs <= 0 || requestedMs <= ceilingMs) {
        return { ms: requestedMs, clamped: false, client_deadline_seconds: seconds, requested_ms: requestedMs }
    }
    return { ms: ceilingMs, clamped: true, client_deadline_seconds: seconds, requested_ms: requestedMs }
}

function pollBudgetDisclosure(budget, waitedMs) {
    const base = {
        requested_ms: budget.requested_ms,
        effective_ms: budget.ms,
        clamped_to_client_deadline: budget.clamped,
        client_deadline_seconds: budget.client_deadline_seconds,
        waited_ms: waitedMs,
    }
    return budget.clamped
        ? {
            ...base,
            reason: `the MCP client cuts this tool call off at ${budget.client_deadline_seconds}s, so gm stopped polling ${CLIENT_DEADLINE_MARGIN_MS}ms early rather than let the reply be discarded -- the dispatch is NOT cancelled and its result still lands in out_path. Re-poll the SAME dispatch with resume_task set to this response's task (same verb and cwd), and raise GM_MCP_CLIENT_DEADLINE_SECONDS if your client really waits longer.`,
        }
        : {
            ...base,
            reason: budget.requested_ms > budget.client_deadline_seconds * 1000 && budget.client_deadline_seconds > 0
                ? `this dispatch did not finish within the requested ${budget.requested_ms}ms poll budget; note the MCP client's own deadline is ${budget.client_deadline_seconds}s, so a slower dispatch needs resume_task rather than a longer timeout_seconds`
                : `this dispatch did not finish within the requested ${budget.requested_ms}ms poll budget`,
        }
}

function timeoutMsFor(timeout_seconds) {
    const seconds = Number(timeout_seconds)
    return Math.max(100, Math.round((seconds > 0 ? seconds : EXEC_DEFAULT_LIMIT_SECONDS) * 1000))
}

export function withTimeoutMsPrefix(verb, raw_body, timeout_seconds) {
    if (!TIMEOUT_MS_PREFIX_VERBS.has(verb)) return raw_body
    if (TIMEOUT_MS_PREFIX_LINE.test(raw_body)) return raw_body
    const prefixMs = EXEC_FAMILY_VERBS.includes(verb)
        ? timeoutMsFor(timeout_seconds)
        : applyClientDeadline(pollTimeoutMs(verb, raw_body, timeout_seconds)).ms
    return `timeoutMs=${prefixMs}\n${raw_body}`
}

const DAEMON_HEARTBEAT_STALE_MS = 20000

function projectRootOfSpool(spoolDir) {
    return path.resolve(spoolDir, '..', '..')
}

function heartbeatAgeMs(spoolDir) {
    const status = readJsonFile(path.join(spoolDir, '.status.json'))
    return status && typeof status.ts === 'number' ? Date.now() - status.ts : null
}

function daemonRestartCommand(root) {
    return `"${RUNNER_PATH}" spool   (run with cwd ${path.resolve(root)}; the launcher detaches agentplug-runner daemon for this project)`
}

function coldProjectLiveness() {
    const shared = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    const sharedPid = globalDaemonPid()
    if (sharedPid === null) {
        return { alive: null, note: 'no .status.json heartbeat found for this project yet and no shared daemon process is running -- nothing has swept this project; start one with the restart command for this project' }
    }
    return {
        alive: null,
        shared_daemon_pid: sharedPid,
        shared_daemon_active_projects: shared?.active_projects ?? null,
        note: `no .status.json heartbeat for this project yet, but the shared daemon (pid ${sharedPid}, serving ${shared?.active_projects ?? 'many'} registered projects) is running -- this is a cold project waiting its turn behind that daemon's other work (measured 85-110 s for a brand-new project, git repo or not; the project is keyed on its own directory, so a non-git cwd needs no git_root_override). The dispatch is still queued and will be claimed: re-dispatch with resume_task set to this response's task instead of writing a second request`,
    }
}

export function readDaemonLiveness(spoolDir) {
    let status
    try {
        status = JSON.parse(fs.readFileSync(path.join(spoolDir, '.status.json'), 'utf8'))
    } catch {
        return coldProjectLiveness()
    }
    const now = Date.now()
    const heartbeatAgeMs = typeof status.ts === 'number' ? now - status.ts : null
    const pid = typeof status.pid === 'number' ? status.pid : Number(status.pid) || null
    const pidAliveFlag = pidAlive(pid)
    const alive = pidAliveFlag === false
        ? false
        : heartbeatAgeMs !== null && heartbeatAgeMs < DAEMON_HEARTBEAT_STALE_MS
    const busyForMs = typeof status.busy_until === 'number' ? status.busy_until - now : null
    const busy = busyForMs !== null && busyForMs > 0
    const note = !alive
        ? runnerBinaryMissing()
            ? `no live daemon heartbeat for this project and the agentplug-runner binary is not installed at ${RUNNER_PATH} -- nothing can claim this dispatch until the runner is installed`
            : pidAliveFlag === false
                ? `the daemon process that last swept this project (pid ${pid}) is gone -- the daemon recycles itself on idle/memory pressure and on a runner version handoff, and is restarted on demand; this call already asked for a replacement, so a dispatch submitted now waits for its cold start (wasm compile, tens of seconds) instead of for a queue`
                : `daemon heartbeat is ${heartbeatAgeMs} ms stale (alive means under ${DAEMON_HEARTBEAT_STALE_MS} ms) -- it is down, hung, or has not registered this project; its own log is ${GLOBAL_DAEMON_LOG_PATH} (this project's spool log is ${path.join(spoolDir, '.watcher.log')}) and it restarts with ${daemonRestartCommand(projectRootOfSpool(spoolDir))}; this is not necessarily this dispatch's fault`
        : busy
            ? 'daemon is alive and still actively working on this project'
            : 'daemon is alive; busy_until is project-scoped and currently unset, which says nothing about this particular dispatch -- read dispatch_state for that'
    const liveness = { alive, heartbeat_age_ms: heartbeatAgeMs, busy, busy_for_ms: busy ? busyForMs : null, note }
    if (pid !== null) liveness.pid = pid
    if (pidAliveFlag !== null) liveness.pid_alive = pidAliveFlag
    if (status.runtime) liveness.runtime = status.runtime
    if (typeof status.shared_process === 'boolean') liveness.shared_process = status.shared_process
    if (typeof status.queue_wait_ms === 'number') liveness.queue_wait_ms = status.queue_wait_ms
    if (typeof status.queue_depth === 'number') liveness.queue_depth = status.queue_depth
    if (typeof status.queue_position === 'number') liveness.queue_position = status.queue_position
    if (typeof status.claimed_step_count === 'number') liveness.claimed_step_count = status.claimed_step_count
    if (typeof status.queued_step_count === 'number') liveness.queued_step_count = status.queued_step_count
    if (typeof status.gm_processor_capacity === 'number') liveness.gm_processor_capacity = status.gm_processor_capacity
    const sharedProjects = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)?.active_projects
    if (typeof sharedProjects === 'number') liveness.daemon_active_projects = sharedProjects
    if (status.runner_update_in_progress) {
        liveness.runner_update_in_progress = true
        liveness.runner_update_waiting_ms = status.runner_update_waiting_ms ?? null
    }
    return liveness
}

// A missing runner binary with no live shared daemon means the daemon can never
// claim a fresh ticket: without this guard the request is written, sits
// unclaimed, and the caller only learns the binary is absent after a full poll
// timeout. Failing fast here keeps a working shared daemon usable (its liveness
// short-circuits) and turns the silent no-op into one actionable error.
function runnerUnavailable(root, spoolDir) {
    if (!runnerBinaryMissing()) return null
    if (readDaemonLiveness(spoolDir).alive) return null
    return {
        error: 'runner-not-installed',
        runner_binary_missing: true,
        runner_path: RUNNER_PATH,
        note: `the agentplug-runner binary is not installed at ${RUNNER_PATH} and no live daemon heartbeat was found for ${path.resolve(root)}, so this dispatch could never be claimed. Install it once, then dispatch again: npx github:AnEntrypoint/gm -g   (or, in this project: curl -fsSL https://raw.githubusercontent.com/AnEntrypoint/gm/main/install.sh | sh -s -- spool)`,
    }
}

// A dispatch written to a project whose daemon is gone sits
// queued_not_yet_claimed and costs the caller its whole poll budget -- the
// spool has no way to answer "nobody is listening". This asks for a runner,
// waits out the cold start, and only then reports, so a dead daemon answers in
// DAEMON_START_GRACE_MS instead of after a silent 120 s. A project with no
// heartbeat at all is a first run, not a dead daemon: it still dispatches,
// because the runner registers the project on its next tick and
// startRunnerWatchdog keeps it up from then on.
const DAEMON_START_GRACE_MS = Number(process.env.GM_MCP_DAEMON_START_GRACE_MS) > 0
    ? Number(process.env.GM_MCP_DAEMON_START_GRACE_MS)
    : 15_000
const DAEMON_START_POLL_MS = 250

export async function awaitDaemonHeartbeat(spoolDir, signal) {
    const deadline = Date.now() + DAEMON_START_GRACE_MS
    while (true) {
        const age = heartbeatAgeMs(spoolDir)
        if (age !== null && age < DAEMON_HEARTBEAT_STALE_MS) return 'recovered'
        if (Date.now() >= deadline) return 'still_dead'
        try {
            await sleep(DAEMON_START_POLL_MS, signal)
        } catch {
            return 'aborted'
        }
    }
}

export async function daemonNotRunning(root, spoolDir, signal) {
    if (process.env.GM_MCP_DAEMON_PREFLIGHT === '0') return undefined
    if (readDaemonLiveness(spoolDir).alive) return undefined
    const age = heartbeatAgeMs(spoolDir)
    if (age === null) return undefined
    if (daemonBootGraceActive()) return undefined
    if (readJsonFile(path.join(spoolDir, '.status.json'))?.runner_update_in_progress) return undefined
    ensureSpoolRunnerRunning(root)
    startRunnerWatchdog(root)
    if (await awaitDaemonHeartbeat(spoolDir, signal) !== 'still_dead') return undefined
    const staleFor = heartbeatAgeMs(spoolDir)
    return {
        error: 'daemon-not-running',
        daemon_not_running: true,
        heartbeat_age_ms: staleFor,
        stale_after_ms: DAEMON_HEARTBEAT_STALE_MS,
        waited_for_start_ms: DAEMON_START_GRACE_MS,
        note: `this project's daemon heartbeat is ${staleFor} ms old (alive means under ${DAEMON_HEARTBEAT_STALE_MS} ms) and did not come back within ${DAEMON_START_GRACE_MS} ms of asking for a runner, so no dispatch was written -- it would sit queued_not_yet_claimed and only fail at the poll timeout. Restart it and dispatch again: ${daemonRestartCommand(root)}`,
        checked_status_file: path.join(spoolDir, '.status.json'),
        daemon_log: GLOBAL_DAEMON_LOG_PATH,
        spool_log: path.join(spoolDir, '.watcher.log'),
    }
}

export function readSpoolDispatchState(spoolDir, verb, task) {
    const queuedPath = path.join(spoolDir, 'in', verb, `${task}.txt`)
    const claimedPath = `${queuedPath}.inflight`
    const claimed = fs.existsSync(claimedPath)
    const queued = !claimed && fs.existsSync(queuedPath)
    const state = claimed ? 'claimed_still_in_flight' : queued ? 'queued_not_yet_claimed' : 'no_input_file_left'
    const pressure = scanSpoolQueue(spoolDir, queuedPath)
    const stall = claimSweepStall(pressure, queued)
    const note = claimed
        ? `the daemon HAS claimed this dispatch (${claimedPath} exists) and has not written its out-file yet -- it is still running, not lost. Do NOT re-dispatch: call again with the same verb and cwd, resume_task set to this response's task and no body, to keep waiting on the SAME request`
        : queued && pressure
            ? queuePressureNote(pressure, queuedPath, stall)
            : queued
                ? `this request is still sitting UNCLAIMED in the spool queue (${queuedPath} exists) -- the daemon has not picked it up yet; it claims every settled ticket on each tick, so do NOT re-dispatch: call again with the same verb and cwd, resume_task set to this response's task and no body; writing a second dispatch only deepens the queue`
                : 'neither an input file nor an out-file exists for this task id, so the spool holds no evidence either way: either the id was never written (a resume_task typo), or it was claimed and then lost to a daemon exit / self-update handoff. A lost claim normally leaves a dispatch_orphaned out-file behind; since none appeared, re-dispatch fresh rather than resuming this id'
    return { state, claimed, queued, ...(stall ?? {}), ...(pressure ?? {}), note }
}

export function readDispatchWaitProgress(spoolDir, verb, task) {
    const ledgerPath = path.join(spoolDir, '.dispatch-wait.json')
    const ledger = readJsonFile(ledgerPath)
    if (!ledger || !Array.isArray(ledger.requests)) {
        return {
            ledger_path: ledgerPath,
            published: false,
            note: 'the daemon has not published a dispatch-wait ledger for this project, so there is no finer-grained progress than claimed/unclaimed to report',
        }
    }
    const mine = ledger.requests.find((r) => r.verb === verb && r.task === task) ?? null
    return {
        ledger_path: ledgerPath,
        published: true,
        ledger_age_ms: typeof ledger.ts === 'number' ? Date.now() - ledger.ts : null,
        daemon_pid: ledger.daemon_pid ?? null,
        project_in_flight: ledger.project_in_flight ?? null,
        project_in_flight_cap: ledger.project_in_flight_cap ?? null,
        waiting_requests: ledger.requests.length,
        mine,
        note: mine
            ? `the daemon (pid ${ledger.daemon_pid ?? 'unknown'}) reports this dispatch as "${mine.state}" for ${mine.stage_age_ms} ms, ${mine.file_age_ms} ms after it was written${mine.lane ? `, serial lane "${mine.lane}"` : ''}${mine.admission_kind ? `, admission gate "${mine.admission_kind}" (${mine.admission_in_flight}/${mine.admission_limit} busy)` : ''} -- it IS progressing, so resume rather than re-dispatch`
            : `the daemon has published a wait ledger with ${ledger.requests.length} waiting request(s) but no row for this task, so this dispatch has no recorded stage yet`,
    }
}

// A live daemon with free claim slots claims a settled ticket on its next pass
// over the project's spool. Past this age an unclaimed ticket is not ordinary
// queueing: the pass that claims is not reaching this project (it walks the whole
// registry in order, and anything that stalls it -- a synchronous network update
// poll, a saturated shared plugin pool -- stalls every project behind it). Name
// that instead of telling the caller to keep waiting on a sweep that is not
// running.
const CLAIM_SWEEP_STALL_MS = 30_000

function claimSweepStall(pressure, queued) {
    const oldestMs = queued && pressure ? pressure.oldest_unclaimed_age_ms : null
    if (!queued || !pressure || pressure.cap_saturated || oldestMs === null) {
        return { claim_sweep_stalled: false, claim_sweep_stalled_for_ms: oldestMs === null ? null : oldestMs }
    }
    const stalled = oldestMs >= CLAIM_SWEEP_STALL_MS
    return { claim_sweep_stalled: stalled, claim_sweep_stalled_for_ms: oldestMs }
}

// The daemon refuses to claim another dispatch for a project once that project
// already holds MAX_CLAIMED_DISPATCHES_PER_PROJECT claimed ones (agentplug-runner
// daemon.rs, claim_budget). A dispatch that sits unclaimed is therefore either
// blocked by that cap or merely waiting for the daemon's next sweep of this
// project -- and the two need opposite responses from the caller (wait vs
// escalate). The spool holds both numbers, so measure them instead of listing
// hypotheses.
const MAX_CLAIMED_DISPATCHES_PER_PROJECT = 32

export function scanSpoolQueue(spoolDir, myQueuedPath) {
    const inDir = path.join(spoolDir, 'in')
    let verbs
    try {
        verbs = fs.readdirSync(inDir, { withFileTypes: true })
    } catch {
        return null
    }
    const now = Date.now()
    let myMtimeMs = null
    try {
        myMtimeMs = fs.statSync(myQueuedPath).mtimeMs
    } catch {
    }
    let claimedCount = 0
    let unclaimedCount = 0
    let aheadOfMine = 0
    let oldestUnclaimedMs = null
    for (const verbEntry of verbs) {
        if (!verbEntry.isDirectory()) continue
        const verbDir = path.join(inDir, verbEntry.name)
        let files
        try {
            files = fs.readdirSync(verbDir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const fileEntry of files) {
            if (!fileEntry.isFile() || fileEntry.name.startsWith('.')) continue
            // A claim renames <task>.<ext> to <task>.<ext>.inflight in place, so
            // .inflight is the only marker of a dispatch the daemon owns.
            if (fileEntry.name.endsWith('.inflight')) {
                claimedCount += 1
                continue
            }
            if (!path.extname(fileEntry.name)) continue
            unclaimedCount += 1
            let mtimeMs = null
            try {
                mtimeMs = fs.statSync(path.join(verbDir, fileEntry.name)).mtimeMs
            } catch {
            }
            if (mtimeMs === null) continue
            if (oldestUnclaimedMs === null || mtimeMs < oldestUnclaimedMs) oldestUnclaimedMs = mtimeMs
            if (myMtimeMs !== null && mtimeMs < myMtimeMs) aheadOfMine += 1
        }
    }
    return {
        project_claimed_count: claimedCount,
        project_unclaimed_count: unclaimedCount,
        oldest_unclaimed_age_ms: oldestUnclaimedMs === null ? null : now - oldestUnclaimedMs,
        unclaimed_ahead_of_mine: myMtimeMs === null ? null : aheadOfMine,
        claimed_dispatch_cap: MAX_CLAIMED_DISPATCHES_PER_PROJECT,
        claim_budget_left: Math.max(0, MAX_CLAIMED_DISPATCHES_PER_PROJECT - claimedCount),
        cap_saturated: claimedCount >= MAX_CLAIMED_DISPATCHES_PER_PROJECT,
    }
}

function queuePressureNote(pressure, queuedPath, stall) {
    const head = `${queuedPath} is still UNCLAIMED -- measured from the spool: ${pressure.project_claimed_count}/${pressure.claimed_dispatch_cap} dispatches claimed in flight for this project, ${pressure.project_unclaimed_count} unclaimed, ${pressure.unclaimed_ahead_of_mine} of them older than this one, oldest unclaimed waiting ${pressure.oldest_unclaimed_age_ms} ms`
    const stalled = Boolean(stall && stall.claim_sweep_stalled)
    const stallTail = stalled
        ? `. CLAIM SWEEP STALLED: ${pressure.claim_budget_left} claim slot(s) are free and the oldest queued dispatch has been waiting ${pressure.oldest_unclaimed_age_ms} ms (past the ${CLAIM_SWEEP_STALL_MS} ms sweep bound), so the pass that claims requests is not reaching this project -- it walks every registered root in order, so a stalled pass delays everything behind it. This dispatch is still queued and will be claimed when the pass resumes: keep waiting on it with resume_task, and check the daemon log for a synchronous update poll or a saturated shared plugin pool holding the pass up.`
        : ''
    return pressure.cap_saturated
        ? `${head}. THIS PROJECT IS AT ITS CLAIM CAP: the daemon claims nothing new here until one of the ${pressure.project_claimed_count} in-flight dispatches finishes. Wait it out on this same dispatch with resume_task -- re-dispatching adds to the ${pressure.project_unclaimed_count} already queued and cannot be claimed any sooner.`
        : `${head}. Not cap saturation (${pressure.claim_budget_left} claim slot(s) free): the daemon is between sweeps of this project or busy elsewhere -- see daemon.daemon_active_projects and daemon.gm_processor_capacity for how many projects share it. Keep waiting on this dispatch with resume_task; nothing here is wedged.${stallTail}`
}

const FINAL_OUT_RECHECK_WINDOW_MS = 2500
const FINAL_OUT_RECHECK_INTERVAL_MS = 150

const STALE_CHROME_SCAN_TIMEOUT_MS = 3000

// A completed dispatch that still reads as a timeout is nearly always a starved
// daemon, and the starvation is nearly always gm's own headless Chrome piling
// up: every orphan makes the reaper's process scan slower, a slow scan trips the
// reaper's circuit breaker, and a blind reaper reaps nothing -- so the count
// climbs on its own. Naming the count turns a bare "timed out" into the one
// action that clears it.
function staleChromeCount() {
    if (process.platform !== 'win32') return null
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], {
            timeout: STALE_CHROME_SCAN_TIMEOUT_MS,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        })
        const n = String(out).split('\n').filter(l => l.toLowerCase().includes('chrome.exe')).length
        return Number.isFinite(n) ? n : null
    } catch {
        return null
    }
}

function staleChromeTimeoutNote(verb) {
    const isBrowserVerb = verb === 'browser' || verb === 'cdp'
    const count = staleChromeCount()
    // The count is a bonus, never a gate: if the scan cannot answer, the browser
    // verbs still get the actionable note, because that is exactly the starved
    // machine where it matters and where a scan is least likely to answer.
    if (count === null && !isBrowserVerb) return {}
    const observed = count === null
        ? 'A process scan could not count them just now'
        : `${count} chrome.exe process(es) are running`
    const reap = 'Dispatch `browser` with body `session close-all`, then `session list` to confirm none remain.'
    return {
        ...(count === null ? {} : { stale_chrome_processes: count }),
        timeout_note: isBrowserVerb
            ? `${observed}. gm-spawned headless Chrome that is never closed accumulates, and the orphan reaper cannot see any of it while its own process scan is failing -- so the pile grows on its own and every later dispatch, browser or not, waits behind it. ${reap} Then re-poll THIS dispatch with resume_task rather than dispatching it again.`
            : `${observed}. Accumulated gm headless Chrome starves the daemon and delays unrelated verbs like \`${verb}\`, so this dispatch is more likely still queued than lost. Re-poll it with resume_task (same verb and cwd, no body); if it keeps timing out, ${reap}`,
    }
}

function resumeDisclosure(task, landedAtMs, callStartedAtMs) {
    const resultPredatesResume = typeof landedAtMs === 'number' && landedAtMs < callStartedAtMs
    return {
        task,
        sent_no_body: true,
        wrote_no_new_dispatch: true,
        result_predates_this_resume: resultPredatesResume,
        note: resultPredatesResume
            ? 'this is the original dispatch\'s stored result, read back unchanged -- any error below (including a missing-body/validation error) came from that dispatch, NOT from this resume call, which sent no body'
            : 'the original dispatch finished while this resume was polling -- the result below is its own',
    }
}

function carriedNoFailure(out) {
    return Boolean(out) && typeof out === 'object' && !Array.isArray(out)
        && out.error === undefined && out.timed_out !== true && out.ok !== false
}

const DISPATCH_WAIT_DISCLOSED_AT_MS = 5000

function withDispatchWait(out, waitedMs) {
    if (waitedMs < DISPATCH_WAIT_DISCLOSED_AT_MS || !out || typeof out !== 'object' || Array.isArray(out)) return out
    return { ...out, dispatch_waited_ms: waitedMs }
}

function withResumeDisclosure(out, disclosure) {
    if (!out || typeof out !== 'object' || Array.isArray(out)) return { resumed: disclosure, response: out }
    const key = 'resumed' in out ? 'resumed_dispatch' : 'resumed'
    return { ...out, [key]: disclosure }
}

const deliveredInstructionHashByOwner = new Map()

function instructionOwnerKey(root, sessionId) {
    return `${path.resolve(root)} ${sessionId}`
}

const deliveredReplyHashByOwner = new Map()

function withAssertedInstructionHash(verb, body, root, sessionId) {
    if (verb !== 'instruction') return body
    const owner = instructionOwnerKey(root, sessionId)
    const knownReply = deliveredReplyHashByOwner.get(owner)
    const withReply = knownReply && typeof body.known_reply_hash !== 'string' ? { ...body, known_reply_hash: knownReply } : body
    if (typeof body.instruction_hash === 'string' || typeof body.known_instruction_hash === 'string') return withReply
    const known = deliveredInstructionHashByOwner.get(owner)
    return known ? { ...withReply, instruction_hash: known } : withReply
}

function rememberDeliveredInstructionHash(verb, parsed, root, sessionId) {
    if (verb !== 'instruction' || !parsed || parsed.ok === false) return
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
    const hash = typeof data.instruction_hash === 'string' ? data.instruction_hash : ''
    if (!hash) return
    const prose = typeof data.instruction === 'string' ? data.instruction : ''
    if (prose || data.instruction_unchanged === true) {
        deliveredInstructionHashByOwner.set(instructionOwnerKey(root, sessionId), hash)
    }
    if (typeof data.reply_hash === 'string' && data.reply_hash) {
        deliveredReplyHashByOwner.set(instructionOwnerKey(root, sessionId), data.reply_hash)
    }
}

export async function gmDispatch(args, signal) {
    inflightDispatches += 1
    const startedAtMs = Date.now()
    appendDiagnostic('dispatch-start', { verb: args?.verb ?? null, cwd: args?.cwd ?? null, resume_task: args?.resume_task ?? null })
    try {
        return await runDispatch(args, signal)
    } catch (error) {
        appendDiagnostic('dispatch-error', { verb: args?.verb ?? null, error: error?.message ? String(error.message) : String(error) })
        throw error
    } finally {
        appendDiagnostic('dispatch-end', { verb: args?.verb ?? null, ms: Date.now() - startedAtMs, inflight: inflightDispatches - 1 })
        inflightDispatches -= 1
    }
}

async function runDispatch({ verb, body, raw_body, session_id, cwd, timeout_seconds, poll_interval_seconds, include_timing, resume_task, full_response, max_chars }, signal) {
    if (!verb) return 'error: verb required'
    if (!session_id) return 'error: session_id required'
    const n = resume_task || nextN(session_id)
    const unsafeName = unsafeSpoolName('verb', verb) || unsafeSpoolName('session_id', session_id) || unsafeSpoolName('task', n)
    if (unsafeName) return `error: ${unsafeName} -- nothing was written to the spool, so no dispatch was queued`
    const toYaml = (obj) => yaml.dump(obj, { lineWidth: 100 })
    const resolvedRoot = resolveDispatchRoot(cwd)
    if (resolvedRoot.error) {
        appendDiagnostic('dispatch-root-refused', { verb, root: resolvedRoot.refused_root, reason: resolvedRoot.refused_reason })
        return toYaml(resolvedRoot)
    }
    if (resolvedRoot.root_source !== 'cwd') {
        appendDiagnostic('dispatch-root-defaulted', { verb, root: resolvedRoot.root, source: resolvedRoot.root_source })
    }
    const root = resolvedRoot.root
    const spoolDir = path.join(root, '.gm', 'exec-spool')
    const inDir = path.join(spoolDir, 'in', verb)
    const outDir = path.join(spoolDir, 'out')
    fs.mkdirSync(outDir, { recursive: true })
    const callStartedAtMs = Date.now()
    let lastWakeSource = 'initial_check'

    const isPlainText = PLAIN_TEXT_BODY_VERBS.has(verb) || typeof raw_body === 'string'
    if (!resume_task && isPlainText && typeof raw_body !== 'string') {
        raw_body = plainTextFromBody(body)
        if (typeof raw_body !== 'string') {
            return `error: ${verb} takes a plain-text body -- pass the text as the top-level raw_body argument (a string), e.g. raw_body: "return 1". body is for JSON verbs; here it is accepted only as a string or as an object with exactly one string field among ${PLAIN_TEXT_BODY_FIELDS.join(', ')}`
        }
    }

    let normalizedBody
    if (!resume_task && !isPlainText) {
        const normalized = normalizedObjectBody(verb, body)
        if (normalized.error) return `error: ${normalized.error}`
        const globCoerced = withGlobFiltersCoerced(verb, normalized.value)
        if (globCoerced.error) return `error: ${globCoerced.error}`
        const diagnostic = objectBodyDiagnostic(verb, globCoerced.value)
        if (diagnostic) return `error: ${diagnostic}`
        normalizedBody = withAssertedInstructionHash(verb, withCodesearchScalarsCoerced(verb, globCoerced.value), root, session_id)
    }

    const inPath = path.join(inDir, `${n}.txt`)
    const outPath = path.join(outDir, `${verb}-${n}.json`)

    if (resume_task && !fs.existsSync(outPath) && !fs.existsSync(inPath) && !fs.existsSync(`${inPath}.inflight`)) {
        return toYaml({
            error: `resume_task "${n}" names no dispatch in this project's spool -- nothing was dispatched`,
            resumed: {
                task: n,
                sent_no_body: true,
                wrote_no_new_dispatch: true,
                checked_out_file: outPath,
                checked_queued_input: inPath,
                checked_claimed_input: `${inPath}.inflight`,
                note: 'a resume never re-sends a body; it only re-polls a dispatch the daemon already accepted, so verb and cwd must match the original call exactly and task must be the `task` field copied verbatim from that call\'s timed_out/aborted response. A task whose out-file has since been cleaned up cannot be resumed -- dispatch it again with its original body',
            },
        })
    }

    if (!resume_task) {
        const unavailable = runnerUnavailable(root, spoolDir)
        if (unavailable) return toYaml(unavailable)
        const notRunning = await daemonNotRunning(root, spoolDir, signal)
        if (notRunning) return toYaml(notRunning)
        ensureSpoolRunnerRunning(root)
        startRunnerWatchdog(root)
        if (isPlainText) {
            publishSpoolRequest(inDir, inPath, n, withTimeoutMsPrefix(verb, raw_body, timeout_seconds))
        } else {
            const fullBody = { ...normalizedBody, session_id }
            publishSpoolRequest(inDir, inPath, n, JSON.stringify(fullBody))
        }
    }

    const requestedTimeoutMs = resume_task ? Math.max(0, (Number(timeout_seconds) || DEFAULT_TIMEOUT_SECONDS) * 1000) : pollTimeoutMs(verb, raw_body, timeout_seconds)
    const budget = applyClientDeadline(requestedTimeoutMs)
    const timeoutMs = budget.ms
    const pollMs = Math.max(25, (Number(poll_interval_seconds) || 0.25) * 1000)
    const deadline = Date.now() + timeoutMs


    const readLandedOutFile = () => {
        if (!fs.existsSync(outPath)) return undefined
        let landedAtMs = null
        try {
            landedAtMs = fs.statSync(outPath).mtimeMs
        } catch {
            landedAtMs = null
        }
        try {
            const parsed = unpackExecOutputEnvelope(verb, JSON.parse(fs.readFileSync(outPath, 'utf8')))
            rememberDeliveredInstructionHash(verb, parsed, root, session_id)
            const plainTextFile = typeof parsed?.result_file === 'string' ? parsed.result_file : undefined
            const cleaned = cleanResponse(parsed, undefined, outPath, plainTextFile, untruncatedKeysFor(verb, normalizedBody), inlineMaxForVerb({ verb, isPlainText, fullResponse: full_response, maxChars: max_chars }))
            let out = cleaned
            if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && cleaned.data && typeof cleaned.data === 'object' && !Array.isArray(cleaned.data)) {
                const { data, ...rest } = cleaned
                const collides = Object.keys(data).some(k => k in rest)
                if (!collides) out = { ...rest, ...data }
            }
            if (!full_response && carriedNoFailure(out)) out = compactWireResponse(out, outPath)
            if (resume_task) out = withResumeDisclosure(out, resumeDisclosure(n, landedAtMs, callStartedAtMs))
            else out = withDispatchWait(out, Date.now() - callStartedAtMs)
            if (out && typeof out === 'object' && out.instruction_unchanged === true && normalizedBody?.instruction_hash) {
                out = { ...out, instruction_text_at: path.join(root, '.gm', 'next-step.md') }
            }
            if (include_timing === true || include_timing === 'true') {
                const timingKey = out && typeof out === 'object' && !Array.isArray(out) && 'mcp_timing' in out ? 'mcp_client_timing' : 'mcp_timing'
                const timing = {
                    submitted_at_ms: callStartedAtMs,
                    response_observed_at_ms: Date.now(),
                    round_trip_ms: Date.now() - callStartedAtMs,
                    response_wakeup: lastWakeSource,
                    daemon_at_submission: readDaemonLiveness(spoolDir),
                }
                out = out && typeof out === 'object' && !Array.isArray(out) ? { ...out, [timingKey]: timing } : { response: out, [timingKey]: timing }
            }
            return toYaml(out)
        } catch (e) {
            const failed = { error: `response file was not valid JSON: ${e.message}`, task: n, out_path: outPath }
            return toYaml(resume_task ? withResumeDisclosure(failed, resumeDisclosure(n, landedAtMs, callStartedAtMs)) : failed)
        }
    }

    const withdrawUnclaimedRequest = () => {
        if (resume_task) return false
        try {
            fs.unlinkSync(inPath)
            return true
        } catch {
            return false
        }
    }
    const abortedReply = () => toYaml({
        error: 'aborted',
        task: n,
        dispatch_root: root,
        root_source: resolvedRoot.root_source,
        in_path: inPath,
        out_path: outPath,
        aborted_after_ms: Date.now() - callStartedAtMs,
        request_withdrawn_before_claim: withdrawUnclaimedRequest(),
        note: `the caller stopped waiting after ${Date.now() - callStartedAtMs}ms; the dispatch itself was NOT cancelled${resume_task ? '' : ' once the daemon claimed it'} and its result still lands in out_path once the daemon finishes. Re-poll the SAME dispatch with resume_task set to this response's task (same verb and cwd, no body) instead of dispatching again -- a re-dispatch queues a second copy of the same work.`,
    })

    while (true) {
        if (signal?.aborted) return abortedReply()
        // A daemon that dies between the preflight and the claim leaves this
        // dispatch queued_not_yet_claimed for its whole poll budget. Re-ask for
        // a runner on every wake instead of only once up front: the throttle
        // inside ensureSpoolRunnerRunning keeps it to one attempt every
        // ENSURE_INTERVAL_MS, and it is a no-op while the daemon is live.
        ensureSpoolRunnerRunning(root)
        const landed = readLandedOutFile()
        if (landed !== undefined) return landed
        if (Date.now() >= deadline) {
            const finalRecheckDeadline = Date.now() + FINAL_OUT_RECHECK_WINDOW_MS
            while (Date.now() < finalRecheckDeadline) {
                try {
                    await sleep(FINAL_OUT_RECHECK_INTERVAL_MS, signal)
                } catch {
                    break
                }
                const landedLate = readLandedOutFile()
                if (landedLate !== undefined) return landedLate
            }
            return toYaml({
                timed_out: true,
                task: n,
                resume_task_supported: true,
                resumed_this_call: Boolean(resume_task),
                dispatch_root: root,
                root_source: resolvedRoot.root_source,
                in_path: inPath,
                out_path: outPath,
                final_out_recheck_window_ms: FINAL_OUT_RECHECK_WINDOW_MS,
                poll_budget: pollBudgetDisclosure(budget, Date.now() - callStartedAtMs),
                dispatch_state: readSpoolDispatchState(spoolDir, verb, n),
                progress: readDispatchWaitProgress(spoolDir, verb, n),
                daemon: readDaemonLiveness(spoolDir),
                ...staleChromeTimeoutNote(verb),
            })
        }
        try {
            lastWakeSource = await waitForSpoolChange(outDir, outPath, deadline - Date.now(), pollMs, signal)
        } catch {
            return abortedReply()
        }
    }
}
