import assert from 'node:assert/strict'
import * as yaml from 'js-yaml'
import { cleanResponse, compactWireResponse } from '../src/response-compact.js'

const OUT_PATH = 'C:/proj/.gm/exec-spool/out/instruction-task-1-2-3.json'

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

function longProse(n) {
    return 'x'.repeat(n)
}

function payload() {
    return {
        verb: 'instruction',
        ok: true,
        data: {
            phase: 'EXECUTE',
            sub_phase: '',
            session_id: 'task-1',
            session_mismatch: false,
            session_owner_before_this_dispatch: 'prior-owner',
            instruction: longProse(9000),
            instruction_hash: '0123456789abcdef',
            reply_hash: 'fedcba9876543210',
            policy_hash: 'aaaabbbbccccdddd',
            route_hint: { algo: 'rule', confidence: 0.5, model: 'claude-haiku-4-5', temperature: 0.7, top_p: 0.9, exploration: false, context_bucket: 2 },
            orient_nouns: ['additional', 'adversarial', 'angle'],
            codeinsight_overview: {
                by_kind: [{ c: 635, kind: 'function_definition' }, { c: 207, kind: 'arrow_function' }],
                by_language: [{ files: 17, lang: 'cpp', loc: 9333, symbols: 265 }],
                largest_files: [{ c: 58, path: 'src/control/apc_grid.cpp' }],
                coverage: { embedded_chunks: 125, embedded_files: 107, semantic_search_covers_files_fraction: 0.68, symbol_files: 157 },
                doc_sections: 198,
                file_count: 157,
                codeinsight_available: true,
                semantic_index_digest: 'v3:0915021b',
                symbol_count: 1052,
            },
            codeinsight_start: { expected_digest: 'v3:abc', fresh: false, ready: true, required: true, stale_before: true, index: { complete: false, digest: 'v3:abc', ok: true, partial: true, reused: true } },
            config_changed: [
                { changed: ['a (added)', 'b (changed)', 'c (changed)', 'd (changed)', 'e (changed)'], changed_count: 5, id: 'cfg-1', new_sha: '111111111111', old_sha: '000000000000', tier: 'implicit_default_repo', ts: 1000 },
                { changed: ['e (removed)', 'd (changed)', 'c (changed)', 'b (changed)', 'a (changed)'], changed_count: 5, id: 'cfg-2', new_sha: '000000000000', old_sha: '111111111111', tier: 'implicit_default_repo', ts: 2000 },
            ],
            supply_chain_scan: { blocked: [], blockedCount: 0, failCount: 0, failing: [], filesScanned: 27, nodeModulesPresent: true, ok: true, root: '.', symlinkEscapeCount: 0, symlinkEscapes: [], tool: 'scan_deps', version: 1, warnCount: 0, warnings: [] },
            dream_rsi_strategy: { evidence: [{ dispatch_id: 'a', verb: 'codesearch', quality: 0.06 }, { dispatch_id: 'b', verb: 'codesearch', quality: 0 }], failed_dispatch_count: 3, gate_drift_failure_count: 1, observation_count: 22, selection: 'replay-recorded-successes-first', successful_dispatch_count: 19 },
            dream_rsi_replay: { ok: true, replays: [{ cost: 16, score: 0.06, verb: 'codesearch' }], score: 0.375, selection: 'continue-current-exploration' },
            prd_items: [{ id: 'fix-upward-shift-glitch', status: 'pending', title: null }],
            prd_items_truncated: { full_list_on_disk: 'C:/proj/.gm/prd.yml', full_list_verb: 'prd-list', inlined: 1, inlined_rows_are: 'the open rows nearest the front of the queue, ready_wave order', inlined_rows_shape: 'summary (id, title, status)', of: 4 },
            ready_wave: [{ id: 'fix-upward-shift-glitch', session_id: 'task-1', status: 'pending', subject: longProse(700) }],
            mutables_pending: [{ id: 'mutable-one', session_id: 'task-1', status: 'unknown', subject: longProse(500) }],
            recall_hits: [
                { chars: 1529, cos: 0.9, key: 'mem-aaaa-1529', recency: 0.1, score: 0.663, text: longProse(1529), title: 'Resolved mutable: quantization lineup' },
                { chars: 749, key: 'mem-bbbb-749', score: 0.654, text: longProse(749), title: 'Resolved mutable: finish ceiling' },
                { chars: 1010, key: 'mem-cccc-1010', score: 0.609, text: longProse(1010), title: 'Resolved mutable: link transport' },
                { chars: 837, key: 'mem-dddd-837', score: 0.581, text: longProse(837), title: 'Resolved mutable: stuck recording' },
                { chars: 346, key: 'mem-eeee-346', score: 0.466, text: longProse(346), title: 'Resolved mutable: no alsa seq' },
            ],
        },
    }
}

function flatten(parsed) {
    const { data, ...rest } = cleanResponse(parsed, undefined, OUT_PATH)
    return { ...rest, ...data }
}

function render(out) {
    return yaml.dump(out, { lineWidth: 100 })
}

const cleaned = flatten(payload())
const compacted = compactWireResponse(cleaned, OUT_PATH)

test('compaction is smaller than the uncompacted response', () => {
    assert.ok(render(compacted).length < render(cleaned).length, 'compacted must be smaller')
})

test('every field dropped or shortened is named in wire_compacted', () => {
    const compactedKeys = new Set(Object.keys(compacted).filter(k => k !== 'wire_compacted'))
    const cleanedKeys = new Set(Object.keys(cleaned))
    const disclosed = `${compacted.wire_compacted.omitted} ${compacted.wire_compacted.shortened}`
    for (const key of cleanedKeys) {
        if (compactedKeys.has(key)) continue
        assert.ok(disclosed.includes(key), `${key} disappeared without being disclosed`)
    }
    for (const key of compactedKeys) {
        assert.ok(cleanedKeys.has(key), `${key} was invented by compaction`)
    }
})

test('load-bearing fields survive compaction', () => {
    for (const key of ['verb', 'ok', 'phase', 'session_id', 'instruction', 'instruction_hash', 'policy_hash', 'prd_items', 'ready_wave']) {
        assert.ok(key in compacted, `${key} must survive compaction`)
    }
    assert.equal(compacted.phase, 'EXECUTE')
    assert.equal(compacted.prd_items[0].id, 'fix-upward-shift-glitch')
    assert.equal(compacted.prd_items[0].status, 'pending')
})

test('recall_hits keep key, title, score and a bounded excerpt', () => {
    const hit = compacted.recall_hits[0]
    assert.equal(hit.key, 'mem-aaaa-1529')
    assert.equal(hit.title, 'Resolved mutable: quantization lineup')
    assert.equal(hit.score, 0.663)
    assert.ok(hit.text.length <= 170, `excerpt must be bounded, got ${hit.text.length}`)
    assert.ok(hit.text.startsWith('xxx'), 'excerpt must carry the head of the text')
    assert.match(hit.text, /\.\.\.\+\d+$/, 'excerpt must say how much is missing')
    assert.equal(hit.chars, 1529, 'full stored length must still be disclosed')
    assert.equal('cos' in hit, false)
    assert.equal('recency' in hit, false)
})

test('recall_hits are capped and the cap is disclosed', () => {
    assert.equal(compacted.recall_hits.length, 4)
    assert.match(compacted.wire_compacted.shortened, /recall_hits\(4\/5\)/)
})

test('low-signal telemetry is dropped and disclosed', () => {
    for (const key of ['route_hint', 'reply_hash', 'orient_nouns', 'supply_chain_scan']) {
        assert.equal(key in compacted, false, `${key} must be dropped`)
        assert.match(compacted.wire_compacted.omitted, new RegExp(key))
    }
})

test('session_owner_before_this_dispatch survives only alongside session_mismatch', () => {
    assert.equal('session_owner_before_this_dispatch' in compacted, false)
    const mismatched = { ...cleaned, session_mismatch: true }
    assert.equal('session_owner_before_this_dispatch' in compactWireResponse(mismatched, OUT_PATH), true)
})

test('codeinsight detail collapses to counts', () => {
    assert.deepEqual(compacted.codeinsight_overview, { files: 157, symbols: 1052, semantic_coverage: 0.68, available: true })
    assert.deepEqual(compacted.codeinsight_start, { ready: true })
})

test('a codeinsight_start that is not ready is kept whole', () => {
    const notReady = compactWireResponse({ ...cleaned, codeinsight_start: { ready: false, fresh: false, index: { partial: true } } }, OUT_PATH)
    assert.equal(notReady.codeinsight_start.ready, false)
    assert.equal(notReady.codeinsight_start.fresh, false)
})

test('a supply_chain_scan with many warnings is capped, keeping its full count', () => {
    const noisy = compactWireResponse({
        ...cleaned,
        supply_chain_scan: {
            ok: true,
            filesScanned: 575,
            warnCount: 283,
            warnings: Array.from({ length: 283 }, (_, i) => ({ path: `./runs/chrome-profile-${i}/background.js`, ratio: 800, note: null })),
        },
    }, OUT_PATH)
    assert.equal(noisy.supply_chain_scan.warnings.length, 8)
    assert.equal(noisy.supply_chain_scan.warnCount, 283)
    assert.equal(noisy.supply_chain_scan.warningsOmitted, 275)
    assert.equal(noisy.supply_chain_scan.filesScanned, 575)
})

test('a supply_chain_scan with findings is kept whole', () => {
    const withFindings = compactWireResponse({ ...cleaned, supply_chain_scan: { ok: false, blocked: ['evil-pkg'], blockedCount: 1, filesScanned: 27 } }, OUT_PATH)
    assert.deepEqual(withFindings.supply_chain_scan.blocked, ['evil-pkg'])
    assert.equal(withFindings.wire_compacted.omitted.includes('supply_chain_scan'), false)
})

test('config_changed keeps the newest transition with a bounded key list', () => {
    assert.equal(compacted.config_changed.length, 1)
    assert.equal(compacted.config_changed[0].new_sha, '000000000000')
    assert.equal(compacted.config_changed[0].changed.length, 3)
    assert.equal(compacted.config_changed[0].changed_omitted, 2)
    assert.equal(compacted.config_changed[0].changed_count, 5)
})

test('long row prose in ready_wave and mutables_pending is excerpted', () => {
    assert.ok(compacted.ready_wave[0].subject.length <= 170)
    assert.ok(compacted.mutables_pending[0].subject.length <= 170)
    assert.equal(compacted.ready_wave[0].id, 'fix-upward-shift-glitch')
    assert.equal(compacted.mutables_pending[0].id, 'mutable-one')
})

test('dream_rsi evidence rows collapse to counts', () => {
    assert.deepEqual(compacted.dream_rsi_strategy, {
        selection: 'replay-recorded-successes-first',
        observations: 22,
        succeeded: 19,
        failed: 3,
        gate_drift_failures: 1,
        evidence_rows: 2,
    })
    assert.deepEqual(compacted.dream_rsi_replay, { ok: true, selection: 'continue-current-exploration', score: 0.375, replay_rows: 1 })
})

test('wire_compacted points at the on-disk payload and the opt-out', () => {
    assert.equal(compacted.wire_compacted.full_payload_at, OUT_PATH)
    assert.match(compacted.wire_compacted.full_payload_via, /full_response/)
})

test('failures are never compacted', () => {
    for (const broken of [
        { ok: false, error: 'verb exploded' },
        { error: 'response file was not valid JSON' },
        { timed_out: true, task: 'task-1' },
    ]) {
        assert.equal(compactWireResponse(broken, OUT_PATH), broken)
    }
})

test('compaction does not mutate the payload it was given', () => {
    const before = JSON.stringify(cleaned)
    compactWireResponse(cleaned, OUT_PATH)
    assert.equal(JSON.stringify(cleaned), before)
})

test('a vector_hits list whose rows are all in hits is dropped and disclosed', () => {
    const hit = { key: 'mem-aaaa-1529', namespace: 'default', score: 0.663, text: longProse(900) }
    const out = compactWireResponse({ ok: true, verb: 'recall', hits: [hit], vector_hits: [{ ...hit, distance: 0.337 }] }, OUT_PATH)
    assert.equal('vector_hits' in out, false)
    assert.match(out.wire_compacted.omitted, /vector_hits/)
    assert.equal(out.hits.length, 1)
})

test('a vector_hits list carrying rows that hits does not is kept whole', () => {
    const vectorHits = [{ key: 'mem-zzzz-9000', namespace: 'default', score: 0.2, text: 'unfused' }]
    const out = compactWireResponse({ ok: true, verb: 'recall', hits: [{ key: 'mem-aaaa-1529', score: 0.663 }], vector_hits: vectorHits }, OUT_PATH)
    assert.deepEqual(out.vector_hits, vectorHits)
})

test('a payload with nothing to compact is returned untouched', () => {
    const bare = { ok: true, verb: 'git_status', output: 'clean' }
    assert.equal(compactWireResponse(bare, OUT_PATH), bare)
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
