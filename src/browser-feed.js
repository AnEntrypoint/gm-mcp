import fs from 'node:fs'
import path from 'node:path'
import { VERB_TABLE, runnerVerb } from './verb-table.js'

// Live browser feed for MCP clients. The guest's browser-events start (agentplug browser_events.mjs) appends one JSON line per
// browser event to <cwd>/.gm/browser-events/<session>.jsonl, each with a seq that only grows. A call that starts the feed
// attaches a watcher here; the watcher tails the file and pushes each new line as notifications/message (logger "browser"),
// and notifications/resources/updated for gm://browser/events/<session> when the client subscribed to that URI.

const POLL_MS = 500
const LIFETIME_MS = 65 * 60 * 1000
const READ_CAP_BYTES = 256 * 1024
const feeds = new Map()
const subscribed = new Set()

export const FEED_URI_PREFIX = 'gm://browser/events/'
export const API_DOCS_URI = 'gm://browser/api'

export function feedSpoolPath(cwd, session) {
    return path.join(cwd, '.gm', 'browser-events', `${session}.jsonl`)
}

export function feedUri(session) {
    return `${FEED_URI_PREFIX}${encodeURIComponent(session)}`
}

const LEVEL_OF_CONSOLE = { error: 'error', assert: 'error', warning: 'warning', warn: 'warning', info: 'info', log: 'info', debug: 'debug', trace: 'debug' }

export function levelOf(event) {
    if (event.kind === 'exception') return 'error'
    if (event.kind === 'network') return event.phase === 'failed' || (typeof event.status === 'number' && event.status >= 400) ? 'warning' : 'debug'
    if (event.kind === 'console' || event.kind === 'log') return LEVEL_OF_CONSOLE[event.type] ?? 'info'
    return 'info'
}

function pumpOnce(state) {
    if (Date.now() > state.deadline) return stopFeedWatch(state.cwd, state.session)
    let size
    try {
        size = fs.statSync(state.file).size
    } catch {
        return
    }
    if (size < state.offset) {
        state.offset = 0
        state.partial = ''
    }
    if (size === state.offset) return
    const length = size - state.offset
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(state.file, 'r')
    try {
        fs.readSync(fd, buffer, 0, length, state.offset)
    } finally {
        fs.closeSync(fd)
    }
    state.offset = size
    const lines = (state.partial + buffer.toString('utf8')).split('\n')
    state.partial = lines.pop() ?? ''
    let pushed = false
    for (const line of lines) {
        if (!line.trim()) continue
        let event
        try {
            event = JSON.parse(line)
        } catch {
            continue
        }
        if (!Number.isInteger(event.seq) || event.seq <= state.lastSeq) continue
        state.lastSeq = event.seq
        pushed = true
        state.notify({ method: 'notifications/message', params: { level: levelOf(event), logger: 'browser', data: { session: state.session, ...event } } })
    }
    if (pushed && subscribed.has(feedUri(state.session))) {
        state.notify({ method: 'notifications/resources/updated', params: { uri: feedUri(state.session) } })
    }
}

export function startFeedWatch({ cwd, session, notify }) {
    if (typeof notify !== 'function' || !cwd || !session) return false
    stopFeedWatch(cwd, session)
    const file = feedSpoolPath(cwd, session)
    let offset = 0
    try {
        offset = fs.statSync(file).size
    } catch {}
    const state = { cwd, session, file, notify, offset, partial: '', lastSeq: 0, deadline: Date.now() + LIFETIME_MS, timer: null }
    state.timer = setInterval(() => {
        try {
            pumpOnce(state)
        } catch {}
    }, POLL_MS)
    state.timer.unref?.()
    feeds.set(`${cwd}\0${session}`, state)
    return true
}

export function stopFeedWatch(cwd, session) {
    const key = `${cwd}\0${session}`
    const state = feeds.get(key)
    if (!state) return false
    clearInterval(state.timer)
    feeds.delete(key)
    return true
}

export function subscribeFeed(uri) {
    subscribed.add(uri)
}

export function unsubscribeFeed(uri) {
    subscribed.delete(uri)
}

export function isSubscribed(uri) {
    return subscribed.has(uri)
}

// The newest spool for a session across the projects this server has watched, or the newest on disk when none is watched.
export function readFeedText(session) {
    const watched = [...feeds.values()].filter((state) => state.session === session).sort((a, b) => b.deadline - a.deadline)[0]
    const file = watched ? watched.file : null
    if (!file) return `no browser feed named ${session} is attached to this server; start it with gm.browser_events({action: "start", session: "${session}"}, {cwd: "<project root>"})`
    let text
    try {
        const size = fs.statSync(file).size
        const start = Math.max(0, size - READ_CAP_BYTES)
        const buffer = Buffer.alloc(size - start)
        const fd = fs.openSync(file, 'r')
        try {
            fs.readSync(fd, buffer, 0, buffer.length, start)
        } finally {
            fs.closeSync(fd)
        }
        text = buffer.toString('utf8')
        if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    } catch (error) {
        return `browser feed ${session} is not readable: ${error.message}`
    }
    return text
}

// Called after a gm call that may start or stop the live feed, or that saves screenshots. Returns the image content blocks
// (row 31) for screenshots the call wrote. Never throws: a failed attach or read leaves the reply as it was.
export function browserAfterCall(context, text, notify) {
    try {
        if (context.kind === 'events') {
            const ok = !/^ok: false$/m.test(text) && !/"ok"\s*:\s*false/.test(text)
            if (ok && context.action === 'start') startFeedWatch({ cwd: context.cwd, session: context.session, notify })
            if (context.action === 'stop') stopFeedWatch(context.cwd, context.session)
            return []
        }
        if (context.kind === 'shots') return context.paths.flatMap((file) => imageBlockOf(path.resolve(context.cwd, file)))
    } catch {}
    return []
}

// Screenshot targets named by a browser request body: screenshot=<path>, screenshot_full=<path>, screenshot_uid=<uid> <path>.
export function screenshotPathsOf(raw) {
    const out = []
    for (const line of String(raw ?? '').split(/\r?\n/)) {
        const m = /^\s*screenshot(?:_full)?=(.+?)\s*$/.exec(line) ?? /^\s*screenshot_uid=\S+\s+(.+?)\s*$/.exec(line)
        if (m && /\.(?:png|jpe?g|webp)$/i.test(m[1])) out.push(m[1])
    }
    return out
}

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024

function imageBlockOf(file) {
    const mimeType = IMAGE_MIME[path.extname(file).toLowerCase()]
    if (!mimeType || !fs.existsSync(file)) return []
    if (fs.statSync(file).size > INLINE_IMAGE_MAX_BYTES) return []
    return [{ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType }]
}

// Markdown for the browser verbs, generated from the verb table so the resource cannot drift from the tools the server registers.
export function browserApiDocs() {
    const rows = VERB_TABLE.filter((row) => /^(browser|chrome|session_|recorder_)/.test(row.canonical))
    const out = ['# gm browser verbs', '', 'Each verb is a function on gm in gm_codemode, for example gm.session_list(). The browser verb and chrome take a plain text body (raw_body).', '']
    for (const row of rows) {
        const verb = runnerVerb(row)
        out.push(`## ${verb}`, '', row.description || '(no description)', '')
        const fields = row.body?.fields ?? {}
        const required = new Set(row.body?.required ?? [])
        for (const [name, field] of Object.entries(fields)) {
            const enumText = Array.isArray(field.enum) ? ` one of ${field.enum.join(', ')}` : ''
            out.push(`- \`${name}\` (${field.type}${required.has(name) ? ', required' : ', optional'})${enumText}: ${field.description ?? ''}`)
        }
        if (Object.keys(fields).length) out.push('')
    }
    return out.join('\n')
}
