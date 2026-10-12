import { z } from 'zod'
import { appendDiagnostic, describeError } from './server-log.js'
import { canonicalToolName, nearestNames } from './verbs.js'
import { verbBodySchema } from './verb-bodies.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const CODEMODE_DESCRIPTION = 'Run an async JavaScript body in which every gm tool is a function on `gm`: `await gm.codesearch({session_id, body: {...}})`. Each call returns that tool\'s text reply and throws when the tool fails. `return gm.list()` returns every callable name as {name, verb, description}; `return gm.describe(name)` returns a tool\'s JSON input schema plus the spool verb body schema, and accepts either spelling of a name (`prd-add` and `prd_add` both resolve). Values returned by the body and console.log output are returned as text. Code runs in the gm-mcp server process with the same authority as exec_js.'

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
        if ('session_id' in tool.inputSchema && args.session_id === undefined) defaults.session_id = session_id
        if ('cwd' in tool.inputSchema && args.cwd === undefined && cwd !== undefined) defaults.cwd = cwd
        return tool.handler(validatedArgs(name, tool, { ...defaults, ...args }), extra).then(replyText)
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
                code: z.string().describe('Async JavaScript body. Call gm tools as gm.<name>({...}); discover them with gm.list() and gm.describe(name).'),
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
