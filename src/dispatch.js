import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as yaml from 'js-yaml'

let counter = 0
function nextN(sessionId) {
    counter += 1
    return `${sessionId}-${process.pid}-${Date.now()}-${counter}`
}

function publishSpoolRequest(inDir, inPath, task, body) {
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

const ENSURE_INTERVAL_MS = 15_000
const ENSURE_LEASE_MS = 5_000
const lastEnsuredAtByRoot = new Map()

function runnerBinaryMissing() {
    return !fs.existsSync(RUNNER_PATH)
}

const SWEEPER_HEARTBEAT_TRUSTED_MS = 120_000

function spoolAlreadySweptBySomeone(root) {
    try {
        const status = JSON.parse(fs.readFileSync(path.join(root, '.gm', 'exec-spool', '.status.json'), 'utf8'))
        return Date.now() - (status.ts || 0) < SWEEPER_HEARTBEAT_TRUSTED_MS
    } catch {
        return false
    }
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
        if (Date.now() - fs.statSync(lockPath).mtimeMs <= ENSURE_LEASE_MS) return false
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

function ensureSpoolRunnerRunning(root) {
    if (runnerBinaryMissing()) return
    const now = Date.now()
    const last = lastEnsuredAtByRoot.get(root) || 0
    if (now - last < ENSURE_INTERVAL_MS) return
    lastEnsuredAtByRoot.set(root, now)
    if (spoolAlreadySweptBySomeone(root)) return
    if (!claimRunnerEnsure(root)) return
    try {
        const child = spawn(RUNNER_PATH, ['spool'], {
            cwd: root,
            env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        })
        child.on('error', () => {})
        child.unref()
    } catch {
    }
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

const NOISE_KEYS = new Set(['dispatch_id', 'request_fingerprint'])

const LONG_TEXT_FIELD_TRUNCATE_AT = 400

const NEVER_TRUNCATE_KEYS = new Set(['error', 'reason', 'residuals'])

function truncateLongText(value, key, outPath) {
    if (typeof value !== 'string' || value.length <= LONG_TEXT_FIELD_TRUNCATE_AT) return value
    if (NEVER_TRUNCATE_KEYS.has(key)) return value
    return `${value.slice(0, LONG_TEXT_FIELD_TRUNCATE_AT)}... [${value.length} chars total, full text at ${outPath} field '${key}']`
}

const HIT_ARRAY_KEYS = new Set(['recall_hits', 'bm25_hits', 'vector_hits'])
const HIT_NOISE_KEYS = new Set(['cos', 'score', 'recency'])

const FALSE_IS_ABSENCE_OF_A_PROBLEM_KEYS = new Set([
    'session_mismatch',
    'instruction_unchanged',
    'instruction_suppressible_by_asserting_hash',
    'recall_embed_failed',
    'should_residual_scan',
    'fsm_graph_rejected',
])

function dropDuplicateRows(rows) {
    const seen = new Set()
    return rows.filter(row => {
        if (!row || typeof row !== 'object') return true
        const fingerprint = JSON.stringify(row)
        if (seen.has(fingerprint)) return false
        seen.add(fingerprint)
        return true
    })
}

function cleanHit(hit, outPath) {
    if (!hit || typeof hit !== 'object') return hit
    const out = {}
    for (const [k, v] of Object.entries(hit)) {
        if (HIT_NOISE_KEYS.has(k)) continue
        if (v === '' || v === null || v === undefined) continue
        out[k] = typeof v === 'string' ? truncateLongText(v, k, outPath)
            : (v && typeof v === 'object' && !Array.isArray(v)) ? cleanHit(v, outPath)
            : v
    }
    return out
}

function cleanResponse(value, keyHint, outPath) {
    if (Array.isArray(value)) {
        if (HIT_ARRAY_KEYS.has(keyHint)) return dropDuplicateRows(value.map(h => cleanHit(h, outPath)))
        const cleaned = value.map(v => cleanResponse(v, undefined, outPath)).filter(v => v !== undefined)
        return dropDuplicateRows(cleaned)
    }
    if (value && typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) {
            if (NOISE_KEYS.has(k)) continue
            if (v === null || v === undefined || v === '') continue
            if (v === false && FALSE_IS_ABSENCE_OF_A_PROBLEM_KEYS.has(k)) continue
            const cleanedV = cleanResponse(v, k, outPath)
            if (Array.isArray(cleanedV) && cleanedV.length === 0) continue
            if (cleanedV && typeof cleanedV === 'object' && !Array.isArray(cleanedV) && Object.keys(cleanedV).length === 0) continue
            out[k] = cleanedV
        }
        return out
    }
    if (typeof value === 'string' && keyHint) return truncateLongText(value, keyHint, outPath)
    return value
}

const BROWSER_PLAIN_TEXT_VERBS = ['serp', 'browser', 'cdp']

// The exec family: exec_js, its aliases, and every language stem it backs.
// gm rejects a body for these verbs that carries no `timeoutMs=<ms>` line
// (`invalid_args: missing timeoutMs`), so the wrapper adds one from its own
// timeout_seconds when the caller did not write it.
const EXEC_FAMILY_VERBS = ['exec_js', 'nodejs', 'javascript', 'node', 'js', 'typescript', 'bash', 'sh', 'shell', 'zsh', 'python', 'py', 'powershell', 'ps1', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno']

const PLAIN_TEXT_BODY_VERBS = new Set([...EXEC_FAMILY_VERBS, ...BROWSER_PLAIN_TEXT_VERBS])

const TIMEOUT_MS_PREFIX_VERBS = new Set(EXEC_FAMILY_VERBS)

// Mirrors gm's own strip_timeout_ms_prefix_directive: leading whitespace is
// skipped, then the first line must start with timeoutMs= or timeout_ms=.
const TIMEOUT_MS_PREFIX_LINE = /^\s*timeout(?:Ms|_ms)=/

const DEFAULT_TIMEOUT_SECONDS = 120

function timeoutMsFor(timeout_seconds) {
    const seconds = Number(timeout_seconds)
    return Math.max(100, Math.round((seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000))
}

// Returns the raw body with a timeoutMs=<ms> first line for an exec-family
// verb that lacks one. An explicit timeoutMs=/timeout_ms= line always wins.
export function withTimeoutMsPrefix(verb, raw_body, timeout_seconds) {
    if (!TIMEOUT_MS_PREFIX_VERBS.has(verb)) return raw_body
    if (TIMEOUT_MS_PREFIX_LINE.test(raw_body)) return raw_body
    return `timeoutMs=${timeoutMsFor(timeout_seconds)}\n${raw_body}`
}

const DAEMON_HEARTBEAT_STALE_MS = 20000

function readDaemonLiveness(spoolDir) {
    let status
    try {
        status = JSON.parse(fs.readFileSync(path.join(spoolDir, '.status.json'), 'utf8'))
    } catch {
        return { alive: null, note: 'no .status.json heartbeat found for this project yet -- the daemon may not have picked up this project at all' }
    }
    const now = Date.now()
    const heartbeatAgeMs = typeof status.ts === 'number' ? now - status.ts : null
    const alive = heartbeatAgeMs !== null && heartbeatAgeMs < DAEMON_HEARTBEAT_STALE_MS
    const busyForMs = typeof status.busy_until === 'number' ? status.busy_until - now : null
    const busy = busyForMs !== null && busyForMs > 0
    const note = !alive
        ? 'daemon heartbeat is stale or missing -- it may be down or has not registered this project; check daemon.log, this is not necessarily this dispatch\'s fault'
        : busy
            ? 'daemon is alive and still actively working on this project'
            : 'daemon is alive; busy_until is project-scoped and currently unset, which says nothing about this particular dispatch -- read dispatch_state for that'
    const liveness = { alive, heartbeat_age_ms: heartbeatAgeMs, busy, busy_for_ms: busy ? busyForMs : null, note }
    if (status.runtime) liveness.runtime = status.runtime
    if (typeof status.shared_process === 'boolean') liveness.shared_process = status.shared_process
    if (typeof status.queue_wait_ms === 'number') liveness.queue_wait_ms = status.queue_wait_ms
    if (typeof status.queue_depth === 'number') liveness.queue_depth = status.queue_depth
    if (typeof status.queue_position === 'number') liveness.queue_position = status.queue_position
    if (status.runner_update_in_progress) {
        liveness.runner_update_in_progress = true
        liveness.runner_update_waiting_ms = status.runner_update_waiting_ms ?? null
    }
    return liveness
}

function readSpoolDispatchState(spoolDir, verb, task) {
    const queuedPath = path.join(spoolDir, 'in', verb, `${task}.txt`)
    const claimedPath = `${queuedPath}.inflight`
    const claimed = fs.existsSync(claimedPath)
    const queued = !claimed && fs.existsSync(queuedPath)
    const state = claimed ? 'claimed_still_in_flight' : queued ? 'queued_not_yet_claimed' : 'no_input_file_left'
    const note = claimed
        ? `the daemon HAS claimed this dispatch (${claimedPath} exists) and has not written its out-file yet -- it is still running, not lost. Re-dispatch with resume_task set to this response's task to keep waiting on the SAME request instead of starting a duplicate`
        : queued
            ? `this request is still sitting UNCLAIMED in the spool queue (${queuedPath} exists) -- the daemon has not picked it up yet, typically because its worker pool is saturated by other tickets. Re-dispatch with resume_task set to this response's task; writing a second dispatch only deepens the queue`
            : 'neither an input file nor an out-file exists for this task id, so the spool holds no evidence either way: either the id was never written (a resume_task typo), or it was claimed and then lost to a daemon exit / self-update handoff. A lost claim normally leaves a dispatch_orphaned out-file behind; since none appeared, re-dispatch fresh rather than resuming this id'
    return { state, claimed, queued, note }
}

const FINAL_OUT_RECHECK_WINDOW_MS = 2500
const FINAL_OUT_RECHECK_INTERVAL_MS = 150

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

function withResumeDisclosure(out, disclosure) {
    if (!out || typeof out !== 'object' || Array.isArray(out)) return { resumed: disclosure, response: out }
    const key = 'resumed' in out ? 'resumed_dispatch' : 'resumed'
    return { ...out, [key]: disclosure }
}

// instruction's served phase prose is tens of kilobytes and identical on
// nearly every call within a phase. The server omits it (instruction_unchanged:
// true, instruction: "") only when the caller asserts the hash of prose it is
// already holding -- so this process remembers, per (project root, session),
// the hash of the last prose it actually returned to a caller, and asserts it
// on that owner's next instruction dispatch. Keyed on the session as well as
// the root because the assertion is a claim about what THIS caller has seen;
// process-lifetime only, so a restarted server (a new agent session) is served
// the prose once again rather than inheriting a claim it cannot honour.
const deliveredInstructionHashByOwner = new Map()

function instructionOwnerKey(root, sessionId) {
    return `${path.resolve(root)} ${sessionId}`
}

function withAssertedInstructionHash(verb, body, root, sessionId) {
    if (verb !== 'instruction') return body
    if (typeof body.instruction_hash === 'string' || typeof body.known_instruction_hash === 'string') return body
    const known = deliveredInstructionHashByOwner.get(instructionOwnerKey(root, sessionId))
    return known ? { ...body, instruction_hash: known } : body
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
}

export async function gmDispatch({ verb, body, raw_body, session_id, cwd, timeout_seconds, poll_interval_seconds, include_timing, resume_task }, signal) {
    if (!verb) return 'error: verb required'
    if (!session_id) return 'error: session_id required'
    const root = cwd || process.cwd()
    const spoolDir = path.join(root, '.gm', 'exec-spool')
    const inDir = path.join(spoolDir, 'in', verb)
    const outDir = path.join(spoolDir, 'out')
    fs.mkdirSync(outDir, { recursive: true })
    const n = resume_task || nextN(session_id)
    const callStartedAtMs = Date.now()
    let lastWakeSource = 'initial_check'
    const toYaml = (obj) => yaml.dump(obj, { lineWidth: 100 })

    const isPlainText = PLAIN_TEXT_BODY_VERBS.has(verb) || typeof raw_body === 'string'
    if (!resume_task && isPlainText && typeof raw_body !== 'string') {
        return `error: ${verb} takes a plain-text body -- pass raw_body (a string), not body (a JSON object)`
    }

    let normalizedBody
    if (!resume_task && !isPlainText) {
        const normalized = normalizedObjectBody(verb, body)
        if (normalized.error) return `error: ${normalized.error}`
        const diagnostic = objectBodyDiagnostic(verb, normalized.value)
        if (diagnostic) return `error: ${diagnostic}`
        normalizedBody = withAssertedInstructionHash(verb, normalized.value, root, session_id)
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
        ensureSpoolRunnerRunning(root)
        if (isPlainText) {
            publishSpoolRequest(inDir, inPath, n, withTimeoutMsPrefix(verb, raw_body, timeout_seconds))
        } else {
            const fullBody = { ...normalizedBody, session_id }
            publishSpoolRequest(inDir, inPath, n, JSON.stringify(fullBody))
        }
    }

    const timeoutMs = Math.max(0, (Number(timeout_seconds) || 120) * 1000)
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
            const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
            rememberDeliveredInstructionHash(verb, parsed, root, session_id)
            const cleaned = cleanResponse(parsed, undefined, outPath)
            let out = cleaned
            if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && cleaned.data && typeof cleaned.data === 'object' && !Array.isArray(cleaned.data)) {
                const { data, ...rest } = cleaned
                const collides = Object.keys(data).some(k => k in rest)
                if (!collides) out = { ...rest, ...data }
            }
            if (resume_task) out = withResumeDisclosure(out, resumeDisclosure(n, landedAtMs, callStartedAtMs))
            if (out && typeof out === 'object' && out.instruction_unchanged === true && normalizedBody?.instruction_hash) {
                out = { ...out, instruction_text_at: path.join(root, '.gm', 'next-step.md') }
            }
            if (include_timing) {
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

    while (true) {
        if (signal?.aborted) return toYaml({ error: 'aborted', task: n, in_path: inPath, out_path: outPath })
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
                in_path: inPath,
                out_path: outPath,
                final_out_recheck_window_ms: FINAL_OUT_RECHECK_WINDOW_MS,
                dispatch_state: readSpoolDispatchState(spoolDir, verb, n),
                daemon: readDaemonLiveness(spoolDir),
            })
        }
        try {
            lastWakeSource = await waitForSpoolChange(outDir, outPath, deadline - Date.now(), pollMs, signal)
        } catch {
            return toYaml({ error: 'aborted', task: n, in_path: inPath, out_path: outPath })
        }
    }
}
