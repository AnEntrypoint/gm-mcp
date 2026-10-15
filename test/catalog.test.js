import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { RUNNER_REGISTRY_VERBS } from '../src/verbs.js'

const BUNDLE = path.resolve('bin/gm-mcp-server.js')

async function withBundle(fn) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BUNDLE],
        env: { ...process.env, GM_MCP_NO_HTTP_SINGLETON: '1' },
        stderr: 'pipe',
    })
    const client = new Client({ name: 'gm-mcp-catalog-test', version: '0.0.0' })
    try {
        await client.connect(transport)
        return await fn(client)
    } finally {
        await client.close()
    }
}

const codemodeReply = async (client, code) => {
    const result = await client.callTool({ name: 'gm_codemode', arguments: { code, cwd: process.cwd() } })
    const text = (result.content ?? []).map((part) => part.text ?? '').join('\n')
    return { text, parsed: JSON.parse(text) }
}

test('the bundled server serves the codemode tool', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const { tools } = await client.listTools()
        assert.deepEqual(tools.map(({ name }) => name).sort(), ['gm_codemode'])
        const [codemode] = tools
        assert.equal(codemode.inputSchema.properties.code.type, 'string')
        assert.ok(codemode.inputSchema.required.includes('code'))
    })
})

test('every registry verb is reachable through the served tool', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const { parsed } = await codemodeReply(client, 'return gm.list().map((entry) => entry.name)')
        assert.ok(parsed.length > 0, 'gm.list() named no callable verb')
        const canonicalUnderscoreSpelling = (verb) => verb.replace(/-/g, '_')
        const listed = new Set(parsed.map(canonicalUnderscoreSpelling))
        const missing = RUNNER_REGISTRY_VERBS.filter((verb) => !listed.has(canonicalUnderscoreSpelling(verb)))
        assert.deepEqual(missing, [], `registry verbs not callable through gm_codemode: ${missing.join(', ')}`)
    })
})

test('a verb reached through the served tool keeps its body fields', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const prdList = (await codemodeReply(client, 'return gm.describe("prd-list")')).parsed
        for (const field of ['id', 'status', 'limit', 'full']) {
            assert.ok(prdList.body_schema.fields[field], `prd-list lost the ${field} body field`)
        }
        const codesearch = (await codemodeReply(client, 'return gm.describe("codesearch")')).parsed
        assert.ok(codesearch.body_schema.fields.query, 'codesearch lost the query body field')
        assert.ok(codesearch.body_schema.fields.query.aliases.includes('pattern'), 'codesearch lost the pattern alias')
    })
})
