// Gates the skill prompts and skill:// resources on the current gm FSM state. A skill's frontmatter key exposed_when
// lists tokens (space or comma separated); the skill is listed and readable when at least one token holds:
//   <state key>   the current state is that key, or the graph has an edge from the current state to it (one step ahead)
//   prd:pending   at least one PRD row is pending
//   always        always listed
// A skill without exposed_when is always listed. The current state is the status verb's phase (one dispatch); pending rows
// come from one prd-list read. When the state cannot be read every skill is listed and the reason is logged.
// Changes are pushed as notifications/prompts/list_changed and notifications/resources/list_changed, once per change.
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import { FSM_SUCCESSORS } from './skills-snapshot.js'
import { gmDispatch, lastProjectRoot } from './dispatch.js'
import { SERVER_SESSION_ID, readPendingPage, withinBudget } from './prd-feed.js'
import { appendDiagnostic, describeError } from './server-log.js'

export const GATE_POLL_MS = 3000
// A tick only stats the turn-state file and the PRD directory; a dispatch runs when either moved, or at this backstop.
const FULL_REFRESH_MS = 60000
// Reads run in the background and never hold a reply, so they get a longer budget than a live reply does: a status read queued behind a busy daemon still lands.
const GATE_BUDGET_MS = 10000
const ALWAYS = 'always'
const PRD_PENDING = 'prd:pending'

const controllers = new Set()
let timer = null
let inFlight = null
let lastRefreshAt = 0
let fingerprint = null
let explicitRoot = null
let lastLoggedReason = null

export function exposureTokensOf(meta) {
    const tokens = String(meta?.exposed_when ?? '').split(/[\s,[\]]+/).filter(Boolean)
    return tokens.length > 0 ? tokens : null
}

export function isExposed(tokens, ctx) {
    if (tokens === null || ctx.unknown) return true
    return tokens.some((token) => {
        if (token === ALWAYS) return true
        if (token === PRD_PENDING) return ctx.prdPending !== false
        return ctx.state === token || (FSM_SUCCESSORS[ctx.state] ?? []).includes(token)
    })
}

// The phase of a status reply, or null when the reply is a failure or carries no phase.
export function phaseOf(text) {
    let doc
    try {
        doc = yaml.load(String(text))
    } catch {
        return null
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
    const data = doc.data && typeof doc.data === 'object' ? doc.data : doc
    return typeof data.phase === 'string' && data.phase !== '' ? data.phase : null
}

function safeDispatch(body) {
    return Promise.resolve().then(() => gmDispatch(body))
}

function rootNow() {
    return explicitRoot ?? lastProjectRoot()
}

async function readContext(root) {
    if (!root || !path.isAbsolute(root)) return { unknown: true, reason: 'no absolute project root to read the state from' }
    const [status, page] = await Promise.all([
        withinBudget(safeDispatch({ verb: 'phase-status', body: {}, cwd: root, session_id: SERVER_SESSION_ID, prd_feed: true }), GATE_BUDGET_MS, null),
        withinBudget(readPendingPage(gmDispatch, { limit: 1, cwd: root }), GATE_BUDGET_MS, { ok: false }),
    ])
    const state = status === null ? null : phaseOf(status)
    if (state === null) {
        const detail = status === null ? 'phase-status did not answer in time' : `phase-status reply has no phase: ${String(status).replace(/\s+/g, ' ').slice(0, 160)}`
        return { unknown: true, reason: `${detail} (root ${root})` }
    }
    return { unknown: false, state, prdPending: page.ok ? page.items.length > 0 : null }
}

function fullKey(records) {
    return records.map((record) => record.name).join('\n')
}

function visibleKey(records, ctx) {
    return records.filter((record) => isExposed(record.tokens, ctx)).map((record) => record.name).join('\n')
}

function applyTo(controller, ctx) {
    for (const record of controller.records) {
        const on = isExposed(record.tokens, ctx)
        const message = on ? undefined : `Prompt ${record.name} is not a valid next step right now: the current gm state is ${ctx.state}. The gm_skill verb still reads it.`
        if (record.prompt) {
            record.prompt.enabled = on
            record.prompt.disabledMessage = message
        }
        for (const resource of record.resources) resource.enabled = on
    }
    const key = visibleKey(controller.records, ctx)
    if (key === controller.applied) return
    controller.applied = key
    if (!controller.server.isConnected()) return
    controller.server.server.sendPromptListChanged().catch((error) => appendDiagnostic('skill-gate-notify-failed', { error: describeError(error) }))
    controller.server.server.sendResourceListChanged().catch((error) => appendDiagnostic('skill-gate-notify-failed', { error: describeError(error) }))
}

function logReason(ctx) {
    const reason = ctx.unknown ? ctx.reason : null
    if (reason === lastLoggedReason) return
    lastLoggedReason = reason
    if (reason) appendDiagnostic('skill-gate-all-exposed', { reason })
}

function statKey(file) {
    try {
        const st = fs.statSync(file)
        return `${st.mtimeMs}:${st.size}`
    } catch {
        return '-'
    }
}

// Cheap change detector: the turn-state file and the PRD directory (and the legacy prd.yml). Row edits that keep the directory mtime are caught by the backstop.
function fingerprintOf(root) {
    const gm = path.join(root, '.gm')
    return [statKey(path.join(gm, 'turn-state.json')), statKey(path.join(gm, 'prd')), statKey(path.join(gm, 'prd.yml'))].join('|')
}

export function refreshSkillGate({ root } = {}) {
    if (inFlight) return inFlight
    fingerprint = fingerprintOf(root ?? rootNow() ?? '')
    inFlight = (async () => {
        const ctx = await readContext(root ?? rootNow())
        lastRefreshAt = Date.now()
        logReason(ctx)
        for (const controller of controllers) applyTo(controller, ctx)
    })()
        .catch((error) => appendDiagnostic('skill-gate-failed', { error: describeError(error) }))
        .finally(() => {
            inFlight = null
        })
    return inFlight
}

// Refreshes only when the fingerprint moved or the backstop is due, so a busy caller pays nothing for unchanged state.
function refreshIfChanged(root) {
    if (!root) return
    const now = fingerprintOf(root)
    if (now === fingerprint && Date.now() - lastRefreshAt < FULL_REFRESH_MS) return
    refreshSkillGate({ root })
}

// Called after each tool reply: remembers the cwd the caller named, and refreshes when its state changed.
export function kickSkillGate(cwd) {
    if (typeof cwd === 'string' && path.isAbsolute(cwd.trim())) explicitRoot = path.resolve(cwd.trim())
    refreshIfChanged(rootNow())
}

function anyConnected() {
    for (const controller of controllers) if (controller.server.isConnected()) return true
    return false
}

function ensureTimer() {
    if (timer) return
    timer = setInterval(() => {
        if (anyConnected()) refreshIfChanged(rootNow())
    }, GATE_POLL_MS)
    timer.unref?.()
}

function dropController(controller) {
    controllers.delete(controller)
    if (controllers.size === 0 && timer) {
        clearInterval(timer)
        timer = null
    }
}

// records: [{name, tokens, prompt, resources}] for one McpServer. The skill's prompt and resources are switched by enabled,
// which the SDK reads for prompts/list, resources/list and the get and read handlers.
export function attachSkillGate(server, records) {
    const controller = { server, records, applied: null }
    controller.applied = fullKey(records)
    controllers.add(controller)
    const previousOnClose = server.server.onclose
    server.server.onclose = (...args) => {
        dropController(controller)
        previousOnClose?.(...args)
    }
    ensureTimer()
    kickSkillGate()
    return controller
}
