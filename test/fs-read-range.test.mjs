import assert from 'node:assert/strict'
import { applyFsReadRangeFallback, fsReadRangeCanonicalBody } from '../src/dispatch.js'

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

test('every alias pair canonicalises to startLine/endLine', () => {
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', startLine: 2, endLine: 5 }), { path: 'a', startLine: 2, endLine: 5 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', start: 2, end: 5 }), { path: 'a', startLine: 2, endLine: 5 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', from: 2, to: 5 }), { path: 'a', startLine: 2, endLine: 5 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', line: 2, lines: 4 }), { path: 'a', startLine: 2, endLine: 5 })
})

test('a count alias is a number of lines, not an end line', () => {
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', start: 2, count: 3 }), { path: 'a', startLine: 2, endLine: 4 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', offset: 2, limit: 3 }), { path: 'a', startLine: 2, endLine: 4 })
})

test('a body with no range is left alone, and so is another verb', () => {
    const body = { path: 'a' }
    assert.equal(fsReadRangeCanonicalBody('fs_read', body), body)
    assert.deepEqual(fsReadRangeCanonicalBody('codesearch', { startLine: 2, endLine: 5 }), { startLine: 2, endLine: 5 })
})

test('an impossible range is left for the verb to refuse', () => {
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { startLine: 0 }), { startLine: 0 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { startLine: 9, endLine: 2 }), { startLine: 9, endLine: 2 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { startLine: 1, count: 0 }), { startLine: 1, count: 0 })
})

const file = 'l1\nl2\nl3\nl4\n'

test('a reply with no range applied is sliced client side', () => {
    const out = applyFsReadRangeFallback('fs_read', { path: 'f', startLine: 2, endLine: 3 }, { ok: true, verb: 'fs_read', path: 'f', data: file })
    assert.equal(out.content, 'l2\nl3')
    assert.equal(out.start_line, 2)
    assert.equal(out.end_line, 3)
    assert.equal(out.total_lines, 4)
    assert.equal(out.has_more_lines, true)
    assert.equal(out.next_start_line, 4)
})

test('a reply that already carries a range keeps its fields', () => {
    const landed = { ok: true, verb: 'fs_read', path: 'f', start_line: 1, returned_lines: 2, content: 'l1\nl2' }
    const out = applyFsReadRangeFallback('fs_read', { path: 'f' }, landed)
    assert.deepEqual(out, { ...landed, truncated: false })
})

test('an endLine past the last line sets truncated and reports both ranges', () => {
    const out = applyFsReadRangeFallback('fs_read', { path: 'f', startLine: 2, endLine: 9 }, { ok: true, verb: 'fs_read', path: 'f', data: file })
    assert.equal(out.clamped_to_total_lines, true)
    assert.equal(out.truncated, true)
    assert.deepEqual(out.requested_range, { start_line: 2, end_line: 9 })
    assert.deepEqual(out.returned_range, { start_line: 2, end_line: 4 })
})

test('a read that covers the request is not truncated', () => {
    const out = applyFsReadRangeFallback('fs_read', { path: 'f', startLine: 2, endLine: 3 }, { ok: true, verb: 'fs_read', path: 'f', data: file })
    assert.equal(out.truncated, false)
    assert.equal(out.clamped_to_total_lines, undefined)
})

test('a byte-capped read is truncated even with no range requested', () => {
    const out = applyFsReadRangeFallback('fs_read', { path: 'f' }, { ok: true, verb: 'fs_read', path: 'f', truncated_at_bytes: true, data: file })
    assert.equal(out.truncated, true)
})

test('an unrecognised range key is refused, never dropped', () => {
    const out = applyFsReadRangeFallback('fs_read', { path: 'f', startRow: 2 }, { ok: true, verb: 'fs_read', path: 'f', data: file })
    assert.equal(out.ok, false)
    assert.match(out.error, /does not recognise the range key/)
    assert.deepEqual(out.unknown_range_keys, ['startRow'])
})

test('snake_case start_line/end_line return the same lines as startLine/endLine', () => {
    const landed = { ok: true, verb: 'fs_read', path: 'f', data: file }
    const camel = applyFsReadRangeFallback('fs_read', { path: 'f', startLine: 2, endLine: 3 }, landed)
    const snake = applyFsReadRangeFallback('fs_read', { path: 'f', start_line: 2, end_line: 3 }, landed)
    assert.equal(snake.content, 'l2\nl3')
    assert.deepEqual(snake, camel)
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', start_line: 2, end_line: 5 }), { path: 'a', startLine: 2, endLine: 5 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', start_line: 2 }), { path: 'a', startLine: 2 })
    assert.deepEqual(fsReadRangeCanonicalBody('fs_read', { path: 'a', startLine: 2, end_line: 5 }), { path: 'a', startLine: 2, endLine: 5 })
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
