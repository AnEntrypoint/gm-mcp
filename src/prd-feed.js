import * as yaml from 'js-yaml'
import { CONTINUATION_URI, NEXT_PRD_FIELD_CHARS, NEXT_PRD_URI, prdChangeOf } from './continuation.js'
import { isSubscribed } from './browser-feed.js'

// PRD rows for the continuation feed, the push notifications and the gm://prd resources. Every read goes through
// a dispatch function the caller passes in, so this module does not import dispatch.js.

// Longest a reply waits for the next-row lookup. A lookup that misses it leaves next_prd out of that reply.
export const NEXT_PRD_BUDGET_MS = 1500
// Session id for reads the server makes on its own (resources, the prompt, the idle warning).
export const SERVER_SESSION_ID = `mcp-server-${process.pid}`

let pushSink = null
let lastNextId = undefined

// stdio only: sink(uri) sends notifications/resources/updated. HTTP never installs one, so HTTP sends no push.
export function setPrdPushSink(sink) {
    pushSink = typeof sink === 'function' ? sink : null
}

function clip(value) {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
    return flat.length > NEXT_PRD_FIELD_CHARS ? `${flat.slice(0, NEXT_PRD_FIELD_CHARS - 3)}...` : flat
}

function briefRow(row) {
    return { id: clip(row.id), status: clip(row.status), title: clip(row.title ?? row.subject) }
}

// The failure text of a reply, or null. A refused verb answers ok: false; a refused root answers a top-level error string.
export function failureOf(doc) {
    if (doc.ok === false) return String(doc.error ?? doc.error_code ?? 'verb reported ok: false')
    if (typeof doc.error === 'string' && doc.error !== '') return doc.error
    return null
}

// Parses a prd-list reply into brief rows. Reads only its text.
export function pageOf(text) {
    let doc
    try {
        doc = yaml.load(String(text))
    } catch {
        return { ok: false, error: 'prd-list reply is not a document' }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: String(text).trim().slice(0, 300) || 'empty prd-list reply' }
    const failure = failureOf(doc)
    if (failure !== null) return { ok: false, error: failure }
    const data = Array.isArray(doc.items) ? doc : doc.data && typeof doc.data === 'object' && Array.isArray(doc.data.items) ? doc.data : null
    if (data === null) return { ok: false, error: 'prd-list reply has no items' }
    return {
        ok: true,
        items: data.items.filter((row) => row && typeof row === 'object' && !Array.isArray(row)).map(briefRow),
        pending_total: typeof data.pending_total === 'number' ? data.pending_total : null,
    }
}

// Reads up to limit pending rows. Never throws: a dispatch that throws is an ok: false page.
// prd_feed marks the read as the feed's own, so reading it never triggers another feed lookup.
export async function readPendingPage(dispatch, { limit = 1, cwd, session_id = SERVER_SESSION_ID } = {}) {
    let reply
    try {
        reply = await dispatch({ verb: 'prd-list', body: { status: 'pending', limit }, cwd, session_id, prd_feed: true })
    } catch (error) {
        return { ok: false, error: `prd-list dispatch threw: ${error?.message ?? error}` }
    }
    return pageOf(reply)
}

function noteNextRow(row) {
    const id = row ? row.id : null
    if (lastNextId !== undefined && id !== lastNextId && pushSink !== null) {
        for (const uri of [NEXT_PRD_URI, CONTINUATION_URI]) {
            if (isSubscribed(uri)) pushSink(uri)
        }
    }
    lastNextId = id
}

// Settles to promise, or to fallback when ms passes first or the promise rejects. The timer is cleared on settle.
export function withinBudget(promise, ms, fallback) {
    let timer = null
    const budget = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
        timer.unref?.()
    })
    return Promise.race([promise.catch(() => fallback), budget]).finally(() => clearTimeout(timer))
}

// {next_prd, pending_total} with the first pending row (null when none), or {} when the lookup failed or missed NEXT_PRD_BUDGET_MS.
// A lookup that finishes late still updates the push state.
export function nextPrdFor(dispatch, { cwd, session_id } = {}) {
    const lookup = readPendingPage(dispatch, { limit: 1, cwd, session_id }).then((page) => {
        if (!page.ok) return {}
        const row = page.items[0] ?? null
        noteNextRow(row)
        return { next_prd: row, pending_total: page.pending_total }
    })
    return withinBudget(lookup, NEXT_PRD_BUDGET_MS, {})
}

// The continuation feed for one reply: undefined when the reply moves no PRD state, otherwise nextPrdFor's result.
export function prdFeedFor(key, verb, text, dispatch, args = {}) {
    if (!prdChangeOf(key, verb, text)) return undefined
    return nextPrdFor(dispatch, { cwd: args.cwd, session_id: args.session_id || undefined })
}
