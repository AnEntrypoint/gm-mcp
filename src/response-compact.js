const NOISE_KEYS = new Set(['dispatch_id', 'request_fingerprint'])

const LONG_TEXT_FIELD_TRUNCATE_AT = 400

const NEVER_TRUNCATE_KEYS = new Set(['error', 'reason', 'residuals'])

const NO_KEYS = new Set()

const EXPANDED_RECALL_KEYS = new Set(['text'])

const EXEC_OUTPUT_KEYS = new Set(['stdout', 'stderr', 'result'])

const EXEC_OUTPUT_FIELD_TRUNCATE_AT = 16_000

const HIT_ARRAY_KEYS = new Set(['recall_hits', 'bm25_hits', 'vector_hits', 'commits'])

const HIT_NOISE_KEYS = new Set(['cos', 'recency'])

const FALSE_IS_ABSENCE_OF_A_PROBLEM_KEYS = new Set([
    'session_mismatch',
    'instruction_unchanged',
    'instruction_suppressible_by_asserting_hash',
    'recall_embed_failed',
    'should_residual_scan',
    'fsm_graph_rejected',
])

const EMPTY_LIST_IS_THE_ANSWER_KEYS = new Set([
    'edges',
    'reachable',
    'reached',
    'callees',
    'functions',
    'matches',
    'definitions',
    'references',
])

export function untruncatedKeysFor(verb, body) {
    const expandsRecall = verb === 'recall' && body && typeof body === 'object' && (body.full === true || typeof body.key === 'string')
    return expandsRecall ? EXPANDED_RECALL_KEYS : NO_KEYS
}

export function truncateLongText(value, key, outPath, plainTextFile, untruncatedKeys = NO_KEYS) {
    if (typeof value !== 'string') return value
    if (EXEC_OUTPUT_KEYS.has(key)) {
        if (value.length <= EXEC_OUTPUT_FIELD_TRUNCATE_AT) return value
        const where = plainTextFile
            ? `the full text is in ${plainTextFile}, plain text with a '## ${key}' section, readable directly`
            : `the full output is in ${outPath}, in the JSON string field 'data' (parse it, then read '${key}')`
        return `${value.slice(0, EXEC_OUTPUT_FIELD_TRUNCATE_AT)}... [OUTPUT TRUNCATED: showing ${EXEC_OUTPUT_FIELD_TRUNCATE_AT} of ${value.length} chars of '${key}' -- ${where}]`
    }
    if (value.length <= LONG_TEXT_FIELD_TRUNCATE_AT) return value
    if (NEVER_TRUNCATE_KEYS.has(key) || untruncatedKeys.has(key)) return value
    return `${value.slice(0, LONG_TEXT_FIELD_TRUNCATE_AT)}... [${value.length} chars total, full text at ${outPath} field '${key}']`
}

function dropDuplicateRows(rows) {
    const seen = new Set()
    return rows.filter(row => {
        if (!row || typeof row !== 'object') return true
        const fingerprint = JSON.stringify(row)
        if (seen.has(fingerprint)) return false
        seen.add(fingerprint)
        return true
    })
}

function cleanHit(hit, outPath, plainTextFile, untruncatedKeys) {
    if (!hit || typeof hit !== 'object') return hit
    const out = {}
    for (const [k, v] of Object.entries(hit)) {
        if (HIT_NOISE_KEYS.has(k)) continue
        if (v === '' || v === null || v === undefined) continue
        out[k] = typeof v === 'string' ? truncateLongText(v, k, outPath, plainTextFile, untruncatedKeys)
            : (v && typeof v === 'object' && !Array.isArray(v)) ? cleanHit(v, outPath, plainTextFile, untruncatedKeys)
            : v
    }
    return out
}

export function cleanResponse(value, keyHint, outPath, plainTextFile, untruncatedKeys = NO_KEYS) {
    if (Array.isArray(value)) {
        if (HIT_ARRAY_KEYS.has(keyHint)) return dropDuplicateRows(value.map(h => cleanHit(h, outPath, plainTextFile, untruncatedKeys)))
        const cleaned = value.map(v => cleanResponse(v, undefined, outPath, plainTextFile, untruncatedKeys)).filter(v => v !== undefined)
        return dropDuplicateRows(cleaned)
    }
    if (value && typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) {
            if (NOISE_KEYS.has(k)) continue
            if (v === null || v === undefined || v === '') continue
            if (v === false && FALSE_IS_ABSENCE_OF_A_PROBLEM_KEYS.has(k)) continue
            if (plainTextFile && k === 'result' && v && typeof v === 'object') {
                const serialized = JSON.stringify(v)
                if (serialized.length > EXEC_OUTPUT_FIELD_TRUNCATE_AT) {
                    out[k] = truncateLongText(serialized, k, outPath, plainTextFile)
                    continue
                }
            }
            const cleanedV = cleanResponse(v, k, outPath, plainTextFile, untruncatedKeys)
            if (Array.isArray(cleanedV) && cleanedV.length === 0 && !EMPTY_LIST_IS_THE_ANSWER_KEYS.has(k)) continue
            if (cleanedV && typeof cleanedV === 'object' && !Array.isArray(cleanedV) && Object.keys(cleanedV).length === 0) continue
            out[k] = cleanedV
        }
        return out
    }
    if (typeof value === 'string' && keyHint) return truncateLongText(value, keyHint, outPath, plainTextFile, untruncatedKeys)
    return value
}

const WIRE_EXCERPT_CHARS = 160

const WIRE_EXCERPT_IMMUNE_KEYS = new Set(['id', 'key', 'status', 'session_id', 'verb'])

const WIRE_OMITTED_KEYS = new Set(['route_hint', 'reply_hash', 'orient_nouns'])

const WIRE_OMITTED_UNLESS_SIBLING_TRUE = new Map([['session_owner_before_this_dispatch', 'session_mismatch']])

const WIRE_OMITTED_SUBKEYS = new Map([
    ['prd_items_truncated', ['inlined_rows_are']],
    ['mutables_pending_truncated', ['inlined_rows_are']],
])

const WIRE_HIT_ARRAY_KEYS = new Set(['recall_hits', 'bm25_hits', 'vector_hits'])

const WIRE_ROW_ARRAY_KEYS = new Set(['ready_wave', 'prd_items', 'mutables_pending', 'commits'])

const WIRE_HITS_INLINE_MAX = 4

const WIRE_CONFIG_CHANGED_INLINE_MAX = 1

const WIRE_CONFIG_CHANGED_KEYS_INLINE_MAX = 3

const WIRE_FULL_PAYLOAD_VIA = 'dispatch with {"full_response": true}'

const omitFromWire = Symbol('omitFromWire')

function withoutBlankValues(obj) {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined || v === '') continue
        if (Array.isArray(v) && v.length === 0) continue
        out[k] = v
    }
    return out
}

function omitKeys(obj, keys) {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
        if (keys.includes(k)) continue
        out[k] = v
    }
    return out
}

function wireExcerpt(value) {
    if (typeof value !== 'string' || value.length <= WIRE_EXCERPT_CHARS) return value
    return `${value.slice(0, WIRE_EXCERPT_CHARS)}...+${value.length - WIRE_EXCERPT_CHARS}`
}

function excerptRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const out = {}
    for (const [k, v] of Object.entries(row)) out[k] = WIRE_EXCERPT_IMMUNE_KEYS.has(k) ? v : wireExcerpt(v)
    return out
}

function compactCodeinsightOverview(overview) {
    if (!overview || typeof overview !== 'object') return overview
    const coverage = overview.coverage && typeof overview.coverage === 'object' ? overview.coverage : {}
    return withoutBlankValues({
        files: overview.file_count,
        symbols: overview.symbol_count,
        semantic_coverage: coverage.semantic_search_covers_files_fraction,
        available: overview.codeinsight_available,
    })
}

function compactCodeinsightStart(start) {
    if (!start || typeof start !== 'object' || start.ready !== true) return start
    return { ready: true }
}

function compactConfigChanged(rows) {
    if (!Array.isArray(rows)) return rows
    const oldestFirst = [...rows].sort((a, b) => (a?.ts || 0) - (b?.ts || 0))
    return oldestFirst.slice(-WIRE_CONFIG_CHANGED_INLINE_MAX).map(row => {
        const changed = Array.isArray(row?.changed) ? row.changed : []
        const kept = changed.slice(0, WIRE_CONFIG_CHANGED_KEYS_INLINE_MAX)
        return withoutBlankValues({
            tier: row?.tier,
            old_sha: row?.old_sha,
            new_sha: row?.new_sha,
            ts: row?.ts,
            changed_count: row?.changed_count,
            changed: kept.length ? kept : null,
            changed_omitted: changed.length - kept.length,
        })
    })
}

function compactSupplyChainScan(scan) {
    if (!scan || typeof scan !== 'object') return scan
    const hasFindings = ['blocked', 'failing', 'warnings', 'symlinkEscapes']
        .some(k => Array.isArray(scan[k]) && scan[k].length > 0)
    return hasFindings ? scan : omitFromWire
}

function compactDreamRsiStrategy(strategy) {
    if (!strategy || typeof strategy !== 'object') return strategy
    const evidence = Array.isArray(strategy.evidence) ? strategy.evidence : []
    return withoutBlankValues({
        selection: strategy.selection,
        observations: strategy.observation_count,
        succeeded: strategy.successful_dispatch_count,
        failed: strategy.failed_dispatch_count,
        gate_drift_failures: strategy.gate_drift_failure_count,
        evidence_rows: evidence.length,
    })
}

function compactDreamRsiReplay(replay) {
    if (!replay || typeof replay !== 'object') return replay
    const replays = Array.isArray(replay.replays) ? replay.replays : []
    return withoutBlankValues({
        ok: replay.ok,
        selection: replay.selection,
        score: replay.score,
        replay_rows: replays.length,
    })
}

const WIRE_FIELD_COMPACTORS = new Map([
    ['codeinsight_overview', compactCodeinsightOverview],
    ['codeinsight_start', compactCodeinsightStart],
    ['config_changed', compactConfigChanged],
    ['supply_chain_scan', compactSupplyChainScan],
    ['dream_rsi_strategy', compactDreamRsiStrategy],
    ['dream_rsi_replay', compactDreamRsiReplay],
])

function unchangedByCompaction(before, after) {
    return JSON.stringify(before) === JSON.stringify(after)
}

export function compactWireResponse(response, outPath) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return response
    const omitted = []
    const shortened = []
    const out = {}
    for (const [key, value] of Object.entries(response)) {
        if (WIRE_OMITTED_KEYS.has(key)) {
            omitted.push(key)
            continue
        }
        const siblingGate = WIRE_OMITTED_UNLESS_SIBLING_TRUE.get(key)
        if (siblingGate && response[siblingGate] !== true) {
            omitted.push(key)
            continue
        }
        const omittedSubkeys = WIRE_OMITTED_SUBKEYS.get(key)
        let next = omittedSubkeys && value && typeof value === 'object' && !Array.isArray(value)
            ? omitKeys(value, omittedSubkeys)
            : value
        const fieldCompactor = WIRE_FIELD_COMPACTORS.get(key)
        if (fieldCompactor) next = fieldCompactor(next)
        else if (WIRE_HIT_ARRAY_KEYS.has(key) && Array.isArray(next)) next = next.slice(0, WIRE_HITS_INLINE_MAX).map(excerptRow)
        else if (WIRE_ROW_ARRAY_KEYS.has(key) && Array.isArray(next)) next = next.map(excerptRow)
        if (next === omitFromWire) {
            omitted.push(key)
            continue
        }
        out[key] = next
        if (unchangedByCompaction(value, next)) continue
        shortened.push(Array.isArray(value) && Array.isArray(next)
            ? `${key}(${next.length}/${value.length})`
            : key)
    }
    if (!omitted.length && !shortened.length) return response
    out.wire_compacted = withoutBlankValues({
        omitted: omitted.join(' '),
        shortened: shortened.join(' '),
        full_payload_at: outPath,
        full_payload_via: WIRE_FULL_PAYLOAD_VIA,
    })
    return out
}
