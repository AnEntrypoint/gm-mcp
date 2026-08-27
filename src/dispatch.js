import fs from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'

let counter = 0
function nextN(sessionId) {
    counter += 1
    return `${sessionId}-${Date.now()}-${counter}`
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

// Runs the whole gm spool write-then-poll-for-response cycle for one verb
// dispatch: writes .gm/exec-spool/in/<verb>/<N>.txt, polls
// .gm/exec-spool/out/<verb>-<N>.json until it appears (or the timeout
// elapses), and returns its contents as flat YAML text, auto-cleaned for
// readability (opaque internal ids stripped, response/data nesting
// flattened, long text truncated with a pointer to the full file, hit-array
// ranking internals dropped, empty/null fields removed). A successful
// response omits the spool file paths entirely; they only appear on
// timeout/abort/error, to say where to look.
export async function gmDispatch({ verb, body, raw_body, session_id, cwd, timeout_seconds, poll_interval_seconds }, signal) {
    if (!verb) return 'error: verb required'
    if (!session_id) return 'error: session_id required'
    const root = cwd || process.cwd()
    const spoolDir = path.join(root, '.gm', 'exec-spool')
    const inDir = path.join(spoolDir, 'in', verb)
    const outDir = path.join(spoolDir, 'out')
    const n = nextN(session_id)

    const isPlainText = PLAIN_TEXT_BODY_VERBS.has(verb) || typeof raw_body === 'string'
    if (isPlainText && typeof raw_body !== 'string') {
        return `error: ${verb} takes a plain-text body -- pass raw_body (a string), not body (a JSON object)`
    }

    fs.mkdirSync(inDir, { recursive: true })
    const inPath = path.join(inDir, `${n}.txt`)
    if (isPlainText) {
        fs.writeFileSync(inPath, raw_body, 'utf8')
    } else {
        const fullBody = { session_id, ...(body || {}) }
        fs.writeFileSync(inPath, JSON.stringify(fullBody), 'utf8')
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
        if (signal?.aborted) return toYaml({ error: 'aborted', in_path: inPath, out_path: outPath })
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
                return toYaml({ error: `response file was not valid JSON: ${e.message}`, out_path: outPath })
            }
        }
        if (Date.now() >= deadline) return toYaml({ timed_out: true, in_path: inPath, out_path: outPath })
        try {
            await sleep(Math.min(pollMs, deadline - Date.now()), signal)
        } catch {
            return toYaml({ error: 'aborted', in_path: inPath, out_path: outPath })
        }
    }
}
