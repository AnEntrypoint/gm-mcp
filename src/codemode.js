import { z } from 'zod'
import { appendDiagnostic, describeError } from './server-log.js'
import { canonicalToolName, nearestNames } from './verbs.js'
import { verbBodySchema } from './verb-bodies.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const CODEMODE_DESCRIPTION = 'Run an async JavaScript body in which every gm tool is a function on `gm`: `await gm.codesearch({query: "createWorkerRenderer", mode: "literal"})`. Arguments go in that one object: `gm.<verb>(args)` is the same dispatch as `gm.gm({verb, body: args})`, so every key the verb reads from its body (query, path, id, message, code, ...) is passed flat and folded into the body for you, while the dispatch envelope (session_id, cwd, body, raw_body, timeout_seconds, max_chars, full_response, resume_task) stays at the top level. Each call returns that tool\'s text reply and throws when the tool fails. `return gm.list()` returns every callable name as {name, verb, description}; `return gm.describe(name)` returns a tool\'s JSON input schema plus the spool verb body schema, and accepts either spelling of a name (`prd-add` and `prd_add` both resolve). Values returned by the body and console.log output are returned as text. Code runs in the gm-mcp server process with the same authority as exec_js.'

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

// A verb tool's top-level schema is the dispatch envelope (body, raw_body, session_id, cwd, ...)
// plus that verb's own top-level aliases. Anything else the caller names is a verb body field, and
// zod strips unknown keys, so it has to move into `body` before validation or it never reaches the
// verb: gm.codesearch({query:'x'}) is the same dispatch as gm.gm({verb:'codesearch', body:{query:'x'}}).
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
    if (extra === null) return args
    if (typeof envelope.raw_body === 'string') return envelope
    const named = envelope.body
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
        list: () => [...tools].map(([name, tool]) => ({ name, verb: tool.verb ?? null, description: tool.description })),
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

function formatValue(value) {
    if (value === undefined) return ''
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
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
            },
        },
        async (args = {}, extra) => {
            const logs = []
            const logger = { log: (...parts) => logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) }
            const session_id = args.session_id || `mcp-codemode-${process.pid}-${Date.now()}`
            try {
                const gm = bindings(tools, { session_id, cwd: args.cwd }, extra)
                const value = await new AsyncFunction('gm', 'console', args.code)(gm, logger)
                const text = [...logs, formatValue(value)].filter((line) => line !== '').join('\n')
                return { content: [{ type: 'text', text }] }
            } catch (error) {
                const detail = describeError(error)
                appendDiagnostic('codemode-threw', { error: detail })
                const text = [...logs, `gm-mcp: gm_codemode code threw -- ${detail}`].join('\n')
                return { content: [{ type: 'text', text }], isError: true }
            }
        }
    )
}
