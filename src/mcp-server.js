import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { gmDispatch } from './dispatch.js'
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
            description: 'Dispatch gm instruction directly. Accepts the prompt-only call shape used by MCP clients and creates a stable server-local gm session when one is not supplied.',
            inputSchema: {
                prompt: z.string().optional().describe('Current task prompt. An omitted prompt is dispatched as an empty string.'),
                session_id: z.string().optional().describe('Optional gm session id. A stable server-local id is used when omitted.'),
                cwd: z.string().optional().describe('Project root containing .gm/exec-spool. It picks which project\'s daemon handles the dispatch, so it is how you aim a dispatch at a project other than the one the server started in -- pass it on every call. Omitting it used to fall back to this server\'s own process.cwd(), which on a shared HTTP gm-mcp server is not a project at all: the dispatch ran in that directory\'s .gm and nothing appeared in yours. Now an omitted cwd resolves from GM_MCP_DEFAULT_CWD / CLAUDE_PROJECT_DIR, else from process.cwd() only when that is a git toplevel, else the dispatch is refused with error cwd-required.'),
                timeout_seconds: numberLike.optional().describe('Give up and return timed_out:true after this many seconds (default 120). An explicit value is honoured as-is: it is how long you will wait for this call, so it is NOT clipped to GM_MCP_CLIENT_DEADLINE_SECONDS (default 60 -- a measured guess at the MCP client\'s own tool-call deadline), which now bounds only the budget of a call that names no timeout_seconds. Pass the time you are actually willing to wait; on a genuine timeout gm returns task, dispatch_state and poll_budget so the same dispatch can be re-polled with resume_task.'),
                poll_interval_seconds: numberLike.optional().describe('Fallback response check interval in seconds when filesystem events are unavailable (default 0.25).'),
                include_timing: booleanLike.optional().describe('Include MCP submission-to-response timing and the last response wakeup source.'),
                resume_task: z.string().optional().describe('Resume a previous instruction dispatch without writing a new request.'),
                mode: z.string().optional().describe('Pass "investigate_readonly" for a read-only/investigate-only ask (scan/grep/report, no code changes). Skips the SPECIFY->PROVE->EMIT->...->COMPLETE phase/PRD orchestration entirely and returns a short direct-execution instruction instead -- no phase is read or changed, no PRD/mutables state is touched. It serves no phase prose, so it never satisfies the long-gap gate mid-chain; a plain re-dispatch is the cheap re-check, since fields unchanged since the last delivered reply come back elided and listed in unchanged_since_last_reply. Omit for the normal phase-managed flow.'),
                git_root_override: z.string().optional().describe('Pin the project root explicitly when cwd is not itself a git repo and is not inside one (e.g. a directory holding many unrelated repos for a cross-repo audit), or when the git subprocess is otherwise unavailable/contended. Skips `git rev-parse --show-toplevel` for this cwd; every .gm/ state file for this dispatch is then read/written under <git_root_override>/.gm. Prefer dispatching with cwd set to one of the actual repos under the directory when that is an option -- this is for the genuinely repo-less or multi-repo case.'),
                full_response: z.boolean().optional().describe('Return the uncompacted dispatch payload. By default the response is compacted for the wire: low-signal telemetry blocks (route_hint, orient_nouns, reply_hash, clean supply_chain_scan, codeinsight detail, dream_rsi evidence rows) are dropped, long row prose is cut to a 160-char excerpt, and a `wire_compacted` block names every field dropped or shortened plus the on-disk file holding the full payload. Set true to get every field verbatim: no field dropped or excerpted, and no text field truncated (up to 1048576 characters per field; longer still carries a pointer to the out-file).'),
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
        'gm',
        {
            description: 'Run the whole gm spool write-then-poll-for-response cycle for one verb dispatch in a single call, instead of writing the input file, polling for the output file, and reading it as three separate steps. Writes .gm/exec-spool/in/<verb>/<N>.txt, polls .gm/exec-spool/out/<verb>-<N>.json until it appears (or the timeout elapses), and returns its contents as flat YAML text, auto-cleaned for readability: opaque internal ids (dispatch_id, request_fingerprint) stripped, the redundant response/data nesting levels flattened up to the top (unless a field name would collide), long text fields (e.g. instruction phase prose) truncated with a pointer naming the on-disk file to read for the full text, hit-array ranking internals (cos/recency in recall_hits/bm25_hits/vector_hits/commits) dropped, score retained as ranked evidence, byte-identical object rows repeated inside one array collapsed to the first copy, and empty/null/empty-string fields removed at every level (an empty result list such as edges/reachable/matches/definitions stays as [] so nothing-found reads as an answer) along with a false on a flag that only ever means the absence of a problem (session_mismatch, instruction_unchanged, instruction_suppressible_by_asserting_hash, recall_embed_failed, should_residual_scan, fsm_graph_rejected). On top of that cleaning the response is compacted for the wire by default: low-signal telemetry (route_hint, orient_nouns, reply_hash, an all-clear supply_chain_scan, codeinsight detail, dream_rsi evidence rows) is dropped, config_changed keeps only the newest transition, recall_hits keep key/title/score plus a 160-char excerpt, and a `wire_compacted` block names every field dropped or shortened plus the on-disk file holding the full payload; pass full_response=true for every field verbatim. A successful response omits the spool file paths entirely (the caller already knows verb/cwd); they only appear on timeout/abort/error, to say where to look. For plain-text-body verbs (exec_js and every language stem it backs, serp, browser, cdp), pass raw_body instead of body -- these verbs reject a JSON object outright.',
            inputSchema: {
                verb: z.string().describe('gm spool verb name, e.g. instruction, prd-add, git_status, exec_js, fs_read. Only verbs the running build registers are dispatchable; anything else answers error_code: unknown_verb. There is no fs_list (use fs_readdir), no fs_glob and no glob (use grep or codesearch with a body "glob" filter), and no exec_bash (use bash or exec_js with raw_body). grep is more than a pattern scan: {"mode":"comments"} sweeps comment spans with no "pattern" needed, and {"help":true} as the verb body prints every mode and parameter grep accepts -- dispatch that instead of guessing field names. fs_read pages a file too large for one reply instead of truncating it: {"offset":0,"limit":200} returns just that window plus total_lines, returned_lines and has_more_lines, so a big file is read in successive windows -- offset counts lines from 0, while the line numbers grep and codesearch report count from 1, so a hit on line N is offset N-1. Dispatch health for the build\'s own verb inventory.'),
                body: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('JSON body for the dispatch (an object, or a string holding a JSON object). session_id is added automatically if not present. Not valid for plain-text-body verbs (exec_js and its language stems, serp, browser, cdp) -- use raw_body for those instead. Search verbs take a project directory in the body: codesearch/grep/codeinsight accept "root" (aliases "projectPath", "cwd") to search another project than the one this dispatch\'s cwd selected, with "path" relative to it.'),
                raw_body: z.string().optional().describe('Literal text body for a plain-text-body verb (exec_js/bash/python/etc, serp, browser, cdp) -- sent exactly as given, no JSON wrapping. Mutually exclusive with body. The server writes these bytes to the spool input file with no escaping, so the shell sees them verbatim -- but this argument is itself a JSON string, so a backslash you write as \\ reaches the shell as \; write \\\\ to make bash receive \\. Inside bash double quotes one backslash is then removed again, and \\$ is a literal dollar sign, so "C:\\dir\\${V}" never expands ${V} -- prefer forward slashes ("C:/dir/${V}.bat") for Windows paths.'),
                session_id: z.string().describe('gm SESSION_ID for this dispatch (required by gm on every body)'),
                cwd: z.string().optional().describe('Project root containing .gm/exec-spool -- pass it on every call. It picks which project\'s daemon handles the dispatch, and so which project a verb like codesearch searches; it is not forwarded into the verb body, so to point a single dispatch at another project pass "root" (aliases "projectPath", "cwd") inside body. Omitting it no longer falls back to this server\'s process.cwd(): a shared HTTP server started outside a git toplevel refuses the dispatch (error cwd-required) rather than run it in the wrong project. GM_MCP_DEFAULT_CWD sets one explicit root for cwd-less calls.'),
                timeout_seconds: numberLike.optional().describe('Give up and return timed_out:true after this many seconds (default 120). An explicit value is honoured as-is and is NOT clipped to GM_MCP_CLIENT_DEADLINE_SECONDS (default 60 -- a measured guess at the MCP client\'s own tool-call deadline); that ceiling now bounds only a call that names no timeout_seconds. On a genuine timeout gm returns task, dispatch_state and poll_budget instead of letting the client discard the reply, and the same dispatch is re-polled with resume_task.'),
                poll_interval_seconds: numberLike.optional().describe('Fallback response check interval in seconds when filesystem events are unavailable (default 0.25)'),
                include_timing: booleanLike.optional().describe('Include MCP submission-to-response timing and the last response wakeup source'),
                resume_task: z.string().optional().describe('Pass the `task` field from a previous timed_out/aborted response to keep polling that SAME dispatch instead of writing a new one -- a first-time cold index/embed pass on a large repo can legitimately outrun a short timeout_seconds, and re-dispatching from scratch discards a result that may already be in flight or done. A resume sends NO body: omit body/raw_body entirely (they are ignored if passed), since the dispatch being resumed already carries its own. It still needs `verb` and `cwd` to match the original call exactly -- those two plus the task name are how the dispatch is addressed on disk -- and `session_id` remains required by this tool for every call, though a resume never writes a new spool file with it. If that triple matches no dispatch in the project spool, the call returns an immediate error naming the three paths it checked instead of polling a task that cannot arrive. A resumed result carries a `resumed` block stating that this call sent no body and whether the result predates it, so a stored error from the ORIGINAL dispatch is never misread as a verdict on the resume call. Before any timeout is reported the out-file is re-checked past the deadline, so a result that lands moments late comes back as the ordinary success it is. A genuine timed_out response carries `resume_task_supported: true` (absent on older server builds, which silently drop this argument), a `dispatch_state` block read from the spool itself (claimed_still_in_flight / queued_not_yet_claimed / no_input_file_left) plus a `daemon` liveness block (alive/heartbeat age/runtime/queue wait) -- dispatch_state is the per-dispatch authority, daemon.busy is project-scoped and says nothing about your own request.'),
                max_chars: z.number().optional().describe('Cap, in characters, on how much of any single text field this dispatch returns inline: default 400, 32768 for a plain-text-body verb, 65536 for fs_read, hard ceiling 1048576. Past the cap the field is truncated with a pointer naming the on-disk out-file that holds the full text. Raise it to pull a large file back whole in one call.'),
                full_response: z.boolean().optional().describe('Return the uncompacted dispatch payload. By default the response is compacted for the wire: low-signal telemetry blocks (route_hint, orient_nouns, reply_hash, clean supply_chain_scan, codeinsight detail, dream_rsi evidence rows) are dropped, long row prose is cut to a 160-char excerpt, and a `wire_compacted` block names every field dropped or shortened plus the on-disk file holding the full payload. Set true to get every field verbatim: no field dropped or excerpted, and no text field truncated (up to 1048576 characters per field; longer still carries a pointer to the out-file).'),
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

