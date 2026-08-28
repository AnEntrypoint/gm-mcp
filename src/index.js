import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { gmDispatch } from './dispatch.js'

export function createServer() {
    const server = new McpServer({ name: 'gm-mcp', version: '0.1.0' })

    server.registerTool(
        'gm',
        {
            description: 'Run the whole gm spool write-then-poll-for-response cycle for one verb dispatch in a single call, instead of writing the input file, polling for the output file, and reading it as three separate steps. Writes .gm/exec-spool/in/<verb>/<N>.txt, polls .gm/exec-spool/out/<verb>-<N>.json until it appears (or the timeout elapses), and returns its contents as flat YAML text, auto-cleaned for readability: opaque internal ids (dispatch_id, request_fingerprint) stripped, the redundant response/data nesting levels flattened up to the top (unless a field name would collide), long text fields (e.g. instruction phase prose) truncated with a pointer naming the on-disk file to read for the full text, hit-array ranking internals (cos/score/recency in recall_hits/bm25_hits/vector_hits) dropped, and empty/null fields removed at every level. A successful response omits the spool file paths entirely (the caller already knows verb/cwd); they only appear on timeout/abort/error, to say where to look. For plain-text-body verbs (exec_js and every language stem it backs, serp, browser, cdp), pass raw_body instead of body -- these verbs reject a JSON object outright.',
            inputSchema: {
                verb: z.string().describe('gm spool verb name, e.g. instruction, prd-add, git_status, exec_js'),
                body: z.record(z.any()).optional().describe('JSON body for the dispatch. session_id is added automatically if not present. Not valid for plain-text-body verbs (exec_js and its language stems, serp, browser, cdp) -- use raw_body for those instead.'),
                raw_body: z.string().optional().describe('Literal text body for a plain-text-body verb (exec_js/bash/python/etc, serp, browser, cdp) -- sent exactly as given, no JSON wrapping. Mutually exclusive with body.'),
                session_id: z.string().describe('gm SESSION_ID for this dispatch (required by gm on every body)'),
                cwd: z.string().optional().describe('Project root containing .gm/exec-spool -- defaults to process.cwd()'),
                timeout_seconds: z.number().optional().describe('Give up and return timed_out:true after this many seconds (default 120)'),
                poll_interval_seconds: z.number().optional().describe('How often to check for the response (default 1)'),
            },
        },
        async (args, extra) => {
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
