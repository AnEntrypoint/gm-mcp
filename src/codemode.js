import { isPlainObject } from './plain-object.js';
import { z } from 'zod'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'
import { canonicalToolName, nearestNames } from './verbs.js'
import { FS_READ_RANGE_ALIASES, tableRow, verbDescriptionLead } from './verb-table.js'

const DISPATCH_ENVELOPE_NAME = 'dispatch_envelope'
import { DISPATCH_BODY_FIELDS, GUEST_ENVELOPE_FIELDS, verbBodySchema } from './verb-bodies.js'
import { fsReadRangeCanonicalBody } from './dispatch.js'
import { NOTICES } from './notices.js'
import { CONTINUATION_RESERVE_CHARS, continuedReply } from './continuation.js'
import { DEFAULT_CODEMODE_TIMEOUT_MS } from './codemode-budget.js'

const PROCESS_CODEMODE_SESSION_ID = `mcp-codemode-${process.pid}-${Date.now()}`
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function codemodeTimeoutMs() {
    const configured = Number(process.env.GM_CODEMODE_TIMEOUT_MS)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CODEMODE_TIMEOUT_MS
}

function withCodemodeDeadline(pending, timeoutMs) {
    let timer
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`gm_codemode code did not finish within ${timeoutMs} ms. A gm call it awaited never returned, or a loop of calls outlived the budget. Calls already dispatched keep running in the spool: resume one with resume_task, bound the loop, or raise GM_CODEMODE_TIMEOUT_MS.`)), timeoutMs)
    })
    return Promise.race([pending, deadline]).finally(() => clearTimeout(timer))
}

const CODEMODE_DESCRIPTION = 'Run an async JavaScript body in which every gm tool is a function on `gm`: `await gm.codesearch({query: "createWorkerRenderer", mode: "literal"})`. Arguments go in that one object: `gm.<verb>(args)` is the same dispatch as `gm.gm({verb, body: args})`, so every key the verb reads from its body (query, path, id, message, code, ...) is passed flat and folded into the body for you, while the dispatch envelope (session_id, cwd, body, raw_body, timeout_seconds, max_chars, full_response, resume_task) stays at the top level. A second object argument is folded into the first, so gm.<verb>({...}, {cwd: "<root>", max_chars: 800}) is the same call; a second argument that is not an object is refused rather than dropped, because a dropped cwd silently runs the dispatch against another project. A top-level `body` is the dispatch body only when it is an object or JSON object text; any other text is row prose, sent as the verb\'s own `body` field when it declares one and as `description` otherwise, so gm.prd_add({id, subject, body}) reaches prd-add as body:{id, subject, description} (an explicit description wins). Each call returns that tool\'s reply as a plain text string, never a parsed object, so a read such as `r.data.matches` is undefined; parse the text or match it instead (for example `r.includes("needle")`). Each call throws when the tool fails.`return gm.list()` returns one entry per verb as {name, aliases?, description?}: the description is the verb text cut to 80 chars, without the boilerplate every runner verb shares, and it is omitted when the verb has none; `gm.describe(name)` gives the runner spelling of the verb, its input schema and its body schema. `gm.list({filter, names_only, max_desc})` narrows it (max_desc 0 gives full descriptions). `gm.help()` returns the notice codes that replies carry. The reply is capped at max_chars (default 24000). `return gm.describe(name)` returns a tool\'s JSON input schema plus the spool verb body schema, and accepts either spelling of a name (`prd-add` and `prd_add` both resolve). If the body returns nothing, the text of every gm call reply is returned in call order, so a git_commit or git_push without a return still reports its result. Values returned by the body and console.log output are returned as text: a string is returned as-is, anything structured as JSON, and what JSON cannot render (a function, a symbol, a BigInt, a cycle) as text -- `[Function f]`, `42n`, `[Circular]` -- instead of being dropped or throwing. Code runs in the gm-mcp server process with the same authority as exec_js.'

function dispatchIdOf(text) {
    return /^dispatch_id: (\S+)/m.exec(text)?.[1] ?? null
}

let codemodeThrowSeq = 0

const CONTINUATION_TAIL = /\s+(?:state:\s*\S+\s+)?(?:continuation:|pending_rows:|idle_ms:|action:).*$/

function withoutContinuation(text) {
    return text.replace(/^continuation:[\s\S]*$/m, '').trimEnd()
}

function stdoutErrorOf(text) {
    const data = text.split(/^--- data/m)[1] ?? ''
    const stdout = (/^\s*stdout: '(.*)'$/m.exec(text)?.[1] ?? '').replace(/\\"/g, '"')
    const quoted = /"error"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(`${data}\n${stdout}`)?.[1]
    if (quoted === undefined) return ''
    try { return JSON.parse(quoted).replace(/\s+/g, ' ').trim() } catch { return '' }
}

function failedReplyDetail(text, verb) {
    if (!/^(dispatch_id|data|error|ok|gm_session_header_version):/.test(text)) return null
    const header = text.split(/^--- data/m)[0]
    if (!/^ok: false$/m.test(header)) return null
    const lines = header.split('\n')
    const start = lines.findIndex((line) => line.startsWith('error:'))
    const block = (start === -1 ? '' : lines.slice(start).filter((line, index) => index === 0 || /^\s/.test(line)).join(' ').replace(/\s+/g, ' ').trim()).replace(CONTINUATION_TAIL, '')
    const code = /^error_code: (.*)$/m.exec(header)?.[1]
    const dispatchId = dispatchIdOf(text)
    const head = header.split('\n').slice(0, 8).join(' | ').replace(/\s+/g, ' ').trim()
    const stdoutError = stdoutErrorOf(text)
    return `verb=${verb} error_code=${code ?? 'none'} dispatch_id=${dispatchId ?? 'none'}\n${block || stdoutError || `no error field; reply head: ${head}`}`
}

function compactFailureDetail(text, verb) {
    const match = /^\S+ ok: false \(error_code: ([^)]*)\)(?: dispatch_id: (\S+))?(?: -- error: ([\s\S]*))?$/.exec(text.trim())
    if (match === null) return null
    const [, code, dispatchId, error] = match
    const detail = (error ?? '').replace(/\s+/g, ' ').trim().replace(CONTINUATION_TAIL, '')
    return `verb=${verb} error_code=${code} dispatch_id=${dispatchId ?? 'none'}\n${detail || `no error field; reply head: ${text.trim().split('\n')[0]}`}`
}

function replyText(result, verb) {
    const text = (result?.content ?? []).map((part) => part.text ?? '').join('\n')
    if (result?.isError) throw new Error(text)
    const failed = failedReplyDetail(text, verb) ?? compactFailureDetail(text, verb)
    if (failed !== null) throw new Error(failed)
    return text
}

function refuseUnknownKeys(name, tool, args) {
    const declared = new Set(Object.keys(tool.inputSchema ?? {}))
    const unknown = Object.keys(args ?? {}).filter((key) => !declared.has(key))
    if (unknown.length === 0) return
    throw new Error(`${name} arguments invalid -- unknown key ${unknown.join(', ')}; declared keys: ${[...declared].join(', ')}`)
}

function validatedArgs(name, tool, args) {
    refuseUnknownKeys(name, tool, args)
    const parsed = z.object(tool.inputSchema).safeParse(args ?? {})
    if (parsed.success) return parsed.data
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
    throw new Error(`${name} arguments invalid -- ${problems}`)
}

function unknownNameError(name, names) {
    const nearest = nearestNames(name, names)
    return new Error(`no gm tool named ${name} -- nearest callable names: ${nearest.join(', ')}. Call gm.list() for every callable name.`)
}

const JSON_OBJECT_TEXT = /^\s*\{/

function proseFieldFor(verb) {
    const schema = verbBodySchema(verb)
    if (!schema.declared || 'body' in schema.fields) return 'body'
    return 'description' in schema.fields ? 'description' : 'body'
}

function canonicalFsReadArgs(verb, folded) {
    if (verb !== 'fs_read' || !isPlainObject(folded?.body)) return folded
    return { ...folded, body: fsReadRangeCanonicalBody(verb, folded.body) }
}

export function foldVerbArgs(tool, args) {
    if (!tool?.verb) return args
    if (!isPlainObject(args)) return args
    const verbAliases = new Set(tableRow(tool.verb)?.aliases ?? [])
    const topLevel = new Set(Object.keys(tool.inputSchema ?? {}).filter((key) => !verbAliases.has(key)))
    const envelope = {}
    let extra = null
    for (const [key, value] of Object.entries(args)) {
        if (topLevel.has(key)) {
            envelope[key] = value
            continue
        }
        if (extra === null) extra = {}
        extra[key] = value
    }
    if (typeof envelope.raw_body === 'string') return envelope
    const named = envelope.body
    if (typeof named === 'string' && !JSON_OBJECT_TEXT.test(named)) {
        const proseField = proseFieldFor(tool.verb)
        const prose = extra?.[proseField] !== undefined ? [extra[proseField], named].join('\n\n') : named
        return { ...envelope, body: { ...extra, [proseField]: prose } }
    }
    if (extra === null) return args
    if (named === undefined) return { ...envelope, body: extra }
    let body = named
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body)
        } catch {
            return envelope
        }
    }
    if (!isPlainObject(body)) return envelope
    return { ...envelope, body: { ...extra, ...body } }
}

export function refuseUndeclaredBodyKeys(name, verb, folded) {
    if (!verb || !folded || typeof folded !== 'object') return
    const body = folded.body
    if (!isPlainObject(body)) return
    const schema = verbBodySchema(verb)
    if (!schema.declared) return
    const known = new Set([...Object.keys(schema.fields), ...Object.keys(DISPATCH_BODY_FIELDS), ...GUEST_ENVELOPE_FIELDS, ...(tableRow(verb)?.aliases ?? [])])
    for (const spec of Object.values(schema.fields)) for (const alias of spec.aliases ?? []) known.add(alias)
    if (verb === 'fs_read') for (const alias of FS_READ_RANGE_ALIASES) known.add(alias)
    const unknown = Object.keys(body).filter((key) => !known.has(key))
    if (unknown.length === 0) return
    throw new Error(`${name} body has undeclared key ${unknown.join(', ')} -- declared body fields: ${[...known].join(', ')}`)
}

export function refuseMissingRequiredBodyKeys(name, verb, folded) {
    if (!verb || !folded || typeof folded !== 'object') return
    const schema = verbBodySchema(verb)
    if (!schema.declared) return
    const body = isPlainObject(folded.body) ? folded.body : {}
    const claimOnly = verb === 'git_commit' && [true, 'true'].includes(body.claim_only)
    const missing = schema.required.filter((field) => {
        if (field === 'session_id') return false
        if (claimOnly && field === 'message') return false
        if (body[field] !== undefined) return false
        return !(schema.fields[field]?.aliases ?? []).some((alias) => body[alias] !== undefined)
    })
    if (missing.length === 0) return
    throw new Error(`${name} body field ${missing.join(', ')} required -- send ${missing.map((field) => `body.${field}`).join(', ')}`)
}

const DEFAULT_LIST_DESC_CHARS = 80
const DEFAULT_CODEMODE_MAX_CHARS = 24000

function canonicalCatalog(tools) {
    const namesByVerb = new Map()
    for (const [name, tool] of tools) {
        if (!tool.verb) continue
        if (!namesByVerb.has(tool.verb)) namesByVerb.set(tool.verb, [])
        namesByVerb.get(tool.verb).push(name)
    }
    const rows = []
    for (const [name, tool] of tools) {
        if (!tool.verb) {
            rows.push({ name, verb: null, description: tool.description ?? '' })
            continue
        }
        const names = namesByVerb.get(tool.verb)
        const preferred = canonicalToolName(tool.verb)
        const canonical = names.includes(preferred) ? preferred : names[0]
        if (name !== canonical) continue
        const aliases = names.filter((other) => other !== canonical)
        rows.push({ name, verb: tool.verb, ...(aliases.length > 0 ? { aliases } : {}), description: tool.description ?? '' })
    }
    return rows
}

function nonNegativeNumber(value, fallback) {
    const parsed = Number(value)
    return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

function clipDescription(text, max) {
    if (max === 0 || text.length <= max) return text
    return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

function listEntries(tools, options) {
    const opts = isPlainObject(options) ? options : {}
    const maxDesc = nonNegativeNumber(opts.max_desc, DEFAULT_LIST_DESC_CHARS)
    const needle = typeof opts.filter === 'string' && opts.filter.trim() !== '' ? opts.filter.trim().toLowerCase() : null
    let rows = canonicalCatalog(tools)
    if (needle) {
        rows = rows.filter((row) => [row.name, row.verb, row.description, ...(row.aliases ?? [])]
            .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle)))
    }
    if (opts.names_only === true || opts.names_only === 'true') return rows.map((row) => row.name)
    return rows.map((row) => {
        const description = listSummary(row, maxDesc)
        return {
            name: row.name,
            ...(row.aliases ? { aliases: row.aliases } : {}),
            ...(description !== '' || maxDesc === 0 ? { description } : {}),
        }
    })
}

function listSummary(row, maxDesc) {
    if (maxDesc === 0) return row.description
    const lead = row.verb === null ? '' : verbDescriptionLead(row.verb)
    const own = row.description.startsWith(lead) ? row.description.slice(lead.length).trimStart() : row.description
    return clipDescription(own, maxDesc)
}

function capCodemodeText(text, cap, reserve = 0) {
    const room = Math.max(1, cap - reserve)
    if (text.length <= room) return text
    const notice = `\nreply_truncated: true\nreply_chars: ${text.length}\nreply_max_chars: ${cap}\n`
    return `${text.slice(0, Math.max(0, room - notice.length))}${notice}`
}

const ENVELOPE_KEYS = ['timeout_seconds', 'full_response', 'resume_task']

function envelopeKeys(args) {
    return Object.fromEntries(ENVELOPE_KEYS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))
}

function bindings(tools, { session_id, cwd, ...topEnvelope }, extra, sink = null) {
    const names = [...tools.keys()]
    const resolve = (name) => {
        const key = String(name)
        if (tools.has(key)) return key
        const canonical = canonicalToolName(key)
        if (tools.has(canonical)) return canonical
        const hyphenated = key.replace(/_/g, '-')
        return tools.has(hyphenated) ? hyphenated : null
    }

    const defaultCwdFor = (merged, ambientCwd) => {
        const pinned = typeof merged.git_root_override === 'string' ? merged.git_root_override.trim() : ''
        return pinned !== '' ? pinned : ambientCwd
    }

    const mergeEnvelope = (name, args, envelope) => {
        if (envelope === undefined) return args
        if (!isPlainObject(envelope) || !isPlainObject(args)) {
            throw new Error(`${name} takes one object argument; a second argument must be an object of dispatch keys (cwd, max_chars, timeout_seconds, session_id, full_response, resume_task) and is folded into the first`)
        }
        return { ...args, ...envelope }
    }

    const call = (name, args = {}, envelope = undefined) => {
        const entry = sink ? { verb: tools.get(name)?.verb ?? name } : null
        if (entry) sink.push(entry)
        const fail = (error) => {
            if (entry) {
                entry.failed = true
                entry.error = describeError(error)
            }
            throw error
        }
        let pending
        try {
            const merged = mergeEnvelope(name, args, envelope)
            const tool = tools.get(name)
            const defaults = {}
            const folded = canonicalFsReadArgs(tool.verb, foldVerbArgs(tool, merged))
            refuseUndeclaredBodyKeys(name, tool.verb, folded)
            refuseMissingRequiredBodyKeys(name, tool.verb, folded)
            if ('session_id' in tool.inputSchema && folded.session_id === undefined) defaults.session_id = session_id
            if ('cwd' in tool.inputSchema && folded.cwd === undefined) {
                const defaultCwd = defaultCwdFor(merged, cwd)
                if (defaultCwd !== undefined) defaults.cwd = defaultCwd
            }
            for (const key of ENVELOPE_KEYS) {
                if (topEnvelope[key] !== undefined && folded[key] === undefined && key in tool.inputSchema) defaults[key] = topEnvelope[key]
            }
            pending = tool.handler(validatedArgs(name, tool, { ...defaults, ...folded }), extra).then((result) => replyText(result, tool.verb ?? name))
        } catch (error) {
            fail(error)
        }
        if (!entry) return pending
        return pending.then((text) => { entry.text = text; entry.dispatch_id = dispatchIdOf(text); return text }, fail)
    }
    let envelopeCache
    const dispatchEnvelopeSchema = () => {
        if (envelopeCache !== undefined) return envelopeCache
        const counts = new Map()
        for (const tool of tools.values()) {
            const key = JSON.stringify(z.toJSONSchema(z.object(tool.inputSchema)))
            counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        let shared = null
        let sharedCount = -1
        for (const [key, count] of counts) if (count > sharedCount) { shared = key; sharedCount = count }
        envelopeCache = JSON.parse(shared ?? 'null')
        return envelopeCache
    }
    const api = {
        list: (options) => listEntries(tools, options),
        help: () => ({ notices: NOTICES, list_options: { filter: 'substring of name, verb, alias or description', names_only: 'true returns names only', max_desc: `description chars (default ${DEFAULT_LIST_DESC_CHARS}, 0 = full)` }, codemode_max_chars: `reply cap (default ${DEFAULT_CODEMODE_MAX_CHARS})`, [DISPATCH_ENVELOPE_NAME]: dispatchEnvelopeSchema() }),
        describe: (name) => {
            const resolved = resolve(name)
            if (!resolved) throw unknownNameError(name, names)
            const tool = tools.get(resolved)
            const schema = verbBodySchema(tool.verb)
            const row = tableRow(tool.verb ?? resolved)
            const envelope = dispatchEnvelopeSchema()
            const ownSchema = z.toJSONSchema(z.object(tool.inputSchema))
            const sameAsEnvelope = JSON.stringify(ownSchema) === JSON.stringify(envelope)
            return {
                name: resolved,
                verb: tool.verb ?? null,
                summary: row?.description?.trim() || null,
                docs: `skills/gm/docs/verbs.md: search for \`${tool.verb ?? resolved}\``,
                input_schema: sameAsEnvelope ? { shared: DISPATCH_ENVELOPE_NAME, resolved: envelope } : ownSchema,
                body_schema: schema.declared
                    ? { declared: true, required: schema.required, fields: schema.fields }
                    : { declared: false, note: schema.note },
            }
        },
    }
    return new Proxy(api, {
        get(target, property) {
            if (typeof property !== 'string') return target[property]
            if (property in target) return target[property]
            const resolved = resolve(property)
            if (resolved) return (args, envelope) => call(resolved, args, envelope)
            throw unknownNameError(property, names)
        },
        has(target, property) {
            return typeof property === 'string' && (property in target || resolve(property) !== null)
        },
    })
}

function jsonText(value) {
    const parents = new WeakMap()
    const replacer = function (key, v) {
        if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
        if (typeof v === 'symbol') return String(v)
        if (typeof v === 'bigint') return `${v}n`
        if (v !== null && typeof v === 'object') {
            for (let up = this; up; up = parents.get(up)) if (up === v) return '[Circular]'
            parents.set(v, this)
        }
        return v
    }
    let text
    try {
        text = JSON.stringify(value, replacer)
    } catch {
        return textOf(value)
    }
    return text === undefined ? textOf(value) : text
}

function textOf(value) {
    try {
        return String(value)
    } catch {
        return Object.prototype.toString.call(value)
    }
}

function formatValue(value) {
    if (value === undefined) return ''
    return typeof value === 'string' ? value : jsonText(value)
}

export function registerCodeMode(server, tools) {
    server.registerTool(
        'gm_codemode',
        {
            description: CODEMODE_DESCRIPTION,
            inputSchema: {
                code: z.string().describe('Async JavaScript body. Call gm tools as gm.<name>({...}) -- the object you pass is the verb body, so gm.codesearch({query:"x"}) == gm.gm({verb:"codesearch", body:{query:"x"}}); discover them with gm.list() and gm.describe(name).'),
                session_id: z.string().optional().describe('Default session_id for every gm call that does not pass its own.'),
                cwd: z.string().optional().describe('Default cwd for every gm call that does not pass its own.'),
                max_chars: z.number().optional().describe('Reply cap in characters for the returned text (default 24000). Past it the text is cut and reply_truncated is true.'),
                timeout_seconds: z.number().optional().describe('Dispatch envelope key folded into every gm call that declares it (poll budget in seconds).'),
                full_response: z.boolean().optional().describe('Dispatch envelope key folded into every gm call that declares it (bypass reply compaction).'),
                resume_task: z.string().optional().describe('Dispatch envelope key folded into every gm call that declares it (resume an earlier dispatch by task id).'),
            },
        },
        async (args = {}, extra) => {
            const logs = []
            const logger = { log: (...parts) => logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) }
            const session_id = args.session_id || PROCESS_CODEMODE_SESSION_ID
            const replies = []
            const cap = nonNegativeNumber(args.max_chars, DEFAULT_CODEMODE_MAX_CHARS) || DEFAULT_CODEMODE_MAX_CHARS
            try {
                const gm = bindings(tools, { session_id, cwd: args.cwd, ...envelopeKeys(args) }, extra, replies)
                const require = createRequire(resolvePath(args.cwd || process.cwd(), 'gm-codemode.js'))
                const value = await withCodemodeDeadline(new AsyncFunction('gm', 'console', 'require', args.code)(gm, logger, require), codemodeTimeoutMs())
                const unreturned = value === undefined
                    ? replies.filter((entry) => entry.text !== undefined).map((entry) => `--- gm.${entry.verb} (body returned nothing, so each gm reply follows) ---\n${capCodemodeText(entry.text, cap)}`)
                    : []
                const joined = [...logs, formatValue(value), ...unreturned].filter((line) => line !== '').join('\n')
                return { content: [{ type: 'text', text: continuedReply(session_id, capCodemodeText(joined, cap, CONTINUATION_RESERVE_CHARS)) }] }
            } catch (error) {
                const detail = describeError(error)
                const diagnosticId = `codemode-${process.pid}-${Date.now()}-${++codemodeThrowSeq}`
                const callIds = replies.map((entry) => entry.dispatch_id).filter(Boolean)
                appendDiagnostic('codemode-threw', { diagnostic_id: diagnosticId, session_id, gm_dispatch_ids: callIds, error: detail })
                const settled = replies.filter((entry) => entry.text !== undefined)
                const partial = replies.map((entry, index) => {
                    const label = `${index + 1}/${replies.length}: gm.${entry.verb}`
                    if (entry.text !== undefined) return `--- partial ${label} completed before the throw (reply not replayed) dispatch_id: ${entry.dispatch_id ?? 'none'} ---`
                    if (entry.failed) return `--- partial ${label} failed ---\n${capCodemodeText(withoutContinuation(entry.error), cap)}`
                    return `--- partial ${label} still pending ---`
                })
                const failedCount = replies.filter((entry) => entry.failed).length
                const pendingCount = replies.length - settled.length - failedCount
                const unsettledNote = [pendingCount ? `${pendingCount} still pending` : '', failedCount ? `${failedCount} failed` : ''].filter(Boolean).join(', ')
                const tally = replies.length ? [`gm-mcp: ${settled.length} of ${replies.length} gm call(s) completed before the throw${unsettledNote ? `, ${unsettledNote}` : ''}; their dispatch ids and per-call errors follow`] : []
                const ids = callIds.length ? [`gm_dispatch_ids: ${callIds.join(', ')}`] : []
                const [headlineWithPrefix, ...detailLines] = withoutContinuation(detail).split('\n')
                const headline = headlineWithPrefix.replace(/^Error: /, '')
                const failingVerb = /^verb=\S+ error_code=/.test(headline) ? [headline] : []
                const wrapper = failingVerb.length ? [] : [`gm-mcp: gm_codemode code threw -- ${headline}`]
                const text = [...failingVerb, ...wrapper, `diagnostic_id: ${diagnosticId} (gm-mcp log key, not a spool dispatch id; search log for it)`, `log: ${logFilePath()}`, `session_id: ${session_id}`, ...logs, ...ids, ...tally, ...partial, ...detailLines].join('\n')
                return { content: [{ type: 'text', text: continuedReply(session_id, capCodemodeText(text, cap, CONTINUATION_RESERVE_CHARS)) }], isError: true }
            }
        }
    )
}
