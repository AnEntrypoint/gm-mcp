import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('the bundled server advertises every public MCP tool', { timeout: 10_000 }, async () => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('bin/gm-mcp-server.js')],
        stderr: 'pipe',
    })
    const client = new Client({ name: 'gm-mcp-catalog-test', version: '0.0.0' })

    try {
        await client.connect(transport)
        const { tools } = await client.listTools()
        assert.deepEqual(
            tools.map(({ name }) => name).sort(),
            ['gm', 'gm_instruction', 'gm_result'],
        )
    } finally {
        await client.close()
    }
})
