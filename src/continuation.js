import * as yaml from 'js-yaml'
import { renderReply, parseReply } from './reply-format.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { isPlainObject } from './plain-object.js'

export const CONTINUATION_STOP_VERB = 'continuation-stop'
export const CONTINUATION_LOGGER = 'gm.continuation'
export const CHECKLIST_URI = 'gm://workflow/completion-checklist'
export const NEXT_PRD_URI = 'gm://prd/next'
export const CONTINUATION_URI = 'gm://continuation'
// Longest id or title a next_prd carries. The worst-case block is built from it, so the reserve covers it.
export const NEXT_PRD_FIELD_CHARS = 160
// Longest bootstrap_error text. Like NEXT_PRD_FIELD_CHARS, the worst-case block is built from it.
export const BOOTSTRAP_ERROR_CHARS = 160
const MAX_WORKERS = 4
const GM_CONTINUE_REMINDER = 'gm walk not complete: read gm://prd/next and gm://workflow/completion-checklist, then take the next row before ending the turn'
const PRD_STATE_VERBS = new Set(['prd-resolve', 'prd-add', 'prd-defer'])
const WORST_FIELD = 'w '.repeat(NEXT_PRD_FIELD_CHARS / 2).trimEnd()
const WORST_ERROR = 'e '.repeat(BOOTSTRAP_ERROR_CHARS / 2).trimEnd()
// The reserve covers the continuation block and the once-per-session bootstrap block, which can arrive on the same reply.
const WORST_CASE_CONTINUATION_BLOCK = {
    continuation: { state: 'stopped', pending_rows: 999999, idle_ms: 9999999999999, action: 'continue', max_concurrency: 4, reminder: GM_CONTINUE_REMINDER, next_prd: { id: WORST_FIELD, status: 'pending', title: WORST_FIELD }, checklist_uri: CHECKLIST_URI },
    bootstrap: { server: { version: BUNDLE_VERSION, transport: 'stdio' }, runner: { alive: false, heartbeat_age_ms: 9999999999999, heartbeat_stale: true }, pending: { count: 999999, next: { id: WORST_FIELD, status: 'pending', title: WORST_FIELD } }, checklist_uri: CHECKLIST_URI, bootstrap_complete: true, bootstrap_error: WORST_ERROR },
}
export const CONTINUATION_RESERVE_CHARS = renderReply(WORST_CASE_CONTINUATION_BLOCK).length + 1
const DEFAULT_IDLE_NOTIFY_MS = 60000
const MONITOR_TICK_MS = 15000
const RELAY_KEY = 'relay'
const PENDING_LINE = /^\s*prd_pending_count:\s*(\d+)\s*$/m
const PRD_LIST_VERB = /^verb:\s*prd-list\s*$/m
const PRD_LIST_TOTAL = /^total:\s*(\d+)\s*$/m
const PRD_PENDING_TOTAL = /^\s*pending_total:\s*(\d+)\s*$/m
const CONTINUATION_HEADS = /^continuation:\s*$/gm
const COMPLETE_LINE = /^\s*complete:\s*true\s*$/m

const entries = new Map()

function entryFor(key) {
    let entry = entries.get(key)
    if (!entry) {
        entry = { pending_rows: null, last_ms: Date.now(), stopped: false, notified_for: null, emitted: null, bootstrapped: false }
        entries.set(key, entry)
    }
    return entry
}

export function idleNotifyMs() {
    const raw = (process.env.GM_MCP_IDLE_NOTIFY_MS ?? '').trim()
    const value = raw === '' ? NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_NOTIFY_MS
}

export function continuationSnapshot(key, now = Date.now(), done = false) {
    const entry = entryFor(key)
    const action = entry.stopped ? 'stop' : entry.pending_rows === null ? 'none' : entry.pending_rows === 0 ? 'stop' : 'continue'
    const snapshot = {
        state: entry.stopped ? 'stopped' : (done || entry.pending_rows === null) ? 'done' : 'running',
        pending_rows: entry.pending_rows,
        idle_ms: Math.max(0, now - entry.last_ms),
        action,
    }
    if (action === 'continue') snapshot.max_concurrency = Math.min(entry.pending_rows, MAX_WORKERS)
    if (snapshot.state === 'running') snapshot.reminder = GM_CONTINUE_REMINDER
    return snapshot
}

// The snapshot of the key touched most recently, or null when no reply has been seen.
export function latestContinuationSnapshot(now = Date.now()) {
    let latest = null
    for (const [key, entry] of entries) {
        if (latest === null || entry.last_ms > latest.entry.last_ms) latest = { key, entry }
    }
    return latest === null ? null : continuationSnapshot(latest.key, now)
}

export function setContinuationStopped(key, stopped) {
    entryFor(key).stopped = stopped
}

function parsedJsonOf(text) {
    if (!/^\s*[{[]/.test(text)) return null
    try {
        return { value: JSON.parse(text) }
    } catch {
        return null
    }
}

// The pending-row count a reply reports, or null when it reports none.
function pendingCountOf(text, json) {
    const jsonPrdList = json?.value?.verb === 'prd-list'
    if (jsonPrdList && typeof json.value.pending_total === 'number') return json.value.pending_total
    const seen = PENDING_LINE.exec(text) ?? (PRD_LIST_VERB.test(text) ? PRD_PENDING_TOTAL.exec(text) ?? PRD_LIST_TOTAL.exec(text) : null)
    if (seen) return Number(seen[1])
    if (jsonPrdList && typeof json.value.total === 'number') return json.value.total
    return null
}

// True when a reply moves the PRD: a PRD-state verb, or a pending count that differs from the last one seen for this key.
export function prdChangeOf(key, verb, text) {
    if (typeof text !== 'string') return false
    if (PRD_STATE_VERBS.has(verb)) return true
    const counted = pendingCountOf(text, parsedJsonOf(text))
    return counted !== null && entryFor(key).pending_rows !== counted
}

function textBeforeTrailingBlock(text) {
    const heads = [...text.matchAll(CONTINUATION_HEADS)]
    for (const head of heads.reverse()) {
        const rest = text.slice(head.index + head[0].length)
        if (rest.split('\n').every(line => line === '' || /^\s/.test(line))) return text.slice(0, head.index)
    }
    return text
}

// prd is undefined when the reply moves no PRD state. Otherwise it is {next_prd} (next_prd is null when no row is pending)
// or {} when the next-row lookup did not answer in time; either way the block carries checklist_uri.
export function continuedReply(key, text, now = Date.now(), force = false, prd = undefined) {
    if (typeof text !== 'string') return text
    const entry = entryFor(key)
    const json = parsedJsonOf(text)
    const counted = pendingCountOf(text, json)
    if (counted !== null) entry.pending_rows = counted
    const done = json?.value?.complete === true || json?.value?.data?.complete === true || COMPLETE_LINE.test(text)
    const snapshot = continuationSnapshot(key, now, done)
    entry.last_ms = now
    if (snapshot.action === 'none') return text
    if (prd !== undefined) {
        if (prd.next_prd !== undefined) snapshot.next_prd = prd.next_prd
        snapshot.checklist_uri = CHECKLIST_URI
    }
    // idle_ms moves on every reply, so a block is repeated only when its state, pending rows, action or concurrency changed.
    const state = JSON.stringify([snapshot.state, snapshot.pending_rows, snapshot.action, snapshot.max_concurrency ?? null])
    if (!force && entry.emitted === state) return text
    entry.emitted = state
    if (json && json.value && typeof json.value === 'object' && !Array.isArray(json.value)) return JSON.stringify({ ...json.value, continuation: snapshot })
    if (json) return text
    const body = textBeforeTrailingBlock(text)
    const block = renderReply({ continuation: snapshot })
    const separator = body === '' || body.endsWith('\n') ? '' : '\n'
    return `${body}${separator}${block}`
}

// Reserved until the session's bootstrap is attached, so the bootstrap fits under max_chars on its reply.
export function continuationReserveFor(key) {
    const entry = entryFor(key)
    return entry.stopped || entry.pending_rows !== null || !entry.bootstrapped ? CONTINUATION_RESERVE_CHARS : 0
}

// True for the first caller only, so a session gets one bootstrap block.
export function claimBootstrap(key) {
    const entry = entryFor(key)
    if (entry.bootstrapped) return false
    entry.bootstrapped = true
    return true
}

export function pendingRowsOf(key) {
    return entryFor(key).pending_rows
}

// Adds a named block to a reply: a field of a JSON object, or YAML placed before the trailing continuation block.
export function withBlock(text, name, block) {
    if (typeof text !== 'string') return text
    const json = parsedJsonOf(text)
    if (json) return json.value !== null && typeof json.value === 'object' && !Array.isArray(json.value) ? JSON.stringify({ ...json.value, [name]: block }) : text
    const body = textBeforeTrailingBlock(text)
    const separator = body === '' || body.endsWith('\n') ? '' : '\n'
    return `${body}${separator}${renderReply({ [name]: block })}${text.slice(body.length)}`
}

export function withBootstrap(text, block) {
    return withBlock(text, 'bootstrap', block)
}

// The reply without its continuation block: a JSON key, or the trailing YAML block. Other blocks stay.
export function withoutContinuationBlock(text) {
    if (typeof text !== 'string') return text
    const json = parsedJsonOf(text)
    if (json) {
        if (!isPlainObject(json.value) || !('continuation' in json.value)) return text
        const { continuation: _dropped, ...rest } = json.value
        return JSON.stringify(rest)
    }
    return textBeforeTrailingBlock(text)
}

export function continuedReplyWithin(key, text, cap, cut, now = Date.now()) {
    if (typeof text !== 'string') return text
    const continued = continuedReply(key, text, now)
    if (continued.length <= cap) return continued
    if (continued === text) return cut(text, cap)
    const body = textBeforeTrailingBlock(text)
    if (!continued.startsWith(body)) return continuedReply(key, cut(text, cap - CONTINUATION_RESERVE_CHARS), now, true)
    const tail = continued.slice(body.length)
    return cut(body, cap - tail.length) + tail
}

export function continuationBlockOf(text) {
    const heads = [...String(text ?? '').matchAll(CONTINUATION_HEADS)]
    const last = heads.at(-1)
    if (!last) return null
    try {
        const doc = yaml.load(String(text).slice(last.index))
        return doc && typeof doc.continuation === 'object' ? doc.continuation : null
    } catch (err) {
        return { continuation_parse_error: String(err?.message ?? err) }
    }
}

export function observeRelayedReply(text) {
    const block = continuationBlockOf(text)
    if (!block || block.continuation_parse_error) return block
    const entry = entryFor(RELAY_KEY)
    if (typeof block.pending_rows === 'number') entry.pending_rows = block.pending_rows
    entry.stopped = block.state === 'stopped'
    entry.last_ms = Date.now()
    return block
}

// nextPrd, when given, is called before each idle warning and resolves to {next_prd} or {} (see continuedReply).
export function startContinuationMonitor(emit, nextPrd = null) {
    const threshold = idleNotifyMs()
    const tick = Math.max(1000, Math.min(MONITOR_TICK_MS, threshold))
    const timer = setInterval(() => {
        const now = Date.now()
        for (const [key, entry] of entries) {
            if (entry.stopped || entry.pending_rows === null || entry.pending_rows === 0) continue
            if (now - entry.last_ms < threshold || entry.notified_for === entry.last_ms) continue
            entry.notified_for = entry.last_ms
            const snapshot = continuationSnapshot(key, now)
            const warn = (extra) => emit({ level: 'warning', logger: CONTINUATION_LOGGER, data: { ...snapshot, ...extra, checklist_uri: CHECKLIST_URI } })
            if (nextPrd === null) warn({})
            else Promise.resolve().then(nextPrd).then((feed) => warn(feed && feed.next_prd !== undefined ? { next_prd: feed.next_prd } : {}), () => warn({}))
        }
    }, tick)
    timer.unref?.()
    return timer
}

export { RELAY_KEY }
