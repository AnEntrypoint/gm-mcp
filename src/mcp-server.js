import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { gmDispatch, gmResult } from './dispatch.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { RUNNER_REGISTRY_VERBS, verbToolName } from './verbs.js'

const numberLike = z.union([z.number(), z.string()])
const booleanLike = z.union([z.boolean(), z.string()])

const FS_READ_RANGE_ALIASES = ['startLine', 'endLine', 'start', 'end', 'count', 'from', 'to', 'offset', 'limit', 'line', 'lines']
const FS_READ_RANGE_PAIR_HELP = 'Pairs are resolved in this order: startLine/endLine, then start/end (start/count also works), then from/to, then offset/limit, then line/lines. endLine/end/to is the last line to return; limit/count/lines is a number of lines, not an end line.'
const FS_READ_RANGE_FIELDS = Object.fromEntries(FS_READ_RANGE_ALIASES.map((key) => {
    const isCount = key === 'count' || key === 'limit' || key === 'lines'
    const isStart = key === 'startLine' || key === 'start' || key === 'from' || key === 'offset' || key === 'line'
    const role = isCount ? 'Number of lines to return, not an end line' : isStart ? 'First line to return' : 'Last line to return'
    return [key, numberLike.optional().describe(`${role} (1-based, inclusive on both ends). ${FS_READ_RANGE_PAIR_HELP}`)]
}))
const VERB_EXTRA_FIELDS = { fs_read: FS_READ_RANGE_FIELDS }
const GIT_COMMIT_TOP_LEVEL_FIELDS = ['message', 'paths', 'files', 'allow_whole_index', 'recover_remote_moved', 'source_ref', 'rev']
const GIT_COMMIT_TOP_LEVEL_FIELD_TYPES = {
    message: z.string(),
    paths: z.array(z.string()),
    files: z.array(z.string()),
    allow_whole_index: booleanLike,
    recover_remote_moved: booleanLike,
    source_ref: z.string(),
    rev: z.string(),
}
const GIT_COMMIT_TOP_LEVEL_FIELDS_ZOD = Object.fromEntries(GIT_COMMIT_TOP_LEVEL_FIELDS.map((key) => [key, GIT_COMMIT_TOP_LEVEL_FIELD_TYPES[key].optional()
    .describe(`Top-level alias of body.${key} for git_finalize/git_commit: folded into body when body does not already name it.`)]))
for (const verb of ['git_finalize', 'git_commit']) VERB_EXTRA_FIELDS[verb] = GIT_COMMIT_TOP_LEVEL_FIELDS_ZOD
const VERB_DESCRIPTION_EXTRA = { fs_read: ` Line ranges are 1-based and inclusive on both ends: ${FS_READ_RANGE_ALIASES.join(', ')} are accepted at the top level and folded into body. ${FS_READ_RANGE_PAIR_HELP} Without any of them the whole file is returned, unchanged.` }
const VERB_TOP_LEVEL_ALIASES = { fs_read: FS_READ_RANGE_ALIASES, git_finalize: GIT_COMMIT_TOP_LEVEL_FIELDS, git_commit: GIT_COMMIT_TOP_LEVEL_FIELDS }
for (const verb of ['git_finalize', 'git_commit']) {
    VERB_DESCRIPTION_EXTRA[verb] = ` ${GIT_COMMIT_TOP_LEVEL_FIELDS.join(', ')} are accepted at the top level and folded into body, so {"message":..., "paths":[...]} and body:{"message":..., "paths":[...]} are the same call; a key named in both takes its value from body.`
}

export function mergeVerbRangeFields(verb, args = {}) {
    const present = (VERB_TOP_LEVEL_ALIASES[verb] ?? []).filter((key) => args[key] !== undefined)
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
        const numericRange = verb === 'fs_read' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
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

function editDistance(left, right) {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let i = 1; i <= left.length; i++) {
        let diagonal = row[0]
        row[0] = i
        for (let j = 1; j <= right.length; j++) {
            const above = row[j]
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
            diagonal = above
        }
    }
    return row[right.length]
}

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

const DISPATCH_FIELDS = {
    body: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Dispatch body, an object or JSON string. session_id is added when absent. Not for plain-text verbs. Search verbs accept root (alias projectPath, cwd) to search another project.'),
    raw_body: z.string().optional().describe('Literal body for plain-text verbs, sent unescaped. Mutually exclusive with body. Prefer forward slashes in Windows paths.'),
    session_id: z.string().describe('gm session id, required on every call.'),
    cwd: z.string().optional().describe('Project root holding .gm/exec-spool. Pass it on every call: it selects the project daemon and search root. It is not forwarded into the verb body.'),
    timeout_seconds: numberLike.optional().describe('Poll budget in seconds (default 120, max 240). A timeout keeps the dispatch running; resume it with resume_task.'),
    poll_interval_seconds: numberLike.optional().describe('Fallback poll interval in seconds (default 0.25) when filesystem events are unavailable.'),
    include_timing: booleanLike.optional().describe('Add submission-to-response timing to the reply.'),
    resume_task: z.string().optional().describe('Task from a timed_out reply. Resumes polling that dispatch and sends no body, so verb and cwd must match the original call.'),
    max_chars: z.number().optional().describe('Whole-reply cap in characters (default 24000). Past it the reply is cut, the full text is written to spill_file, and reply_truncated is true. Per-field text caps are separate.'),
    full_response: z.boolean().optional().describe('Return every guest field uncompacted.'),
}

export function verbToolInputSchema(verb) {
    return { ...DISPATCH_FIELDS, ...(VERB_EXTRA_FIELDS[verb] ?? {}) }
}

export function createServer() {
    const server = new McpServer({ name: 'gm-mcp', version: BUNDLE_VERSION })
    const instructionSessionId = `mcp-instruction-${process.pid}-${Date.now()}`

    server.registerTool(
        'gm_instruction',
        {
            description: 'Dispatch a gm instruction and return its reply. Omitting session_id uses a stable server-local session.',
            inputSchema: {
                prompt: z.string().optional().describe('Current task prompt. Omitted means an empty prompt.'),
                session_id: z.string().optional().describe('Optional gm session id.'),
                cwd: z.string().optional().describe('Project root holding .gm/exec-spool. Pass it on every call: it selects the project daemon and search root. It is not forwarded into the verb body.'),
                timeout_seconds: numberLike.optional().describe('Poll budget in seconds (default 120, max 240). A timeout keeps the dispatch running; resume it with resume_task.'),
                poll_interval_seconds: numberLike.optional().describe('Fallback poll interval in seconds (default 0.25) when filesystem events are unavailable.'),
                include_timing: booleanLike.optional().describe('Add submission-to-response timing to the reply.'),
                resume_task: z.string().optional().describe('The task from a timed_out reply. Keeps polling that dispatch and sends no new body.'),
                mode: z.string().optional().describe('investigate_readonly for read-only scan or report asks. It skips phase orchestration and touches no PRD or mutable state.'),
                git_root_override: z.string().optional().describe('Pin the project root when cwd is not inside a git repository.'),
                full_response: z.boolean().optional().describe('Return every guest field uncompacted.'),
            },
        },
        async (args = {}, extra) => {
            try {
                const text = await gmDispatch({
                    verb: 'instruction',
                    body: args.resume_task ? undefined : {
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
                    full_response: args.full_response,
                }, extra?.signal)
                return { content: [{ type: 'text', text }] }
            } catch (error) {
                return failedDispatchResult('instruction', error)
            }
        }
    )

    server.registerTool(
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

    const dispatchFields = DISPATCH_FIELDS
    const verbDispatch = async (verb, args = {}, extra) => {
        try {
            const text = unknownVerbHint(verb, await gmDispatch({ verb, ...mergeVerbRangeFields(verb, args) }, extra?.signal))
            return { content: [{ type: 'text', text }] }
        } catch (error) {
            return failedDispatchResult(verb, error)
        }
    }

    server.registerTool(
        'gm',
        {
            description: 'Run one gm spool verb dispatch and return its result as flat YAML. Unknown verbs answer unknown_verb. Plain-text verbs (exec_js, bash, python, crawl) take raw_body instead of body. Parameter docs: grep with body {"help": true} lists every mode.',
            inputSchema: {
                verb: z.string().describe('gm verb name, e.g. instruction, prd-add, git_status, exec_js. No fs_list, fs_glob or exec_bash: use fs_readdir, codesearch with a glob, or exec_js.'),
                ...dispatchFields,
            },
        },
        async (args = {}, extra) => verbDispatch(args?.verb ?? 'unknown', args, extra)
    )

    for (const verb of RUNNER_REGISTRY_VERBS) {
        server.registerTool(
            verbToolName(verb),
            {
                description: `gm spool verb \`${verb}\`, dispatched exactly as the generic gm tool dispatches it. Plain-text verbs take raw_body instead of body.${VERB_DESCRIPTION_EXTRA[verb] ?? ''}`,
                inputSchema: verbToolInputSchema(verb),
            },
            async (args = {}, extra) => verbDispatch(verb, args, extra)
        )
    }

    return server
}

