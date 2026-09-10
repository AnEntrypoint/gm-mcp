import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as yaml from 'js-yaml'

let counter = 0
function nextN(sessionId) {
    counter += 1
    return `${sessionId}-${Date.now()}-${counter}`
}

// gm's shared daemon only services project roots present in its own
// registry (~/.agentplug/daemon-registry.txt) -- a root is added to that
// registry ONLY by running the locally-installed runner binary's `spool`
// subcommand against it (see gm's AGENTS.md "Start, never install" /
// agentplug-runner's register_project()+ensure_daemon_running()). A raw
// write to .gm/exec-spool/in/<verb>/ for a root the daemon has never seen
// (e.g. the first-ever gm dispatch from a brand-new project directory) sits
// unprocessed forever: nobody is watching that directory, and no `out/`
// gets created, because both are daemon-side side effects of servicing a
// registered root, not of a spool file merely existing. gm's own SKILL.md
// documents the fix as a manual step ("Start it -- ~/.gm-tools/agentplug-
// runner spool -- fire-and-forget") for an agent following the raw
// protocol/Skill, but this MCP tool is a thinner client that bypasses that
// prose entirely, so it has to do the same fire-and-forget registration
// itself instead of silently inheriting a contract only the Skill text
// documents.
const RUNNER_DIR = path.join(os.homedir(), '.gm-tools')
const RUNNER_PATH = path.join(RUNNER_DIR, process.platform === 'win32' ? 'agentplug-runner.exe' : 'agentplug-runner')

// Per-root last-ensured timestamp, process-lifetime cache. register_project()
// and ensure_daemon_running() are both idempotent and cheap once a root is
// already registered and the daemon is fresh (near-instant early return), so
// re-running `spool` isn't unsafe -- but spawning a process on literally
// every dispatch call is still wasteful over a long session. Re-checking
// every 15s per root is frequent enough to self-heal if the daemon dies
// mid-session, without paying spawn overhead on every single verb dispatch.
const ENSURE_INTERVAL_MS = 15_000
const lastEnsuredAtByRoot = new Map()

function runnerBinaryMissing() {
    return !fs.existsSync(RUNNER_PATH)
}

// Fire-and-forget: spawns the already-installed local runner binary's
// `spool` subcommand against `root`, detached from this MCP server process.
// This is exactly the "start it" step gm's own SKILL.md tells a raw-protocol
// caller to run by hand -- launching an existing local executable, nothing
// more; it reaches no network itself (the runner's own self-update poll is
// a separate, independent concern). Never throws: a spawn failure here must
// not break the actual dispatch, which still proceeds and can time out with
// a clear reason.
function ensureSpoolRunnerRunning(root) {
    if (runnerBinaryMissing()) return
    const now = Date.now()
    const last = lastEnsuredAtByRoot.get(root) || 0
    if (now - last < ENSURE_INTERVAL_MS) return
    lastEnsuredAtByRoot.set(root, now)
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
        // Best-effort only -- the dispatch below still runs and will report
        // its own timed_out/error if nothing ever picks up the spool file.
    }
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        const onAbort = () => { clearTimeout(t); reject(new Error('aborted')) }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

// Fields present on nearly every raw gm spool response that carry zero
// decision-relevant signal for the calling agent -- an opaque id used only
// for the daemon's own internal dedup/logging, never referenced by any
// documented gm workflow.
const NOISE_KEYS = new Set(['dispatch_id', 'request_fingerprint'])

// instruction's own `data.instruction` field is the full served phase prose
// (thousands of words, repeated verbatim on nearly every call within a
// session) -- genuinely useful the FIRST time an agent reads a phase, pure
// repetition noise on every later call in the same phase. Kept in full only
// when it's short (a real, compact instruction) or when nothing else in the
// response would tell the caller what changed; otherwise collapsed to a
// length note so the response stays legible without silently discarding the
// only copy (the raw response is always still on disk at out_path if the
// full text is genuinely needed).
const LONG_TEXT_FIELD_TRUNCATE_AT = 400

// error/reason/residuals text IS the actionable content of a gate denial or
// failure response -- it names the exact next verb to dispatch (e.g. "Stop
// retrying: (1) prd-add a row..."). Truncating it the same way as reference
// prose like `instruction` would cut off the one thing the caller actually
// needs to act on. Never truncated regardless of length.
const NEVER_TRUNCATE_KEYS = new Set(['error', 'reason', 'residuals'])

function truncateLongText(value, key, outPath) {
    if (typeof value !== 'string' || value.length <= LONG_TEXT_FIELD_TRUNCATE_AT) return value
    if (NEVER_TRUNCATE_KEYS.has(key)) return value
    return `${value.slice(0, LONG_TEXT_FIELD_TRUNCATE_AT)}... [${value.length} chars total, full text at ${outPath} field '${key}']`
}

// recall_hits/bm25_hits/vector_hits (recall + codesearch's two ranking
// modes) all share the same shape: a numeric ranking field (score/cos/
// recency) that is mostly noise for a caller deciding what to act on, since
// `text` already opens with its own `path:line_start:line_end` locator --
// keep the fields that actually name WHAT was found (key, text, namespace,
// symbol.path/kind/line_start/line_end) and drop the ranking internals.
const HIT_ARRAY_KEYS = new Set(['recall_hits', 'bm25_hits', 'vector_hits'])
const HIT_NOISE_KEYS = new Set(['cos', 'score', 'recency'])

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

// Deep-cleans one gm spool response object: drops NOISE_KEYS at every level,
// truncates long string fields, cleans hit-array entries, drops
// null/undefined values and empty arrays/objects (nothing left for a caller
// to act on), and recurses into nested objects/arrays. Never mutates the
// input. outPath is threaded through purely so a truncation note can name
// the real file to read for the full text -- the returned value no longer
// carries a separate out_path field on every successful call (the caller
// already knows cwd/verb; the path is trivially reconstructable, and is
// only genuinely useful in the rare case something got truncated).
function cleanResponse(value, keyHint, outPath) {
    if (Array.isArray(value)) {
        if (HIT_ARRAY_KEYS.has(keyHint)) return value.map(h => cleanHit(h, outPath))
        const cleaned = value.map(v => cleanResponse(v, undefined, outPath)).filter(v => v !== undefined)
        return cleaned
    }
    if (value && typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) {
            if (NOISE_KEYS.has(k)) continue
            if (v === null || v === undefined) continue
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

// exec_js (and every language stem it backs: bash/python/powershell/ssh/go/
// rust/c/cpp/java/deno) plus serp/browser/cdp reject a JSON-object spool
// body outright -- gm's own AGENTS.md documents this explicitly ("Plain-
// text-body verbs ... all reject a JSON-object body; carry timeoutMs via a
// leading timeoutMs=<ms> prefix line, never JSON-wrapping"). raw_body lets
// a caller pass the literal text these verbs expect instead of a JSON body.
const PLAIN_TEXT_BODY_VERBS = new Set(['exec_js', 'bash', 'python', 'powershell', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno', 'serp', 'browser', 'cdp'])

// DAEMON_STALE_MS in agentplug-runner's daemon.rs -- a heartbeat older than
// this means the daemon that wrote it is gone, not just busy. Kept in sync by
// hand (no shared config surface crosses the Rust/JS boundary here); a drift
// between the two only makes the liveness note slightly stale-tolerant or
// strict, never wrong about a genuinely dead daemon.
const DAEMON_HEARTBEAT_STALE_MS = 20000

// Read on a timed-out poll only, never on the hot success path: `.status.json`
// is the daemon's own per-project heartbeat (agentplug-runner's daemon.rs
// write_project_heartbeat), including `busy_until` -- extended for the whole
// time an inflight dispatch is actually running. Without this, a first-time
// cold index/embed pass on a large repo that legitimately outruns a caller's
// chosen timeout_seconds returns a bare `timed_out: true` that reads
// identically to a wedged/dead daemon, which is exactly the ambiguity a
// caller needs resolved to know whether raising timeout_seconds (or resuming
// via resume_task below) is worth it versus the daemon actually being down.
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
            ? 'daemon is alive and still actively working on this project -- this is very likely NOT a hang. Re-dispatch with resume_task set to this response\'s task field to keep waiting on the SAME in-flight request instead of starting a new, duplicate one'
            : 'daemon is alive but reports no busy work for this project right now -- the original request may have already finished (re-check out_path) or was never claimed'
    return { alive, heartbeat_age_ms: heartbeatAgeMs, busy, busy_for_ms: busy ? busyForMs : null, note }
}

// Runs the whole gm spool write-then-poll-for-response cycle for one verb
// dispatch: writes .gm/exec-spool/in/<verb>/<N>.txt, polls
// .gm/exec-spool/out/<verb>-<N>.json until it appears (or the timeout
// elapses), and returns its contents as flat YAML text, auto-cleaned for
// readability (opaque internal ids stripped, response/data nesting
// flattened, long text truncated with a pointer to the full file, hit-array
// ranking internals dropped, empty/null fields removed). A successful
// response omits the spool file paths entirely; they only appear on
// timeout/abort/error, to say where to look.
//
// resume_task: pass the `task` field from a previous timed_out/aborted
// response to keep polling that SAME dispatch instead of writing a new
// .txt (and so racing a fresh, duplicate spool entry against work that may
// already be in flight, or already sitting done-but-unread in out/). Every
// gmDispatch call used to mint a brand-new task unconditionally, so a
// caller whose timeout_seconds was merely too short for a legitimate
// first-time cold index/embed pass had no way to reconnect to it -- it
// could only re-dispatch, discarding a result that was often seconds away
// from landing (live-witnessed: a codesearch cold-index pass against a
// large real repo completed successfully at ~6.7 minutes with a correct,
// useful result sitting unread in out/, while the caller had already moved
// on to a second dispatch that a different gate then denied).
export async function gmDispatch({ verb, body, raw_body, session_id, cwd, timeout_seconds, poll_interval_seconds, resume_task }, signal) {
    if (!verb) return 'error: verb required'
    if (!session_id) return 'error: session_id required'
    const root = cwd || process.cwd()
    const spoolDir = path.join(root, '.gm', 'exec-spool')
    const inDir = path.join(spoolDir, 'in', verb)
    const outDir = path.join(spoolDir, 'out')
    const n = resume_task || nextN(session_id)

    const isPlainText = PLAIN_TEXT_BODY_VERBS.has(verb) || typeof raw_body === 'string'
    if (isPlainText && typeof raw_body !== 'string') {
        return `error: ${verb} takes a plain-text body -- pass raw_body (a string), not body (a JSON object)`
    }

    const inPath = path.join(inDir, `${n}.txt`)
    if (!resume_task) {
        // Make sure something is actually watching `root`'s spool BEFORE
        // handing it a request -- see ensureSpoolRunnerRunning's comment.
        // Skipped on resume_task: a resumed poll targets a dispatch that
        // was already accepted once (the daemon that's servicing it is, by
        // definition, already running and already knows this root).
        ensureSpoolRunnerRunning(root)
        fs.mkdirSync(inDir, { recursive: true })
        if (isPlainText) {
            fs.writeFileSync(inPath, raw_body, 'utf8')
        } else {
            const fullBody = { session_id, ...(body || {}) }
            fs.writeFileSync(inPath, JSON.stringify(fullBody), 'utf8')
        }
    }

    const outPath = path.join(outDir, `${verb}-${n}.json`)
    const timeoutMs = Math.max(0, (Number(timeout_seconds) || 120) * 1000)
    const pollMs = Math.max(200, (Number(poll_interval_seconds) || 1) * 1000)
    const deadline = Date.now() + timeoutMs

    // YAML instead of JSON: no braces/quotes/commas, meaningfully more
    // compact for an LLM to read back for the same information -- gm's own
    // spool files stay JSON (that's the daemon's own wire format,
    // untouched), only this returned text is reformatted.
    const toYaml = (obj) => yaml.dump(obj, { lineWidth: 100 })

    while (true) {
        if (signal?.aborted) return toYaml({ error: 'aborted', task: n, in_path: inPath, out_path: outPath })
        if (fs.existsSync(outPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
                const cleaned = cleanResponse(parsed, undefined, outPath)
                // The raw gm response is already a flat object carrying its
                // own ok/verb/data/... at the top level -- data is a second
                // pure-nesting level every real gm verb response wraps its
                // actual payload one key deep in. Flatten it up one level
                // UNLESS doing so would silently overwrite a same-named
                // sibling field.
                let out = cleaned
                if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && cleaned.data && typeof cleaned.data === 'object' && !Array.isArray(cleaned.data)) {
                    const { data, ...rest } = cleaned
                    const collides = Object.keys(data).some(k => k in rest)
                    if (!collides) out = { ...rest, ...data }
                }
                return toYaml(out)
            } catch (e) {
                return toYaml({ error: `response file was not valid JSON: ${e.message}`, task: n, out_path: outPath })
            }
        }
        // task is only surfaced on a NOT-yet-successful outcome (matching the
        // existing in_path/out_path convention above this loop) -- it is the
        // one piece of information a caller needs to resume THIS dispatch via
        // resume_task instead of starting a new, duplicate one next call.
        if (Date.now() >= deadline) return toYaml({ timed_out: true, task: n, in_path: inPath, out_path: outPath, daemon: readDaemonLiveness(spoolDir) })
        try {
            await sleep(Math.min(pollMs, deadline - Date.now()), signal)
        } catch {
            return toYaml({ error: 'aborted', task: n, in_path: inPath, out_path: outPath })
        }
    }
}
