import fs from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { gmDispatch } from './dispatch.js'
import { COMPLETION_CHECKLIST } from './completion-checklist.js'
import { CHECKLIST_URI, CONTINUATION_URI, NEXT_PRD_URI, latestContinuationSnapshot } from './continuation.js'
import { liveStateText } from './live-state.js'
import { CWD_PROMPT_ARGS, registerArgsPrompt } from './prompt-args.js'
import { SERVER_SESSION_ID, failureOf, readPendingPage } from './prd-feed.js'
import { wireVerb } from './verb-table.js'
import { describeError } from './server-log.js'

// Read-only resources and the gm-completion prompt. Every verb here is a query verb in the gm verb inventory.

const JSON_MIME = 'application/json'
const PENDING_LIST_LIMIT = 50
const FULL_SHA = /^[0-9a-f]{40}$/

async function jsonRead(uri, produce) {
    let body
    try {
        body = await produce()
    } catch (error) {
        body = { ok: false, error: `read failed: ${describeError(error)}` }
    }
    return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(body, null, 2) }] }
}

// One read-only verb as {ok, verb, reply}, or {ok: false, verb, error}. Never throws.
export async function queryVerb(canonical, { body = {}, cwd } = {}) {
    const verb = wireVerb(canonical)
    let text
    try {
        text = await gmDispatch({ verb, body, cwd, session_id: SERVER_SESSION_ID })
    } catch (error) {
        return { ok: false, verb, error: `dispatch threw: ${describeError(error)}` }
    }
    let reply = null
    try {
        reply = yaml.load(String(text))
    } catch {
        reply = null
    }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return { ok: false, verb, error: 'reply is not a document', reply_text: String(text).slice(0, 2000) }
    const failure = failureOf(reply)
    if (failure !== null) return { ok: false, verb, error: failure, reply }
    return { ok: true, verb, reply }
}

// The project root a template names: URL-encoded, absolute, and an existing directory. Refusals carry the reason.
export function projectRootOf(raw) {
    let root
    try {
        root = decodeURIComponent(String(raw ?? ''))
    } catch {
        return { error: 'root is not valid percent-encoding' }
    }
    if (!path.isAbsolute(root)) return { error: 'root must be an absolute path, URL-encoded', root }
    let stat
    try {
        stat = fs.statSync(root)
    } catch {
        return { error: 'root does not exist', root }
    }
    if (!stat.isDirectory()) return { error: 'root is not a directory', root }
    return { root }
}

async function inProject(raw, read) {
    const found = projectRootOf(raw)
    if (found.error) return { ok: false, error: found.error, root: found.root ?? null }
    return { root: found.root, ...(await read(found.root)) }
}

async function nextRowText() {
    try {
        const page = await readPendingPage(gmDispatch, { limit: 1 })
        if (!page.ok) return `next pending row: unavailable (${page.error})`
        const row = page.items[0]
        return row ? `next pending row: ${row.id} (${row.status}): ${row.title}` : 'no pending rows'
    } catch (error) {
        return `next pending row: unavailable (${describeError(error)})`
    }
}

export function registerWorkflowSurface(server) {
    server.registerResource(
        'workflow-completion-checklist',
        CHECKLIST_URI,
        { title: 'gm completion checklist', description: 'The numbered completion checklist every gm turn follows. Static text.', mimeType: 'text/markdown' },
        async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: COMPLETION_CHECKLIST }] })
    )
    server.registerResource(
        'prd-next',
        NEXT_PRD_URI,
        { title: 'Next pending PRD row', description: 'The first pending PRD row ({id, status, title}), or {"next": null} when none. Read-only.', mimeType: JSON_MIME },
        (uri) => jsonRead(uri, async () => {
            const page = await readPendingPage(gmDispatch, { limit: 1 })
            if (!page.ok) return { ok: false, verb: 'prd-list', error: page.error }
            return page.items[0] ?? { next: null }
        })
    )
    server.registerResource(
        'prd-pending',
        'gm://prd/pending',
        { title: 'Pending PRD rows', description: `Up to ${PENDING_LIST_LIMIT} pending PRD rows, brief form. Read-only.`, mimeType: JSON_MIME },
        (uri) => jsonRead(uri, async () => {
            const page = await readPendingPage(gmDispatch, { limit: PENDING_LIST_LIMIT })
            if (!page.ok) return { ok: false, verb: 'prd-list', error: page.error }
            return { ok: true, verb: 'prd-list', pending_total: page.pending_total, count: page.items.length, items: page.items }
        })
    )
    server.registerResource(
        'continuation',
        CONTINUATION_URI,
        { title: 'Continuation state', description: 'The continuation snapshot of the most recently active session, plus the checklist URI.', mimeType: JSON_MIME },
        (uri) => jsonRead(uri, async () => ({
            ok: true,
            continuation: latestContinuationSnapshot() ?? { state: 'none', pending_rows: null, action: 'none' },
            checklist_uri: CHECKLIST_URI,
        }))
    )
    server.registerResource(
        'server-status',
        'gm://status',
        { title: 'gm status', description: 'The status verb for the default project root. A refused root answers ok: false with the reason.', mimeType: JSON_MIME },
        (uri) => jsonRead(uri, () => queryVerb('status'))
    )
    server.registerResource(
        'server-health',
        'gm://health',
        { title: 'gm health', description: 'The health verb.', mimeType: JSON_MIME },
        (uri) => jsonRead(uri, () => queryVerb('health'))
    )
    server.registerResource(
        'server-phase',
        'gm://phase',
        { title: 'gm phase', description: 'The phase_status verb: the current phase and its pending counts.', mimeType: JSON_MIME },
        (uri) => jsonRead(uri, () => queryVerb('phase_status'))
    )
    server.registerResource(
        'unknowns-open',
        'gm://unknowns/open',
        { title: 'Open unknowns', description: 'Unknown rows still open (status unknown), from the unknown_list verb.', mimeType: JSON_MIME },
        (uri) => jsonRead(uri, () => queryVerb('unknown_list', { body: { status: 'unknown' } }))
    )
    server.registerResource(
        'project-status',
        new ResourceTemplate('gm://project/{root}/status', { list: undefined }),
        { title: 'Project status', description: 'The status verb for the project whose URL-encoded absolute root is named.', mimeType: JSON_MIME },
        (uri, { root }) => jsonRead(uri, () => inProject(root, (dir) => queryVerb('status', { cwd: dir })))
    )
    server.registerResource(
        'project-git-status',
        new ResourceTemplate('gm://project/{root}/git/status', { list: undefined }),
        { title: 'Project git status', description: 'The git_status verb for the project whose URL-encoded absolute root is named.', mimeType: JSON_MIME },
        (uri, { root }) => jsonRead(uri, () => inProject(root, (dir) => queryVerb('git_status', { cwd: dir })))
    )
    server.registerResource(
        'project-ci-status',
        new ResourceTemplate('gm://project/{root}/ci/{sha}', { list: undefined }),
        { title: 'Project CI status', description: 'The ci_status verb for one full 40-character commit of the named project. Pending or failing is not passing.', mimeType: JSON_MIME },
        (uri, { root, sha }) => jsonRead(uri, () => inProject(root, (dir) => {
            const full = String(sha)
            if (!FULL_SHA.test(full)) return { ok: false, error: 'sha must be the full 40-character lowercase hex commit id', sha: full }
            return queryVerb('ci_status', { cwd: dir, body: { sha: full } })
        }))
    )
    registerArgsPrompt(
        server,
        'gm-completion',
        {
            title: 'gm completion checklist',
            description: 'The gm completion checklist, then the live state of the project named by cwd. Without cwd, the next pending PRD row as of the moment the prompt is fetched.',
            argsSchema: CWD_PROMPT_ARGS,
        },
        async ({ cwd } = {}) => {
            const messages = [{ role: 'user', content: { type: 'text', text: COMPLETION_CHECKLIST } }]
            // With cwd, the live block carries the next pending row, so the process-cwd row is not read.
            if (typeof cwd !== 'string' || cwd.trim() === '') messages.push({ role: 'user', content: { type: 'text', text: await nextRowText() } })
            messages.push({ role: 'user', content: { type: 'text', text: await liveStateText(gmDispatch, cwd) } })
            return { messages }
        }
    )
}
