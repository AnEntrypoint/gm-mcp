import * as yaml from 'js-yaml'

export const CONTINUATION_STOP_VERB = 'continuation-stop'
export const CONTINUATION_LOGGER = 'gm.continuation'
const MAX_WORKERS = 4
const WORST_CASE_CONTINUATION_BLOCK = { continuation: { state: 'stopped', pending_rows: 999999, idle_ms: 9999999999999, action: 'continue', max_concurrency: 4 } }
export const CONTINUATION_RESERVE_CHARS = yaml.dump(WORST_CASE_CONTINUATION_BLOCK, { lineWidth: 100 }).length + 1
const DEFAULT_IDLE_NOTIFY_MS = 300000
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
        entry = { pending_rows: null, last_ms: Date.now(), stopped: false, notified_for: null }
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
    return snapshot
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

function textBeforeTrailingBlock(text) {
    const heads = [...text.matchAll(CONTINUATION_HEADS)]
    for (const head of heads.reverse()) {
        const rest = text.slice(head.index + head[0].length)
        if (rest.split('\n').every(line => line === '' || /^\s/.test(line))) return text.slice(0, head.index)
    }
    return text
}

export function continuedReply(key, text, now = Date.now()) {
    if (typeof text !== 'string') return text
    const entry = entryFor(key)
    const json = parsedJsonOf(text)
    const jsonPending = json?.value?.verb === 'prd-list' && typeof json.value.pending_total === 'number' ? json.value.pending_total : null
    const jsonPrdTotal = json?.value?.verb === 'prd-list' && typeof json.value.total === 'number' ? json.value.total : null
    const isPrdList = PRD_LIST_VERB.test(text)
    const seen = PENDING_LINE.exec(text) ?? (isPrdList ? PRD_PENDING_TOTAL.exec(text) ?? PRD_LIST_TOTAL.exec(text) : null)
    if (jsonPending !== null) entry.pending_rows = jsonPending
    else if (seen) entry.pending_rows = Number(seen[1])
    else if (jsonPrdTotal !== null) entry.pending_rows = jsonPrdTotal
    const done = json?.value?.complete === true || json?.value?.data?.complete === true || COMPLETE_LINE.test(text)
    const snapshot = continuationSnapshot(key, now, done)
    entry.last_ms = now
    if (snapshot.action === 'none') return text
    if (json && json.value && typeof json.value === 'object' && !Array.isArray(json.value)) return JSON.stringify({ ...json.value, continuation: snapshot })
    if (json) return text
    const body = textBeforeTrailingBlock(text)
    const block = yaml.dump({ continuation: snapshot }, { lineWidth: 100 })
    const separator = body === '' || body.endsWith('\n') ? '' : '\n'
    return `${body}${separator}${block}`
}

export function continuationReserveFor(key) {
    const entry = entryFor(key)
    return entry.stopped || entry.pending_rows !== null ? CONTINUATION_RESERVE_CHARS : 0
}

export function continuedReplyWithin(key, text, cap, cut, now = Date.now()) {
    if (typeof text !== 'string') return text
    const continued = continuedReply(key, text, now)
    if (continued.length <= cap) return continued
    if (continued === text) return cut(text, cap)
    const body = textBeforeTrailingBlock(text)
    if (!continued.startsWith(body)) return continuedReply(key, cut(text, cap - CONTINUATION_RESERVE_CHARS), now)
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

export function startContinuationMonitor(emit) {
    const threshold = idleNotifyMs()
    const tick = Math.max(1000, Math.min(MONITOR_TICK_MS, threshold))
    const timer = setInterval(() => {
        const now = Date.now()
        for (const [key, entry] of entries) {
            if (entry.stopped || entry.pending_rows === null || entry.pending_rows === 0) continue
            if (now - entry.last_ms < threshold || entry.notified_for === entry.last_ms) continue
            entry.notified_for = entry.last_ms
            emit({ level: 'warning', logger: CONTINUATION_LOGGER, data: continuationSnapshot(key, now) })
        }
    }, tick)
    timer.unref?.()
    return timer
}

export { RELAY_KEY }
