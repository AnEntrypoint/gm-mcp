import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { withCodesearchDefaultK, withCodesearchDefaultKHint } from '../src/dispatch.js'

const BUNDLE = path.resolve('bin/gm-mcp-server.js')

test('codesearch defaults k to 50 only for literal, regex and filename without an explicit k', () => {
    assert.deepEqual(withCodesearchDefaultK('codesearch', { query: 'x', mode: 'literal' }), { body: { query: 'x', mode: 'literal', k: 50 }, defaulted: true })
    assert.equal(withCodesearchDefaultK('codesearch', { query: 'x', mode: 'regex' }).defaulted, true)
    assert.equal(withCodesearchDefaultK('codesearch', { query: 'x', mode: 'filename' }).defaulted, true)
    assert.equal(withCodesearchDefaultK('codesearch', { query: 'x', mode: 'literal', k: 0 }).defaulted, false, 'explicit k 0 is unlimited, not defaulted')
    assert.equal(withCodesearchDefaultK('codesearch', { query: 'x', mode: 'literal', max_results: 5 }).defaulted, false)
    assert.equal(withCodesearchDefaultK('codesearch', { query: 'x', mode: 'dual' }).defaulted, false)
    assert.equal(withCodesearchDefaultK('grep', { query: 'x', mode: 'literal' }).defaulted, false)
})

test('a defaulted codesearch reply reports shown and a hint only when matches were cut', () => {
    const cut = withCodesearchDefaultKHint(true, 'codesearch', { count: '402 lines, 402 occurrences', matches: Array.from({ length: 50 }, (_, i) => ({ line: i })) })
    assert.equal(cut.shown, 50)
    assert.equal(cut.total, 402)
    assert.equal(cut.default_k, 50)
    assert.match(cut.hint, /raise k \(0 = all\) or scope with path\/glob/)
    const complete = withCodesearchDefaultKHint(true, 'codesearch', { count: '3 lines', matches: [{}, {}, {}] })
    assert.equal(complete.hint, undefined)
    const explicit = withCodesearchDefaultKHint(false, 'codesearch', { count: '402 lines', matches: Array.from({ length: 50 }, () => ({})) })
    assert.equal(explicit.hint, undefined)
    const nested = withCodesearchDefaultKHint(true, 'codesearch', { ok: true, data: { count: '402 lines, 402 occurrences', matches: Array.from({ length: 50 }, () => ({})) } })
    assert.equal(nested.data.shown, 50)
    assert.equal(nested.data.total, 402)
    assert.match(nested.data.hint, /raise k/)
})

async function withBundle(fn) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BUNDLE], stderr: 'pipe' })
    const client = new Client({ name: 'gm-mcp-list-cap-test', version: '0.0.0' })
    try {
        await client.connect(transport)
        return await fn(client)
    } finally {
        await client.close()
    }
}

const codemodeText = async (client, code, extra = {}) => {
    const result = await client.callTool({ name: 'gm_codemode', arguments: { code, cwd: process.cwd(), ...extra } })
    return (result.content ?? []).map((part) => part.text ?? '').join('\n')
}

test('gm.list() is one entry per verb, with aliases as a field and short descriptions', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const text = await codemodeText(client, 'return gm.list()')
        assert.ok(!text.includes('reply_truncated'), 'gm.list() is cut at the codemode cap')
        assert.ok(text.length < 24_000, `gm.list() is ${text.length} chars, expected under the 24000 default cap`)
        const names = await codemodeText(client, 'return gm.list({names_only: true})')
        assert.ok(names.length < 5_000, `gm.list({names_only}) is ${names.length} chars`)
        const entries = JSON.parse(text)
        const verbs = entries.map((entry) => entry.verb ?? entry.name).filter((verb) => verb !== null)
        assert.equal(new Set(verbs).size, verbs.length, 'a verb appears in more than one gm.list() entry')
        const instruction = entries.find((entry) => (entry.verb ?? entry.name) === 'instruction')
        assert.equal(instruction.name, 'instruction')
        assert.deepEqual(instruction.aliases, ['gm_instruction'])
        for (const entry of entries) assert.ok((entry.description ?? '').length <= 80, `${entry.name} description is not clipped to 80 chars`)
    })
})

test('gm.list({filter, names_only, max_desc}) narrows the listing', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const names = JSON.parse(await codemodeText(client, 'return gm.list({names_only: true, filter: "codesearch"})'))
        assert.ok(names.includes('codesearch'), 'filter by name missed codesearch')
        assert.ok(names.every((name) => typeof name === 'string'), 'names_only must return strings')
        const full = JSON.parse(await codemodeText(client, 'return gm.list({filter: "fs_read", max_desc: 0})'))
        assert.ok(full.some((entry) => entry.name === 'fs_read'))
        const longest = Math.max(...full.map((entry) => (entry.description ?? '').length))
        assert.ok(longest > 80, 'max_desc: 0 must keep the full description')
    })
})

test('a codemode reply is capped at max_chars and says so', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const text = await codemodeText(client, 'return "x".repeat(5000)', { max_chars: 1000 })
        assert.ok(text.length <= 1000, `reply is ${text.length} chars, expected at most 1000`)
        assert.match(text, /reply_truncated: true/)
        assert.match(text, /reply_max_chars: 1000/)
    })
})

test('gm.help() names every notice code a reply can carry', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const help = JSON.parse(await codemodeText(client, 'return gm.help()'))
        for (const code of ['matches_cut', 'unproven_zero', 'scanner_zero_files', 'query_regex', 'exhaustive_scope', 'file_source_git']) {
            assert.ok(typeof help.notices[code] === 'string', `notice ${code} is not explained by gm.help()`)
        }
    })
})

test('fs_read states the range-pair rule once and gives each alias a one-line description', { timeout: 30_000 }, async () => {
    await withBundle(async (client) => {
        const schema = JSON.parse(await codemodeText(client, 'return gm.describe("fs_read")'))
        assert.match(schema.input_schema.properties.startLine.description, /^First line to return \(1-based\)\.$/)
        assert.ok(!schema.input_schema.properties.endLine.description.includes('Pairs are resolved'), 'pair rule repeated in a field')
        assert.equal(schema.input_schema.required?.includes('session_id') ?? false, false, 'session_id must be optional')
    })
})
