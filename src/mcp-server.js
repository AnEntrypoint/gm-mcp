import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { gmDispatch, gmResult } from './dispatch.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { RUNNER_REGISTRY_VERBS, editDistance, verbToolName } from './verbs.js'
import { VERB_TABLE, runnerVerb, tableRow, verbDescriptionLead } from './verb-table.js'
import { registerCodeMode } from './codemode.js'
import { renderBodyHint, bodyShapeLine } from './verb-bodies.js'

const numberLike = z.union([z.number(), z.string()])
const booleanLike = z.union([z.boolean(), z.string()])

export function mergeVerbRangeFields(verb, args = {}) {
    const verbKey = verbToolName(verb)
    const present = (tableRow(verb)?.aliases ?? []).filter((key) => args[key] !== undefined)
    if (present.length === 0) return args
    const rest = { ...args }
    for (const key of present) delete rest[key]
    let body = rest.body
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body)
        } catch {
            return args
        }
    }
    if (body === undefined || body === null) body = {}
    if (typeof body !== 'object' || Array.isArray(body)) return args
    const merged = { ...body }
    for (const key of present) {
        if (key in merged) continue
        const value = args[key]
        const numericRange = verbKey === 'fs_read' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
        merged[key] = numericRange ? Number(value) : value
    }
    return { ...rest, body: merged }
}

function failedDispatchResult(verb, error) {
    const detail = describeError(error)
    appendDiagnostic('dispatch-threw', { verb, error: detail })
    return { content: [{ type: 'text', text: `gm-mcp: ${verb} dispatch threw, stdio transport stays up -- ${detail}` }], isError: true }
}

const EDIT_VERB_PATTERN = /edit|patch|replace|modify/i

export function nearestGmVerb(verb) {
    if (EDIT_VERB_PATTERN.test(verb)) return 'fs_write'
    return RUNNER_REGISTRY_VERBS.reduce((best, candidate) => editDistance(verb, candidate) < editDistance(verb, best) ? candidate : best)
}

function unknownVerbHint(verb, text) {
    const reply = String(text)
    if (RUNNER_REGISTRY_VERBS.includes(verb) || !reply.includes('unknown_verb')) return reply
    const nearest = nearestGmVerb(verb)
    const edit = nearest === 'fs_write' ? ' gm has no edit verb: a whole-file write is the supported edit, so send the complete file with fs_write.' : ''
    return reply + 'verb_hint: "' + verb + '" is not a gm verb; the nearest existing verb is ' + nearest + '.' + edit + '\n'
}

const ERROR_LINE = /^error:\s*(.+?)\s*$/m
const REQUIRED_FIELD_ERROR = /^([A-Za-z_][A-Za-z0-9_]*)\s+required$/
const UNSUPPORTED_VALUE_ERROR = /^unsupported\s+([A-Za-z_][A-Za-z0-9_]*):\s*(\S+)$/

function errorMessageOf(reply) {
    const found = ERROR_LINE.exec(reply)
    if (!found) return null
    const raw = found[1].trim()
    const first = raw[0]
    if (raw.length >= 2 && (first === '"' || first === "'") && raw.endsWith(first)) return raw.slice(1, -1)
    return raw
}

function verbRejectionHint(verb, text) {
    const reply = String(text)
    const message = errorMessageOf(reply)
    if (!message) return ''
    const unsupported = UNSUPPORTED_VALUE_ERROR.exec(message)
    if (unsupported) {
        const [, field] = unsupported
        return `verb_body_hint: ${renderBodyHint(verb, field)}\nnext_dispatch_hint: ${verbToolName(verb)}\n`
    }
    const required = REQUIRED_FIELD_ERROR.exec(message)
    if (!required) return ''
    const [, field] = required
    const named = renderBodyHint(verb, field)
    const next = reply.includes('next_dispatch_hint') ? '' : `next_dispatch_hint: ${verbToolName(verb)}\n`
    return `verb_body_hint: ${named}\n${next}`
}

function withVerbRejectionHint(verb, text) {
    const hint = verbRejectionHint(verb, text)
    return hint ? String(text) + hint : String(text)
}

const DISPATCH_FIELDS = {
    body: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Dispatch body, an object or JSON string. session_id is added when absent. Not for plain-text verbs. Search verbs accept root (alias projectPath, cwd) to search another project.'),
    raw_body: z.string().optional().describe('Literal body for plain-text verbs, sent unescaped. Mutually exclusive with body. Prefer forward slashes in Windows paths.'),
    session_id: z.string().optional().describe('gm session id. gm_codemode fills in its own when omitted.'),
    cwd: z.string().optional().describe('Project root holding .gm/exec-spool. Pass it on every call: it selects the project daemon and search root. It is not forwarded into the verb body.'),
    timeout_seconds: numberLike.optional().describe('Poll budget in seconds (default 120, ceiling 600 = the harness tool-call max; override with GM_MCP_POLL_TIMEOUT_CEILING_MS). A timeout keeps the dispatch running; resume it with resume_task.'),
    poll_interval_seconds: numberLike.optional().describe('Fallback poll interval in seconds (default 0.25) when filesystem events are unavailable.'),
    include_timing: booleanLike.optional().describe('Add submission-to-response timing to the reply.'),
    resume_task: z.string().optional().describe('Task from a timed_out reply. Resumes polling that dispatch and sends no body, so verb and cwd must match the original call.'),
    max_chars: z.number().optional().describe('Whole-reply cap in characters (default 24000). Past it the reply is cut, the full text is written to spill_file, and reply_truncated is true. Per-field text caps are separate.'),
    full_response: z.boolean().optional().describe('Return every guest field uncompacted.'),
}

export function verbToolInputSchema(verb) {
    return { ...DISPATCH_FIELDS, ...(tableRow(verb)?.fields ?? {}) }
}

const SURFACE_INSTRUCTIONS = 'gm-mcp serves one tool, gm_codemode. Every gm verb is a function on `gm` inside its code body: gm_codemode({code: "return await gm.codesearch({query: \'x\'})"}). Call gm.list() for every callable name and gm.describe(name) for a verb schema. A spool reply opens with `dispatch_id: <id>`, the run\'s handle for witness_dispatch_id on gm.prd_resolve. The per-verb tools of earlier builds (gm_instruction, gm, fs_read, git_status, ...) are not registered here, so a client holding a cached tool list must re-fetch tools/list.'

const PROCESS_INSTRUCTION_SESSION_ID = `mcp-instruction-${process.pid}-${Date.now()}`

export function createServer() {
    const server = new McpServer({ name: 'gm-mcp', version: BUNDLE_VERSION }, { instructions: SURFACE_INSTRUCTIONS })
    const instructionSessionId = PROCESS_INSTRUCTION_SESSION_ID
    const tools = new Map()
    const define = (name, config, handler, verb = null) => tools.set(name, { ...config, verb, handler })

    define(
        'gm_instruction',
        {
            description: 'Dispatch a gm instruction and return its reply. Omitting session_id uses a stable server-local session.',
            inputSchema: {
                verb: z.string().optional().describe('gm spool verb to dispatch, e.g. phase-status, health, transition. Omitted means instruction.'),
                body: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Body for a non-instruction verb (an object, or a string holding a JSON object). Ignored for instruction, which takes prompt.'),
                prompt: z.string().optional().describe('Current task prompt. Omitted means an empty prompt.'),
                session_id: z.string().optional().describe('Optional gm session id.'),
                cwd: z.string().optional().describe('Project root holding .gm/exec-spool. Pass it on every call: it selects the project daemon and search root. It is not forwarded into the verb body.'),
                timeout_seconds: numberLike.optional().describe('Poll budget in seconds (default 120, ceiling 600 = the harness tool-call max; override with GM_MCP_POLL_TIMEOUT_CEILING_MS). A timeout keeps the dispatch running; resume it with resume_task.'),
                poll_interval_seconds: numberLike.optional().describe('Fallback poll interval in seconds (default 0.25) when filesystem events are unavailable.'),
                include_timing: booleanLike.optional().describe('Add submission-to-response timing to the reply.'),
                resume_task: z.string().optional().describe('The task from a timed_out reply. Keeps polling that dispatch and sends no new body.'),
                mode: z.string().optional().describe('investigate_readonly for read-only scan or report asks. It skips phase orchestration and touches no PRD or mutable state.'),
                git_root_override: z.string().optional().describe('Pin the project root when cwd is not inside a git repository.'),
                max_chars: z.number().optional().describe('Whole-reply cap in characters (default 24000). Past it the reply is cut, the full text is written to spill_file, and reply_truncated is true.'),
                full_response: z.boolean().optional().describe('Return every guest field uncompacted.'),
            },
        },
        async (args = {}, extra) => {
            try {
                const verb = args.verb || 'instruction'
                const text = await gmDispatch({
                    verb,
                    body: args.resume_task ? undefined : verb !== 'instruction' ? (args.body ?? {}) : {
                        prompt: args.prompt ?? '',
                        ...(args.mode ? { mode: args.mode } : {}),
                        ...(args.git_root_override ? { git_root_override: args.git_root_override } : {}),
                    },
                    session_id: args.session_id || instructionSessionId,
                    cwd: args.cwd || args.git_root_override,
                    timeout_seconds: args.timeout_seconds,
                    poll_interval_seconds: args.poll_interval_seconds,
                    include_timing: args.include_timing,
                    resume_task: args.resume_task,
                    max_chars: args.max_chars,
                    full_response: args.full_response,
                }, extra?.signal)
                return { content: [{ type: 'text', text: withVerbRejectionHint('instruction', text) }] }
            } catch (error) {
                return failedDispatchResult('instruction', error)
            }
        },
        'instruction'
    )

    define(
        'gm_result',
        {
            description: 'Read a bounded page from a GM spool result named by a truncation notice. result_file may be an absolute path to any project\'s .gm/exec-spool/out spill file -- the *.json result or the *.json.reply.txt reply envelope a truncation notice names -- not only the project this server was started in, or a path/name resolved against cwd. limit is an integer from 1 through 16000 (default 12000); page a longer field with offset and the returned next_offset.',
            inputSchema: {
                result_file: z.string().describe('Absolute path of the spilled .gm/exec-spool/out result a truncation notice named (a *.json result or a *.json.reply.txt reply envelope), or a path/name relative to cwd (a bare file name is also looked up under <cwd>/.gm/exec-spool/out).'),
                cwd: z.string().optional().describe('Project root holding the .gm/exec-spool that produced this result. Relative result_file names are resolved against it, so pass it whenever the result came from another project; default is this server\'s own root.'),
                root: z.string().optional().describe('Alias of cwd.'),
                projectPath: z.string().optional().describe('Alias of cwd.'),
                field: z.string().optional().describe('Field to read out of the result document (dot path, e.g. "diff"); omit it for the whole file. JSON and YAML spill files both work.'),
                offset: numberLike.optional().describe('Character offset to start from (0-based). Use the next_offset of the previous page.'),
                limit: numberLike.optional().describe('Characters to return: an integer from 1 through 16000 (default 12000).'),
            },
        },
        async (args = {}) => {
            const text = gmResult({
                result_file: args.result_file,
                field: args.field,
                offset: args.offset,
                limit: args.limit,
                cwd: args.cwd,
                root: args.root,
                projectPath: args.projectPath,
            })
            return { content: [{ type: 'text', text }] }
        }
    )

    const verbDispatch = async (verb, args = {}, extra) => {
        try {
            const text = unknownVerbHint(verb, await gmDispatch({ verb, ...mergeVerbRangeFields(verb, args) }, extra?.signal))
            return { content: [{ type: 'text', text: withVerbRejectionHint(verb, text) }] }
        } catch (error) {
            return failedDispatchResult(verb, error)
        }
    }

    define(
        'gm',
        {
            description: 'Run one gm spool verb dispatch and return its result as flat YAML. Unknown verbs answer unknown_verb. Plain-text verbs (exec_js, bash, python, crawl) take raw_body instead of body. Parameter docs: grep with body {"help": true} lists every mode.',
            inputSchema: {
                verb: z.string().describe('gm verb name, e.g. instruction, prd-add, git_status, exec_js. No fs_list, fs_glob or exec_bash: use fs_readdir, codesearch with a glob, or exec_js.'),
                ...DISPATCH_FIELDS,
            },
        },
        async (args = {}, extra) => verbDispatch(args?.verb ?? 'unknown', args, extra)
    )

    for (const row of VERB_TABLE) {
        const verb = runnerVerb(row)
        define(
            row.canonical,
            {
                description: `${verbDescriptionLead(verb)}${row.description}${bodyShapeLine(verb)}`,
                inputSchema: verbToolInputSchema(verb),
            },
            async (args = {}, extra) => verbDispatch(verb, args, extra),
            verb
        )
    }

    registerCodeMode(server, tools)
    return server
}
