import * as yaml from 'js-yaml'
import path from 'node:path'
import { BUNDLE_VERSION } from './bundle-version.js'
import { servingTransportKind } from './bundle-drift.js'
import { BOOTSTRAP_ERROR_CHARS, CHECKLIST_URI, claimBootstrap, pendingRowsOf, withBootstrap } from './continuation.js'
import { SERVER_SESSION_ID, failureOf, nextPrdFor, withinBudget } from './prd-feed.js'
import { appendDiagnostic, describeError } from './server-log.js'

// Live project state for the session bootstrap (the first reply of a session that names a cwd) and for the skill prompts.
// Each read is one dispatch with prd_feed: true, which marks a server read: it gets no feed and no bootstrap. Every read
// goes through the dispatch function the caller passes in, so this module does not import dispatch.js.

// One budget for each live read. The status, git and next-row reads each get it, and they run together.
export const LIVE_BUDGET_MS = 1500
export const NO_PROJECT_ROOT_TEXT = 'no project root given; pass cwd to include live state'
const UNKNOWN_RUNNER = { alive: null, heartbeat_age_ms: null, heartbeat_stale: null }

function clipText(value) {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
    return flat.length > BOOTSTRAP_ERROR_CHARS ? `${flat.slice(0, BOOTSTRAP_ERROR_CHARS - 3)}...` : flat
}

const timedOut = (what) => `${what} did not answer within ${LIVE_BUDGET_MS} ms`

// {ok, data} with the reply's data field (or the document itself), or {ok: false, error} for a non-document or a failure.
function payloadOf(text) {
    let doc
    try {
        doc = yaml.load(String(text))
    } catch {
        return { ok: false, error: 'reply is not a document' }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'reply is not a document' }
    const failure = failureOf(doc)
    if (failure !== null) return { ok: false, error: failure }
    return { ok: true, data: doc.data && typeof doc.data === 'object' ? doc.data : doc }
}

// {ok, runner} from a status reply. alive is true only when a heartbeat is present and not stale.
function runnerOf(text) {
    const read = payloadOf(text)
    if (!read.ok) return read
    const daemon = read.data.daemon
    if (!daemon || typeof daemon !== 'object') return { ok: false, error: 'status reply has no daemon section' }
    const age = typeof daemon.heartbeat_age_ms === 'number' ? daemon.heartbeat_age_ms : null
    const stale = typeof daemon.heartbeat_stale === 'boolean' ? daemon.heartbeat_stale : true
    return { ok: true, runner: { alive: age !== null && !stale, heartbeat_age_ms: age, heartbeat_stale: stale } }
}

// {ok, runner} from one status read under the live budget. A read that misses the budget or fails is not ok.
async function statusRead(dispatch, { cwd, session_id }) {
    const lookup = dispatch({ verb: 'status', body: {}, cwd, session_id, prd_feed: true })
    const reply = await withinBudget(lookup, LIVE_BUDGET_MS, null)
    if (reply === null) return { ok: false, error: timedOut('status read') }
    return runnerOf(reply)
}


// {count, next, error} from a next-row lookup. count prefers the lookup's pending total, then the reply's own count.
function pendingOf(found, pendingRows) {
    const count = found.pending_total ?? pendingRows ?? null
    if (found.next_prd === undefined) return { count, next: null, error: timedOut('next pending row lookup') }
    return { count, next: found.next_prd, error: null }
}

// The bootstrap block for cwd. A feed result is reused when given, so the next-row lookup runs at most once. Never throws.
async function bootstrapBlock(dispatch, { cwd, session_id, feed, pendingRows }) {
    const base = {
        server: { version: BUNDLE_VERSION, transport: servingTransportKind() },
        runner: UNKNOWN_RUNNER,
        pending: { count: pendingRows, next: null },
        checklist_uri: CHECKLIST_URI,
        bootstrap_complete: true,
    }
    try {
        const [status, found] = await Promise.all([
            statusRead(dispatch, { cwd, session_id }),
            feed !== undefined ? feed : nextPrdFor(dispatch, { cwd, session_id }),
        ])
        const pending = pendingOf(found, pendingRows)
        const errors = [status.ok ? null : `runner: ${status.error}`, pending.error ? `pending: ${pending.error}` : null].filter(Boolean)
        return {
            ...base,
            runner: status.ok ? status.runner : UNKNOWN_RUNNER,
            pending: { count: pending.count, next: pending.next },
            ...(errors.length > 0 ? { bootstrap_error: clipText(errors.join('; ')) } : {}),
        }
    } catch (error) {
        return { ...base, bootstrap_error: clipText(`bootstrap failed: ${describeError(error)}`) }
    }
}

// True when a reply is a refusal or a failure. Such a reply does not use up the session's bootstrap.
function replyFailed(text) {
    let doc
    try {
        doc = yaml.load(text)
    } catch {
        return false
    }
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) && failureOf(doc) !== null
}

// Attaches the bootstrap to the session's first successful reply that names a cwd. Server reads, replies without a cwd and
// JSON array replies (which carry no field) leave it for a later reply. The reply is never blocked or failed by it.
export async function bootstrapReply(dispatch, key, continued, { reply, args, feed } = {}) {
    const cwd = typeof args?.cwd === 'string' ? args.cwd.trim() : ''
    if (args?.prd_feed === true || cwd === '' || typeof reply !== 'string' || /^\s*\[/.test(reply) || replyFailed(reply) || !claimBootstrap(key)) return continued
    const block = await bootstrapBlock(dispatch, { cwd, session_id: key || undefined, feed, pendingRows: pendingRowsOf(key) })
    try {
        return withBootstrap(continued, block)
    } catch (error) {
        appendDiagnostic('bootstrap-attach-failed', { error: describeError(error) })
        return continued
    }
}

function runnerLine(status) {
    if (!status.ok) return `runner: state unavailable (${clipText(status.error)})`
    const { alive, heartbeat_age_ms: age } = status.runner
    return `runner: ${alive ? 'alive' : 'not alive'}, heartbeat ${age === null ? 'missing' : `${age} ms old`}`
}

function pendingLine(pending) {
    if (pending.error) return `pending rows: state unavailable (${clipText(pending.error)})`
    return `pending rows: ${pending.count ?? 'unknown'}`
}

function nextLine(pending) {
    if (pending.error) return 'next pending row: state unavailable'
    const row = pending.next
    return row ? `next pending row: ${row.id} (${row.status}): ${row.title}` : 'next pending row: none'
}

// The live-state text of a prompt for cwd: runner, pending rows and the next pending row, read at fetch time under
// the same budget. No git read: a prompt must not wait on a checkout that may be parked. Never throws; a read that
// misses its budget reads "state unavailable".
export async function liveStateText(dispatch, cwd) {
    const root = typeof cwd === 'string' ? cwd.trim() : ''
    if (root === '') return NO_PROJECT_ROOT_TEXT
    if (!path.isAbsolute(root)) return 'state unavailable: cwd must be an absolute project root'
    try {
        const [status, found] = await Promise.all([
            statusRead(dispatch, { cwd: root }),
            nextPrdFor(dispatch, { cwd: root, session_id: SERVER_SESSION_ID }),
        ])
        const pending = pendingOf(found, null)
        return [runnerLine(status), pendingLine(pending), nextLine(pending)].join('\n')
    } catch (error) {
        return `state unavailable: ${clipText(describeError(error))}`
    }
}
