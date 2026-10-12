import assert from 'node:assert/strict'
import { mergeVerbRangeFields, verbToolInputSchema } from '../src/mcp-server.js'

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

test('the prd_list tool exposes every row selector at the top level', () => {
    const schema = verbToolInputSchema('prd-list')
    for (const key of ['id', 'status', 'limit', 'full']) {
        assert.ok(key in schema, `prd-list tool schema is missing ${key}`)
    }
    assert.equal('id' in verbToolInputSchema('prd-add'), false)
})

test('top-level row selectors fold into a body object', () => {
    assert.deepEqual(mergeVerbRangeFields('prd-list', { body: { brief: true }, id: 'ROW-1' }), { body: { brief: true, id: 'ROW-1' } })
    assert.deepEqual(mergeVerbRangeFields('prd-list', { id: 'ROW-1' }), { body: { id: 'ROW-1' } })
    assert.deepEqual(mergeVerbRangeFields('prd-list', { status: 'pending', limit: 5, full: true }), { body: { status: 'pending', limit: 5, full: true } })
})

test('a key named in both places takes its value from the body', () => {
    assert.deepEqual(mergeVerbRangeFields('prd-list', { body: { id: 'BODY-ROW' }, id: 'TOP-ROW' }), { body: { id: 'BODY-ROW' } })
})

test('a hyphenated verb and its tool name resolve the same aliases', () => {
    assert.deepEqual(mergeVerbRangeFields('prd-list', { id: 'ROW-1' }), mergeVerbRangeFields('prd_list', { id: 'ROW-1' }))
    assert.deepEqual(verbToolInputSchema('git-push'), verbToolInputSchema('git_push'))
})

test('a verb with no top-level aliases is untouched', () => {
    const args = { body: { query: 'a}b' }, id: 'ROW-1' }
    assert.equal(mergeVerbRangeFields('codesearch', args), args)
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
