import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { gmDispatch, gmResult } from './dispatch.js'
import { appendDiagnostic, describeError } from './server-log.js'
import { BUNDLE_VERSION } from './bundle-version.js'

const numberLike = z.union([z.number(), z.string()])
const booleanLike = z.union([z.boolean(), z.string()])

function failedDispatchResult(verb, error) {
    const detail = describeError(error)
    appendDiagnostic('dispatch-threw', { verb, error: detail })
    return { content: [{ type: 'text', text: `gm-mcp: ${verb} dispatch threw, stdio transport stays up -- ${detail}` }], isError: true }
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
            description: 'Read a bounded page from a GM spool result named by a truncation notice.',
            inputSchema: {
                result_file: z.string(),
                field: z.string().optional(),
                offset: numberLike.optional(),
                limit: numberLike.optional(),
            },
        },
        async (args = {}) => {
            const text = gmResult({
                result_file: args.result_file,
                field: args.field,
                offset: args.offset,
                limit: args.limit,
            })
            return { content: [{ type: 'text', text }] }
        }
    )

    server.registerTool(
        'gm',
        {
            description: 'Run one gm spool verb dispatch and return its result as flat YAML. Unknown verbs answer unknown_verb. Plain-text verbs (exec_js, bash, python, crawl) take raw_body instead of body. Parameter docs: grep with body {"help": true} lists every mode.',
            inputSchema: {
                verb: z.string().describe('gm verb name, e.g. instruction, prd-add, git_status, exec_js. No fs_list, fs_glob or exec_bash: use fs_readdir, codesearch with a glob, or exec_js.'),
                body: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Dispatch body, an object or JSON string. session_id is added when absent. Not for plain-text verbs. Search verbs accept root (alias projectPath, cwd) to search another project.'),
                raw_body: z.string().optional().describe('Literal body for plain-text verbs, sent unescaped. Mutually exclusive with body. Prefer forward slashes in Windows paths.'),
                session_id: z.string().describe('gm session id, required on every call.'),
                cwd: z.string().optional().describe('Project root holding .gm/exec-spool. Pass it on every call: it selects the project daemon and search root. It is not forwarded into the verb body.'),
                timeout_seconds: numberLike.optional().describe('Poll budget in seconds (default 120, max 240). A timeout keeps the dispatch running; resume it with resume_task.'),
                poll_interval_seconds: numberLike.optional().describe('Fallback poll interval in seconds (default 0.25) when filesystem events are unavailable.'),
                include_timing: booleanLike.optional().describe('Add submission-to-response timing to the reply.'),
                resume_task: z.string().optional().describe('Task from a timed_out reply. Resumes polling that dispatch and sends no body, so verb and cwd must match the original call.'),
                max_chars: z.number().optional().describe('Inline cap in characters per text field (default 400; 32768 for plain-text verbs; 65536 for fs_read). Past the cap the field points to its on-disk file.'),
                full_response: z.boolean().optional().describe('Return every guest field uncompacted.'),
            },
        },
        async (args = {}, extra) => {
            try {
                const text = await gmDispatch(args, extra?.signal)
                return { content: [{ type: 'text', text }] }
            } catch (error) {
                return failedDispatchResult(args?.verb ?? 'unknown', error)
            }
        }
    )

    return server
}

