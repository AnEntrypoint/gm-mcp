import { z } from 'zod'
import { ErrorCode, GetPromptRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

// Registers prompts that take optional arguments. The SDK parses request.params.arguments with each prompt's argsSchema, and
// that parse rejects an omitted arguments field, which the MCP spec allows. The prompts/get handler here reads an omitted
// field as {} and is otherwise the SDK's behaviour. Only prompts registered through registerArgsPrompt are served.

// The one optional argument of the gm prompts: the project root whose live state the prompt adds at fetch time.
export const CWD_PROMPT_ARGS = { cwd: z.string().optional().describe('Absolute project root. When given, the prompt adds the runner, pending-row and git state read at fetch time.') }

const promptsByServer = new WeakMap()

// Registers a prompt with McpServer.registerPrompt and installs the prompts/get reader once per server.
export function registerArgsPrompt(server, name, config, callback) {
    const prompt = server.registerPrompt(name, config, callback)
    let prompts = promptsByServer.get(server)
    if (!prompts) {
        prompts = new Map()
        promptsByServer.set(server, prompts)
        server.server.setRequestHandler(GetPromptRequestSchema, (request, extra) => getPrompt(prompts, request.params, extra))
    }
    prompts.set(name, prompt)
    return prompt
}

// Runs one prompt: an omitted arguments field is {}, argsSchema parses it, then the callback runs with the parsed arguments.
async function getPrompt(prompts, { name, arguments: args }, extra) {
    const prompt = prompts.get(name)
    if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Prompt ${name} not found`)
    if (!prompt.enabled) throw new McpError(ErrorCode.InvalidParams, `Prompt ${name} disabled`)
    if (!prompt.argsSchema) return await prompt.callback(extra)
    const parsed = await z.safeParseAsync(prompt.argsSchema, args ?? {})
    if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${parsed.error.message}`)
    return await prompt.callback(parsed.data, extra)
}
