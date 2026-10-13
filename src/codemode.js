import { z } from 'zod'
import { appendDiagnostic, describeError } from './server-log.js'
import { canonicalToolName, nearestNames } from './verbs.js'
import { verbBodySchema } from './verb-bodies.js'
import { NOTICES } from './notices.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const CODEMODE_DESCRIPTION = 'Run an async JavaScript body in which every gm tool is a function on `gm`: `await gm.codesearch({query: "createWorkerRenderer", mode: "literal"})`. Arguments go in that one object: `gm.<verb>(args)` is the same dispatch as `gm.gm({verb, body: args})`, so every key the verb reads from its body (query, path, id, message, code, ...) is passed flat and folded into the body for you, while the dispatch envelope (session_id, cwd, body, raw_body, timeout_seconds, max_chars, full_response, resume_task) stays at the top level. A verb that names a field `body` of its own (the row prose of prd-add) follows the same rule: a top-level `body` is the dispatch body only when it is an object or JSON object text, so gm.prd_add({id, subject, body}) reaches the verb as body:{id, subject, body}. Each call returns that tool\'s text reply and throws when the tool fails. `return gm.list()` returns one entry per verb as {name, verb, aliases, description} (verb is omitted when it equals name, aliases when there are any), with the description cut to 80 chars; `gm.list({filter, names_only, max_desc})` narrows it. `gm.help()` returns the notice codes that replies carry. The reply is capped at max_chars (default 24000). `return gm.describe(name)` returns a tool\'s JSON input schema plus the spool verb body schema, and accepts either spelling of a name (`prd-add` and `prd_add` both resolve). Values returned by the body and console.log output are returned as text: a string is returned as-is, anything structured as JSON, and what JSON cannot render (a function, a symbol, a BigInt, a cycle) as text -- `[Function f]`, `42n`, `[Circular]` -- instead of being dropped or throwing. Code runs in the gm-mcp server process with the same authority as exec_js.'

function replyText(result) {
    const text = (result?.content ?? []).map((part) => part.text ?? '').join('\n')
    if (result?.isError) throw new Error(text)
    return text
}

function validatedArgs(name, tool, args) {
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

export function foldVerbArgs(tool, args) {
    if (!tool?.verb) return args
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args
    const topLevel = new Set(Object.keys(tool.inputSchema ?? {}))
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
        return { ...envelope, body: { ...extra, body: named } }
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) return envelope
    return { ...envelope, body: { ...extra, ...body } }
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
    const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
    const maxDesc = nonNegativeNumber(opts.max_desc, DEFAULT_LIST_DESC_CHARS)
    const needle = typeof opts.filter === 'string' && opts.filter.trim() !== '' ? opts.filter.trim().toLowerCase() : null
    let rows = canonicalCatalog(tools)
    if (needle) {
        rows = rows.filter((row) => [row.name, row.verb, row.description, ...(row.aliases ?? [])]
            .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle)))
    }
    if (opts.names_only === true || opts.names_only === 'true') return rows.map((row) => row.name)
    return rows.map((row) => ({
        name: row.name,
        ...(row.verb !== null && row.verb !== row.name ? { verb: row.verb } : {}),
        ...(row.aliases ? { aliases: row.aliases } : {}),
        description: clipDescription(row.description, maxDesc),
    }))
}

function capCodemodeText(text, cap) {
    if (text.length <= cap) return text
    const notice = `\nreply_truncated: true\nreply_chars: ${text.length}\nreply_max_chars: ${cap}\n`
    return `${text.slice(0, Math.max(0, cap - notice.length))}${notice}`
}

function bindings(tools, { session_id, cwd }, extra) {
    const names = [...tools.keys()]
    const resolve = (name) => {
        const key = String(name)
        if (tools.has(key)) return key
        const canonical = canonicalToolName(key)
        if (tools.has(canonical)) return canonical
        const hyphenated = key.replace(/_/g, '-')
        return tools.has(hyphenated) ? hyphenated : null
    }
    const call = (name, args = {}) => {
        const tool = tools.get(name)
        const defaults = {}
        const folded = foldVerbArgs(tool, args)
        if ('session_id' in tool.inputSchema && folded.session_id === undefined) defaults.session_id = session_id
        if ('cwd' in tool.inputSchema && folded.cwd === undefined && cwd !== undefined) defaults.cwd = cwd
        return tool.handler(validatedArgs(name, tool, { ...defaults, ...folded }), extra).then(replyText)
    }
    const api = {
        list: (options) => listEntries(tools, options),
        help: () => ({ notices: NOTICES, list_options: { filter: 'substring of name, verb, alias or description', names_only: 'true returns names only', max_desc: `description chars (default ${DEFAULT_LIST_DESC_CHARS}, 0 = full)` }, codemode_max_chars: `reply cap (default ${DEFAULT_CODEMODE_MAX_CHARS})` }),
        describe: (name) => {
            const resolved = resolve(name)
            if (!resolved) throw unknownNameError(name, names)
            const tool = tools.get(resolved)
            const schema = verbBodySchema(tool.verb)
            return {
                name: resolved,
                verb: tool.verb ?? null,
                input_schema: z.toJSONSchema(z.object(tool.inputSchema)),
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
            if (resolved) return (args) => call(resolved, args)
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
            },
        },
        async (args = {}, extra) => {
            const logs = []
            const logger = { log: (...parts) => logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) }
            const session_id = args.session_id || `mcp-codemode-${process.pid}-${Date.now()}`
            try {
                const gm = bindings(tools, { session_id, cwd: args.cwd }, extra)
                const value = await new AsyncFunction('gm', 'console', args.code)(gm, logger)
                const joined = [...logs, formatValue(value)].filter((line) => line !== '').join('\n')
                const cap = nonNegativeNumber(args.max_chars, DEFAULT_CODEMODE_MAX_CHARS) || DEFAULT_CODEMODE_MAX_CHARS
                return { content: [{ type: 'text', text: capCodemodeText(joined, cap) }] }
            } catch (error) {
                const detail = describeError(error)
                appendDiagnostic('codemode-threw', { error: detail })
                const text = [...logs, `gm-mcp: gm_codemode code threw -- ${detail}`].join('\n')
                return { content: [{ type: 'text', text }], isError: true }
            }
        }
    )
}
