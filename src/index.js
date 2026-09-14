import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { gmDispatch } from './dispatch.js'

export function createServer() {
    const server = new McpServer({ name: 'gm-mcp', version: '0.2.1' })
    const instructionSessionId = `mcp-instruction-${process.pid}-${Date.now()}`

    server.registerTool(
        'gm_instruction',
        {
            description: 'Dispatch gm instruction directly. Accepts the prompt-only call shape used by MCP clients and creates a stable server-local gm session when one is not supplied.',
            inputSchema: {
                prompt: z.string().optional().describe('Current task prompt. An omitted prompt is dispatched as an empty string.'),
                session_id: z.string().optional().describe('Optional gm session id. A stable server-local id is used when omitted.'),
                cwd: z.string().optional().describe('Project root containing .gm/exec-spool -- defaults to process.cwd().'),
                timeout_seconds: z.number().optional().describe('Give up and return timed_out:true after this many seconds (default 120).'),
                poll_interval_seconds: z.number().optional().describe('Fallback response check interval in seconds when filesystem events are unavailable (default 0.25).'),
                include_timing: z.boolean().optional().describe('Include MCP submission-to-response timing and the last response wakeup source.'),
                resume_task: z.string().optional().describe('Resume a previous instruction dispatch without writing a new request.'),
            },
        },
        async (args = {}, extra) => {
            const text = await gmDispatch({
                verb: 'instruction',
                body: args.resume_task ? undefined : { prompt: args.prompt ?? '' },
                session_id: args.session_id || instructionSessionId,
                cwd: args.cwd,
                timeout_seconds: args.timeout_seconds,
                poll_interval_seconds: args.poll_interval_seconds,
                include_timing: args.include_timing,
                resume_task: args.resume_task,
            }, extra?.signal)
            return { content: [{ type: 'text', text }] }
        }
    )

    server.registerTool(
        'gm',
        {
            description: 'Run the whole gm spool write-then-poll-for-response cycle for one verb dispatch in a single call, instead of writing the input file, polling for the output file, and reading it as three separate steps. Writes .gm/exec-spool/in/<verb>/<N>.txt, polls .gm/exec-spool/out/<verb>-<N>.json until it appears (or the timeout elapses), and returns its contents as flat YAML text, auto-cleaned for readability: opaque internal ids (dispatch_id, request_fingerprint) stripped, the redundant response/data nesting levels flattened up to the top (unless a field name would collide), long text fields (e.g. instruction phase prose) truncated with a pointer naming the on-disk file to read for the full text, hit-array ranking internals (cos/score/recency in recall_hits/bm25_hits/vector_hits) dropped, and empty/null fields removed at every level. A successful response omits the spool file paths entirely (the caller already knows verb/cwd); they only appear on timeout/abort/error, to say where to look. For plain-text-body verbs (exec_js and every language stem it backs, serp, browser, cdp), pass raw_body instead of body -- these verbs reject a JSON object outright.',
            inputSchema: {
                verb: z.string().describe('gm spool verb name, e.g. instruction, prd-add, git_status, exec_js'),
                body: z.record(z.string(), z.unknown()).optional().describe('JSON body for the dispatch. session_id is added automatically if not present. Not valid for plain-text-body verbs (exec_js and its language stems, serp, browser, cdp) -- use raw_body for those instead.'),
                raw_body: z.string().optional().describe('Literal text body for a plain-text-body verb (exec_js/bash/python/etc, serp, browser, cdp) -- sent exactly as given, no JSON wrapping. Mutually exclusive with body.'),
                session_id: z.string().describe('gm SESSION_ID for this dispatch (required by gm on every body)'),
                cwd: z.string().optional().describe('Project root containing .gm/exec-spool -- defaults to process.cwd()'),
                timeout_seconds: z.number().optional().describe('Give up and return timed_out:true after this many seconds (default 120)'),
                poll_interval_seconds: z.number().optional().describe('Fallback response check interval in seconds when filesystem events are unavailable (default 0.25)'),
                include_timing: z.boolean().optional().describe('Include MCP submission-to-response timing and the last response wakeup source'),
                resume_task: z.string().optional().describe('Pass the `task` field from a previous timed_out/aborted response to keep polling that SAME dispatch instead of writing a new one -- a first-time cold index/embed pass on a large repo can legitimately outrun a short timeout_seconds, and re-dispatching from scratch discards a result that may already be in flight or done. A resume sends NO body: omit body/raw_body entirely (they are ignored if passed), since the dispatch being resumed already carries its own. It still needs `verb` and `cwd` to match the original call exactly -- those two plus the task name are how the dispatch is addressed on disk -- and `session_id` remains required by this tool for every call, though a resume never writes a new spool file with it. If that triple matches no dispatch in the project spool, the call returns an immediate error naming the three paths it checked instead of polling a task that cannot arrive. A resumed result carries a `resumed` block stating that this call sent no body and whether the result predates it, so a stored error from the ORIGINAL dispatch is never misread as a verdict on the resume call. Before any timeout is reported the out-file is re-checked past the deadline, so a result that lands moments late comes back as the ordinary success it is. A genuine timed_out response carries `resume_task_supported: true` (absent on older server builds, which silently drop this argument), a `dispatch_state` block read from the spool itself (claimed_still_in_flight / queued_not_yet_claimed / no_input_file_left) plus a `daemon` liveness block (alive/heartbeat age/runtime/queue wait) -- dispatch_state is the per-dispatch authority, daemon.busy is project-scoped and says nothing about your own request.'),
            },
        },
        async (args = {}, extra) => {
            const text = await gmDispatch(args, extra?.signal)
            return { content: [{ type: 'text', text }] }
        }
    )

    return server
}

export async function main() {
    const server = createServer()
    const transport = new StdioServerTransport()

    const keepAlive = setInterval(() => {}, 1 << 30)

    process.stdin.on('end', () => {
        console.error('gm-mcp: stdin ended (client disconnected or platform pipe quirk) -- server stays up')
    })
    process.on('uncaughtException', (err) => {
        console.error('gm-mcp: uncaught exception', err)
        process.exit(1)
    })
    process.on('unhandledRejection', (err) => {
        console.error('gm-mcp: unhandled rejection', err)
        process.exit(1)
    })

    await server.connect(transport)
    console.error('gm-mcp: connected, serving on stdio')
}
