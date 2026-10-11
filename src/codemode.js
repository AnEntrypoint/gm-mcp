import { z } from 'zod'
import { appendDiagnostic, describeError } from './server-log.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const CODEMODE_DESCRIPTION = 'Run an async JavaScript body in which every gm tool is a function on `gm`: `await gm.codesearch({session_id, body: {...}})`. Each call returns that tool\'s text reply and throws when the tool fails. `return gm.list()` lists every tool with its description; `return gm.describe(name)` returns a tool\'s JSON input schema. Values returned by the body and console.log output are returned as text. Code runs in the gm-mcp server process with the same authority as exec_js.'

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

function bindings(tools, { session_id, cwd }, extra) {
    const call = (name, args = {}) => {
        const tool = tools.get(name)
        const defaults = {}
        if ('session_id' in tool.inputSchema && args.session_id === undefined) defaults.session_id = session_id
        if ('cwd' in tool.inputSchema && args.cwd === undefined && cwd !== undefined) defaults.cwd = cwd
        return tool.handler(validatedArgs(name, tool, { ...defaults, ...args }), extra).then(replyText)
    }
    const gm = {
        list: () => [...tools].map(([name, tool]) => ({ name, description: tool.description })),
        describe: (name) => {
            const tool = tools.get(name)
            if (!tool) throw new Error(`no gm tool named ${name}`)
            return z.toJSONSchema(z.object(tool.inputSchema))
        },
    }
    for (const name of tools.keys()) gm[name] = (args) => call(name, args)
    return gm
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
