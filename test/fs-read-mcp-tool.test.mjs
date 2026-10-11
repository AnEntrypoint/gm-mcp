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

test('the fs_read tool exposes every range alias at the top level', () => {
    const schema = verbToolInputSchema('fs_read')
    for (const key of ['startLine', 'endLine', 'start', 'end', 'count', 'from', 'to', 'offset', 'limit', 'line', 'lines']) {
        assert.ok(key in schema, `fs_read tool schema is missing ${key}`)
    }
    assert.equal('startLine' in verbToolInputSchema('codesearch'), false)
})

test('top-level range aliases fold into a body object', () => {
    assert.deepEqual(mergeVerbRangeFields('fs_read', { body: { path: 'a' }, startLine: 2, endLine: 5 }), { body: { path: 'a', startLine: 2, endLine: 5 } })
    assert.deepEqual(mergeVerbRangeFields('fs_read', { startLine: 2, endLine: 5 }), { body: { startLine: 2, endLine: 5 } })
})

test('a numeric string alias is folded as a number', () => {
    assert.deepEqual(mergeVerbRangeFields('fs_read', { body: { path: 'a' }, startLine: '2', endLine: '5' }), { body: { path: 'a', startLine: 2, endLine: 5 } })
})

test('a key named in both places takes its value from the body', () => {
    assert.deepEqual(mergeVerbRangeFields('fs_read', { body: { path: 'a', startLine: 7 }, startLine: 2 }), { body: { path: 'a', startLine: 7 } })
})

test('a body that is a JSON string is folded into as JSON, not rescanned', () => {
    assert.deepEqual(mergeVerbRangeFields('fs_read', { body: '{"path":"a}b.rs"}', startLine: 3 }), { body: { path: 'a}b.rs', startLine: 3 } })
})

test('an unparsable body string folds nothing rather than guessing', () => {
    const merged = mergeVerbRangeFields('fs_read', { body: '{"path":', startLine: 3 })
    assert.equal(merged.body, '{"path":')
    assert.equal(merged.startLine, 3)
})

test('a verb with no top-level aliases is untouched', () => {
    const args = { body: { query: 'a}b' } }
    assert.equal(mergeVerbRangeFields('codesearch', args), args)
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
