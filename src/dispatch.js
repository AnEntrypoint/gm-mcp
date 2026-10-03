import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as yaml from 'js-yaml'
import { cleanResponse, compactWireResponse, untruncatedKeysFor, PLAIN_TEXT_OUTPUT_INLINE_MAX, FILE_READ_INLINE_MAX, LONG_TEXT_INLINE_MAX_CEILING } from './response-compact.js'

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

const CODESEARCH_INTEGER_FIELDS = ['limit', 'head_limit', 'k', 'max_results', 'maxResults', 'max_matches', 'max_files', 'max_chars']
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

const BROWSER_PLAIN_TEXT_VERBS = ['serp', 'browser', 'cdp']

const EXEC_FAMILY_VERBS = ['exec_js', 'nodejs', 'javascript', 'node', 'js', 'bash', 'sh', 'shell', 'zsh', 'python', 'py', 'powershell', 'ps1', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno']

const PLAIN_TEXT_BODY_VERBS = new Set([...EXEC_FAMILY_VERBS, ...BROWSER_PLAIN_TEXT_VERBS])

const TIMEOUT_MS_PREFIX_VERBS = new Set(EXEC_FAMILY_VERBS)

const TIMEOUT_MS_PREFIX_LINE = /^\s*timeout(?:Ms|_ms)=/

const TIMEOUT_MS_PREFIX_VALUE = /^\s*timeout(?:Ms|_ms)=(\d+)/

const DEFAULT_TIMEOUT_SECONDS = 120

const EXEC_DEFAULT_LIMIT_SECONDS = 300

const POLL_MARGIN_PAST_EXEC_TIMEOUT_MS = 5000

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
    if (explicitSeconds > 0) return explicitSeconds * 1000
    const bodyPrefix = TIMEOUT_MS_PREFIX_VERBS.has(verb) && typeof raw_body === 'string' ? TIMEOUT_MS_PREFIX_VALUE.exec(raw_body) : null
    if (bodyPrefix) return Math.max(DEFAULT_TIMEOUT_SECONDS * 1000, Number(bodyPrefix[1]) + POLL_MARGIN_PAST_EXEC_TIMEOUT_MS)
    return DEFAULT_TIMEOUT_SECONDS * 1000
}

function timeoutMsFor(timeout_seconds) {
    const seconds = Number(timeout_seconds)
    return Math.max(100, Math.round((seconds > 0 ? seconds : EXEC_DEFAULT_LIMIT_SECONDS) * 1000))
}

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
        ? runnerBinaryMissing()
            ? `no live daemon heartbeat for this project and the agentplug-runner binary is not installed at ${RUNNER_PATH} -- nothing can claim this dispatch until the runner is installed`
            : 'daemon heartbeat is stale or missing -- it may be down or has not registered this project; check daemon.log, this is not necessarily this dispatch\'s fault'
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

function readSpoolDispatchState(spoolDir, verb, task) {
    const queuedPath = path.join(spoolDir, 'in', verb, `${task}.txt`)
    const claimedPath = `${queuedPath}.inflight`
    const claimed = fs.existsSync(claimedPath)
    const queued = !claimed && fs.existsSync(queuedPath)
    const state = claimed ? 'claimed_still_in_flight' : queued ? 'queued_not_yet_claimed' : 'no_input_file_left'
    const note = claimed
        ? `the daemon HAS claimed this dispatch (${claimedPath} exists) and has not written its out-file yet -- it is still running, not lost. Re-dispatch with resume_task set to this response's task to keep waiting on the SAME request instead of starting a duplicate`
        : queued
            ? `this request is still sitting UNCLAIMED in the spool queue (${queuedPath} exists) -- the daemon has not picked it up yet; it claims every settled ticket on each tick, so this means the daemon is between ticks or still starting, or this project already has its maximum of 32 claimed dispatches in flight. Re-dispatch with resume_task set to this response's task; writing a second dispatch only deepens the queue`
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

function carriedNoFailure(out) {
    return Boolean(out) && typeof out === 'object' && !Array.isArray(out)
        && out.error === undefined && out.timed_out !== true && out.ok !== false
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

export async function gmDispatch({ verb, body, raw_body, session_id, cwd, timeout_seconds, poll_interval_seconds, include_timing, resume_task, full_response, max_chars }, signal) {
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
        raw_body = plainTextFromBody(body)
        if (typeof raw_body !== 'string') {
            return `error: ${verb} takes a plain-text body -- pass the text as the top-level raw_body argument (a string), e.g. raw_body: "return 1". body is for JSON verbs; here it is accepted only as a string or as an object with exactly one string field among ${PLAIN_TEXT_BODY_FIELDS.join(', ')}`
        }
    }

    let normalizedBody
    if (!resume_task && !isPlainText) {
        const normalized = normalizedObjectBody(verb, body)
        if (normalized.error) return `error: ${normalized.error}`
        const diagnostic = objectBodyDiagnostic(verb, normalized.value)
        if (diagnostic) return `error: ${diagnostic}`
        normalizedBody = withAssertedInstructionHash(verb, withCodesearchScalarsCoerced(verb, normalized.value), root, session_id)
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
        ensureSpoolRunnerRunning(root)
        if (isPlainText) {
            publishSpoolRequest(inDir, inPath, n, withTimeoutMsPrefix(verb, raw_body, timeout_seconds))
        } else {
            const fullBody = { ...normalizedBody, session_id }
            publishSpoolRequest(inDir, inPath, n, JSON.stringify(fullBody))
        }
    }

    const timeoutMs = resume_task ? Math.max(0, (Number(timeout_seconds) || DEFAULT_TIMEOUT_SECONDS) * 1000) : pollTimeoutMs(verb, raw_body, timeout_seconds)
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
        in_path: inPath,
        out_path: outPath,
        request_withdrawn_before_claim: withdrawUnclaimedRequest(),
    })

    while (true) {
        if (signal?.aborted) return abortedReply()
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
            return abortedReply()
        }
    }
}
