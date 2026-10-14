import assert from 'node:assert/strict'
import { z } from 'zod'
import { foldVerbArgs, registerCodeMode } from '../src/codemode.js'
import { verbToolInputSchema } from '../src/mcp-server.js'

let passed = 0
function test(name, fn) {
    try {
        fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

const toolFor = (verb) => ({ verb, inputSchema: verbToolInputSchema(verb) })

test('a verb argument folds into the body', () => {
    assert.deepEqual(
        foldVerbArgs(toolFor('codesearch'), { query: 'createWorkerRenderer', mode: 'literal', max_matches: 20 }),
        { body: { query: 'createWorkerRenderer', mode: 'literal', max_matches: 20 } },
    )
    assert.deepEqual(foldVerbArgs(toolFor('codesearch'), { pattern: 'createWorkerRenderer' }), { body: { pattern: 'createWorkerRenderer' } })
    assert.deepEqual(foldVerbArgs(toolFor('fs_read'), { path: 'src/cli.js' }), { body: { path: 'src/cli.js' } })
    assert.deepEqual(foldVerbArgs(toolFor('exec_js'), { code: '1 + 1' }), { body: { code: '1 + 1' } })
    assert.deepEqual(foldVerbArgs(toolFor('git_rm'), { paths: ['a'] }), { body: { paths: ['a'] } })
})

test('the dispatch envelope stays at the top level', () => {
    const args = { query: 'x', session_id: 'S', cwd: 'C', timeout_seconds: 30, max_chars: 500, full_response: true }
    assert.deepEqual(foldVerbArgs(toolFor('codesearch'), args), {
        session_id: 'S', cwd: 'C', timeout_seconds: 30, max_chars: 500, full_response: true, body: { query: 'x' },
    })
})

test('a key named in both places takes its value from the body', () => {
    assert.deepEqual(foldVerbArgs(toolFor('codesearch'), { body: { query: 'BODY' }, query: 'TOP' }), { body: { query: 'BODY' } })
    assert.deepEqual(foldVerbArgs(toolFor('codesearch'), { body: '{"query":"BODY"}', query: 'TOP' }), { body: { query: 'BODY' } })
})

test('raw_body wins over a folded argument', () => {
    assert.deepEqual(foldVerbArgs(toolFor('exec_js'), { raw_body: '1 + 1', code: '2 + 2' }), { raw_body: '1 + 1' })
})

test('a verb top-level alias is left for the dispatcher to fold', () => {
    assert.deepEqual(foldVerbArgs(toolFor('fs_read'), { path: 'a.js', startLine: 2, endLine: 5 }), { startLine: 2, endLine: 5, body: { path: 'a.js' } })
    assert.deepEqual(foldVerbArgs(toolFor('prd-list'), { id: 'ROW-1' }), { id: 'ROW-1' })
    assert.deepEqual(foldVerbArgs(toolFor('git_commit'), { message: 'm', paths: ['a'] }), { message: 'm', paths: ['a'] })
    assert.deepEqual(foldVerbArgs(toolFor('git_push'), { rev: 'abc123' }), { rev: 'abc123' })
    assert.deepEqual(foldVerbArgs(toolFor('git_status'), { limit: 5, path: 'a' }), { limit: 5, path: 'a' })
    assert.deepEqual(foldVerbArgs(toolFor('git_log'), { limit: 5 }), { limit: 5 })
    assert.deepEqual(foldVerbArgs(toolFor('git_reset'), { mode: 'hard' }), { mode: 'hard' })
})

test('a tool that is not a verb dispatch is untouched', () => {
    const args = { verb: 'codesearch', body: { query: 'x' } }
    assert.equal(foldVerbArgs({ verb: null, inputSchema: { verb: true } }, args), args)
})

async function runCodemode(tools, code) {
    let handler = null
    registerCodeMode({ registerTool: (_name, _config, fn) => { handler = fn } }, tools)
    return handler({ code, cwd: 'C:/dev/project', session_id: 'SESSION' }, {})
}

async function testAsync(name, fn) {
    try {
        await fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

await testAsync('gm.<verb>({...}) reaches the tool handler as the verb body', async () => {
    const seen = []
    const tools = new Map([['codesearch', {
        verb: 'codesearch',
        inputSchema: verbToolInputSchema('codesearch'),
        handler: async (args) => {
            seen.push(args)
            return { content: [{ type: 'text', text: 'matches: 1' }] }
        },
    }]])
    const result = await runCodemode(tools, "return await gm.codesearch({query: 'createWorkerRenderer', mode: 'literal', max_matches: 20})")
    assert.equal(result.content[0].text, 'matches: 1')
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].body, { query: 'createWorkerRenderer', mode: 'literal', max_matches: 20 })
    assert.equal(seen[0].session_id, 'SESSION')
    assert.equal(seen[0].cwd, 'C:/dev/project')
})

await testAsync('a second object argument is folded in, so a dropped cwd cannot mis-root a dispatch', async () => {
    const seen = []
    const tools = new Map([['git_status', {
        verb: 'git_status',
        inputSchema: verbToolInputSchema('git_status'),
        handler: async (args) => {
            seen.push(args)
            return { content: [{ type: 'text', text: 'clean' }] }
        },
    }]])
    await runCodemode(tools, "return await gm.git_status({}, {cwd: 'C:/dev/other', max_chars: 800})")
    assert.equal(seen.length, 1)
    assert.equal(seen[0].cwd, 'C:/dev/other')
    assert.equal(seen[0].max_chars, 800)
    assert.equal(seen[0].body, undefined)
    const threw = await runCodemode(tools, "return await gm.git_status({}, 'C:/dev/other')")
    assert.match(threw.content[0].text, /second argument must be an object/)
})

await testAsync('git_root_override pins cwd for a call that names none', async () => {
    const seen = []
    const tools = new Map([['git_status', {
        verb: 'git_status',
        inputSchema: verbToolInputSchema('git_status'),
        handler: async (args) => {
            seen.push(args)
            return { content: [{ type: 'text', text: 'clean' }] }
        },
    }]])
    await runCodemode(tools, "return await gm.git_status({git_root_override: 'C:/dev/pinned'})")
    assert.equal(seen[0].cwd, 'C:/dev/pinned')
    await runCodemode(tools, "return await gm.git_status({cwd: 'C:/dev/named', git_root_override: 'C:/dev/pinned'})")
    assert.equal(seen[1].cwd, 'C:/dev/named')
})

await testAsync('gm.gm({verb, body}) still dispatches unchanged', async () => {
    const seen = []
    const tools = new Map([['gm', {
        verb: null,
        inputSchema: { verb: z.string(), ...verbToolInputSchema('gm') },
        handler: async (args) => {
            seen.push(args)
            return { content: [{ type: 'text', text: 'ok' }] }
        },
    }]])
    await runCodemode(tools, "return await gm.gm({verb: 'codesearch', body: {query: 'x'}})")
    assert.deepEqual(seen[0], { verb: 'codesearch', body: { query: 'x' }, cwd: 'C:/dev/project', session_id: 'SESSION' })
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
