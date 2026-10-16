import * as yaml from 'js-yaml'

export const CONTINUATION_STOP_VERB = 'continuation-stop'
export const CONTINUATION_LOGGER = 'gm.continuation'
const MAX_WORKERS = 4
export const CONTINUATION_RESERVE_CHARS = 256
const DEFAULT_IDLE_NOTIFY_MS = 300000
const MONITOR_TICK_MS = 15000
const RELAY_KEY = 'relay'
const PENDING_LINE = /^\s*prd_pending_count:\s*(\d+)\s*$/m
const CONTINUATION_HEADS = /^continuation:\s*$/gm

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

export function continuationSnapshot(key, now = Date.now()) {
    const entry = entryFor(key)
    const action = entry.stopped ? 'stop' : entry.pending_rows === null ? 'none' : entry.pending_rows === 0 ? 'stop' : 'continue'
    const snapshot = {
        state: entry.stopped ? 'stopped' : 'running',
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

export function continuedReply(key, text, now = Date.now()) {
    if (typeof text !== 'string') return text
    const entry = entryFor(key)
    const seen = PENDING_LINE.exec(text)
    if (seen) entry.pending_rows = Number(seen[1])
    const snapshot = continuationSnapshot(key, now)
    entry.last_ms = now
    const json = parsedJsonOf(text)
    if (json && json.value && typeof json.value === 'object' && !Array.isArray(json.value)) return JSON.stringify({ ...json.value, continuation: snapshot })
    if (json) return text
    const block = yaml.dump({ continuation: snapshot }, { lineWidth: 100 })
    const separator = text === '' || text.endsWith('\n') ? '' : '\n'
    return `${text}${separator}${block}`
}

export function continuationBlockOf(text) {
    const heads = [...String(text ?? '').matchAll(CONTINUATION_HEADS)]
    const last = heads.at(-1)
    if (!last) return null
    try {
        const doc = yaml.load(String(text).slice(last.index))
        return doc && typeof doc.continuation === 'object' ? doc.continuation : null
    } catch {
        return null
    }
}

export function observeRelayedReply(text) {
    const block = continuationBlockOf(text)
    if (!block) return null
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
