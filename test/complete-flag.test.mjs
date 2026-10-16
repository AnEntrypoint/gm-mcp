import assert from 'node:assert/strict'
import { compactWireResponse, withCodesearchCompleteness } from '../src/response-compact.js'

const OUT_PATH = 'C:/proj/.gm/exec-spool/out/codesearch-complete-flag.json'

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

function scopedCompleteReply() {
    return {
        ok: true,
        verb: 'codesearch',
        returned: 9,
        total_matches: 10,
        truncated: false,
        data: {
            count: 9,
            exhaustive: true,
            file_source: 'git',
            files_scanned: 31,
            match_count: 10,
            matches: [{ path: './gm-mcp/src/dispatch.js', line: 15, match: 'codesearch' }],
            lines_scanned: 7838,
        },
    }
}

function cappedRepoWideReply() {
    return {
        ok: true,
        verb: 'codesearch',
        partial: true,
        partial_reason: 'the scan did not cover the whole scope -- the matches below are NOT every match in the scope',
        returned: 23,
        total_matches: 25,
        truncated: true,
        dropped: 2,
        data: {
            count: 23,
            exhaustive: false,
            exhaustive_note: 'exhaustive_scope',
            files_scanned: 11115,
            files_skipped_binary: 6,
            excluded_by_rule_count: 51,
            match_count: 25,
            matches: [{ path: './gm-mcp/src/response-compact.js', line: 454, match: 'partial_reason' }],
        },
    }
}

test('complete scoped search carries complete:true and no complete_reason', () => {
    const out = withCodesearchCompleteness('codesearch', scopedCompleteReply())
    assert.equal(out.complete, true)
    assert.equal(out.complete_reason, undefined)
    assert.equal(out.ok, true)
    assert.equal(out.data.exhaustive, true)
    assert.equal(out.data.match_count, 10)
})

test('capped repo-wide search carries complete:false with complete_reason and keeps partial fields', () => {
    const out = withCodesearchCompleteness('codesearch', cappedRepoWideReply())
    assert.equal(out.complete, false)
    assert.equal(typeof out.complete_reason, 'string')
    assert.match(out.complete_reason, /partial/)
    assert.match(out.complete_reason, /exhaustive:false/)
    assert.match(out.complete_reason, /files_skipped_binary:6/)
    assert.equal(out.partial, true)
    assert.equal(out.partial_reason, cappedRepoWideReply().partial_reason)
    assert.equal(out.dropped, 2)
    assert.equal(out.data.exhaustive, false)
})

test('every codesearch reply has an explicit boolean complete', () => {
    const replies = [
        scopedCompleteReply(),
        cappedRepoWideReply(),
        { ok: false, verb: 'codesearch', error: 'spool timed out', data: {} },
        { ok: true, verb: 'codesearch', data: { files_scanned: 0, matches: [] } },
    ]
    for (const reply of replies) {
        const out = withCodesearchCompleteness('codesearch', reply)
        assert.equal(typeof out.complete, 'boolean')
        if (out.complete === false) assert.equal(typeof out.complete_reason, 'string')
    }
})

test('complete flag survives wire compaction for both searches', () => {
    const complete = compactWireResponse(withCodesearchCompleteness('codesearch', scopedCompleteReply()), OUT_PATH)
    assert.equal(complete.complete, true)
    assert.equal(complete.complete_reason, undefined)
    const capped = compactWireResponse(withCodesearchCompleteness('codesearch', cappedRepoWideReply()), OUT_PATH)
    assert.equal(capped.complete, false)
    assert.match(capped.complete_reason, /partial/)
})

test('other verbs are left untouched', () => {
    const reply = { ok: true, verb: 'grep', data: { exhaustive: false, matches: [] } }
    const out = withCodesearchCompleteness('grep', reply)
    assert.equal(out, reply)
    assert.equal(out.complete, undefined)
})

console.log(`${passed} complete-flag tests passed`)
