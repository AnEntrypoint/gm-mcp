const NOISE_KEYS = new Set(['request_fingerprint'])

function envPositiveInt(name, fallback) {
    const raw = Number(process.env[name])
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

const LONG_TEXT_INLINE_MAX_CEILING = 1048576

const LONG_TEXT_FIELD_TRUNCATE_AT = Math.min(envPositiveInt('GM_MCP_LONG_TEXT_INLINE_MAX', 400), LONG_TEXT_INLINE_MAX_CEILING)

const PLAIN_TEXT_OUTPUT_INLINE_MAX = Math.min(envPositiveInt('GM_MCP_STDOUT_INLINE_MAX', 32768), LONG_TEXT_INLINE_MAX_CEILING)

const FILE_READ_INLINE_MAX = Math.min(envPositiveInt('GM_MCP_FILE_READ_INLINE_MAX', 65536), LONG_TEXT_INLINE_MAX_CEILING)

export { PLAIN_TEXT_OUTPUT_INLINE_MAX, FILE_READ_INLINE_MAX, LONG_TEXT_INLINE_MAX_CEILING }

const NEVER_TRUNCATE_KEYS = new Set(['error', 'reason', 'residuals', 'dispatch_ledger_error', 'dream_rsi_observation_error', 'detail'])

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

function resolvedInlineMax(inlineMax, key) {
    if (Number.isFinite(inlineMax) && inlineMax > 0) return Math.floor(inlineMax)
    return EXEC_OUTPUT_KEYS.has(key) ? EXEC_OUTPUT_FIELD_TRUNCATE_AT : LONG_TEXT_FIELD_TRUNCATE_AT
}

export function truncateLongText(value, key, outPath, plainTextFile, untruncatedKeys = NO_KEYS, inlineMax) {
    if (typeof value !== 'string') return value
    const budget = resolvedInlineMax(inlineMax, key)
    if (EXEC_OUTPUT_KEYS.has(key)) {
        if (value.length <= budget) return value
        const where = plainTextFile
            ? `the full text is in ${plainTextFile}, plain text with a '## ${key}' section, readable directly`
            : `the full output is in ${outPath}, in the JSON string field 'data' (parse it, then read '${key}')`
        return `${value.slice(0, budget)}... [OUTPUT TRUNCATED: showing ${budget} of ${value.length} chars of '${key}' -- ${where}]`
    }
    if (value.length <= budget) return value
    if (NEVER_TRUNCATE_KEYS.has(key) || untruncatedKeys.has(key)) return value
    return `${value.slice(0, budget)}... [${value.length} chars total, full text at ${outPath} field '${key}']`
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

function cleanHit(hit, outPath, plainTextFile, untruncatedKeys, inlineMax) {
    if (!hit || typeof hit !== 'object') return hit
    const out = {}
    for (const [k, v] of Object.entries(hit)) {
        if (HIT_NOISE_KEYS.has(k)) continue
        if (v === '' || v === null || v === undefined) continue
        out[k] = typeof v === 'string' ? truncateLongText(v, k, outPath, plainTextFile, untruncatedKeys, inlineMax)
            : (v && typeof v === 'object' && !Array.isArray(v)) ? cleanHit(v, outPath, plainTextFile, untruncatedKeys, inlineMax)
            : v
    }
    return out
}

export function cleanResponse(value, keyHint, outPath, plainTextFile, untruncatedKeys = NO_KEYS, inlineMax) {
    if (Array.isArray(value)) {
        if (HIT_ARRAY_KEYS.has(keyHint)) return dropDuplicateRows(value.map(h => cleanHit(h, outPath, plainTextFile, untruncatedKeys, inlineMax)))
        const cleaned = value.map(v => cleanResponse(v, undefined, outPath, plainTextFile, untruncatedKeys, inlineMax)).filter(v => v !== undefined)
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
                if (serialized.length > resolvedInlineMax(inlineMax, k)) {
                    out[k] = truncateLongText(serialized, k, outPath, plainTextFile, NO_KEYS, inlineMax)
                    continue
                }
            }
            const cleanedV = cleanResponse(v, k, outPath, plainTextFile, untruncatedKeys, inlineMax)
            if (Array.isArray(cleanedV) && cleanedV.length === 0 && !EMPTY_LIST_IS_THE_ANSWER_KEYS.has(k)) continue
            if (cleanedV && typeof cleanedV === 'object' && !Array.isArray(cleanedV) && Object.keys(cleanedV).length === 0) continue
            out[k] = cleanedV
        }
        return out
    }
    if (typeof value === 'string' && keyHint) return truncateLongText(value, keyHint, outPath, plainTextFile, untruncatedKeys, inlineMax)
    return value
}

const WIRE_EXCERPT_CHARS = 160

const WIRE_EXCERPT_IMMUNE_KEYS = new Set(['id', 'key', 'status', 'session_id', 'verb'])

const WIRE_OMITTED_KEYS = new Set(['route_hint', 'reply_hash', 'orient_nouns'])

const WIRE_OMITTED_UNLESS_SIBLING_TRUE = new Map([['session_owner_before_this_dispatch', 'session_mismatch']])

const WIRE_OMITTED_WHEN_EVERY_ROW_IS_ALREADY_IN = new Map([
    ['vector_hits', 'hits'],
    ['recall_hits', 'hits'],
    ['bm25_hits', 'hits'],
])

const WIRE_OMITTED_SUBKEYS = new Map([
    ['prd_items_truncated', ['inlined_rows_are']],
    ['mutables_pending_truncated', ['inlined_rows_are']],
])

const WIRE_HIT_ARRAY_KEYS = new Set(['recall_hits', 'bm25_hits', 'vector_hits'])

const WIRE_ROW_ARRAY_KEYS = new Set(['ready_wave', 'prd_items', 'mutables_pending', 'commits'])

const WIRE_HITS_INLINE_MAX = 4

const WIRE_CONFIG_CHANGED_INLINE_MAX = 1

const WIRE_CONFIG_CHANGED_KEYS_INLINE_MAX = 3
const WIRE_PHASE_HISTORY_INLINE_MAX = 5

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

function rowKeys(rows) {
    if (!Array.isArray(rows)) return null
    const keys = []
    for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.key !== 'string') return null
        keys.push(row.key)
    }
    return keys
}

function repeatsRowsOf(response, key, fusedKey) {
    const keys = rowKeys(response[key])
    const fused = rowKeys(response[fusedKey])
    if (!keys || !fused) return false
    return keys.every(k => fused.includes(k))
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

function compactPhaseHistory(rows) {
    return Array.isArray(rows) ? rows.slice(-WIRE_PHASE_HISTORY_INLINE_MAX) : rows
}

const WIRE_SCAN_WARNINGS_INLINE_MAX = 8

function compactSupplyChainScan(scan) {
    if (!scan || typeof scan !== 'object') return scan
    const hasFindings = ['blocked', 'failing', 'warnings', 'symlinkEscapes']
        .some(k => Array.isArray(scan[k]) && scan[k].length > 0)
    if (!hasFindings) return omitFromWire
    const warnings = Array.isArray(scan.warnings) ? scan.warnings : []
    if (warnings.length <= WIRE_SCAN_WARNINGS_INLINE_MAX) return scan
    return {
        ...scan,
        warnings: warnings.slice(0, WIRE_SCAN_WARNINGS_INLINE_MAX),
        warningsOmitted: warnings.length - WIRE_SCAN_WARNINGS_INLINE_MAX,
    }
}

function compactDreamRsiStrategy(strategy) {
    if (!strategy || typeof strategy !== 'object') return strategy
    if (strategy.ok === false || strategy.error !== undefined || strategy.error_code !== undefined) return strategy
    const evidence = Array.isArray(strategy.evidence) ? strategy.evidence : []
    return withoutBlankValues({
        selection: strategy.selection,
        observations: strategy.observation_count,
        succeeded: strategy.successful_dispatch_count,
        failed: strategy.failed_dispatch_count,
        unverified: strategy.unverified_dispatch_count,
        unscored: strategy.unscored_dispatch_count,
        gate_drift_failures: strategy.gate_drift_failure_count,
        evidence_rows: evidence.length,
    })
}

function compactDreamRsiReplay(replay) {
    if (!replay || typeof replay !== 'object') return replay
    if (replay.ok === false || replay.error !== undefined || replay.error_code !== undefined) return replay
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
    ['phase_history', compactPhaseHistory],
    ['supply_chain_scan', compactSupplyChainScan],
    ['dream_rsi_strategy', compactDreamRsiStrategy],
    ['dream_rsi_replay', compactDreamRsiReplay],
])

function unchangedByCompaction(before, after) {
    return JSON.stringify(before) === JSON.stringify(after)
}

const WIRE_GIT_COMMIT_VERBS = new Set(['git_commit', 'git_finalize'])
const WIRE_GIT_EXCLUSION_KEYS = new Set(['excluded', 'excluded_but_dirty'])
const WIRE_GIT_EXCLUSIONS_INLINE_MAX = 5

function gitReceiptCarriesNoFailure(response) {
    return response.error === undefined && response.error_code === undefined
        && response.ok !== false && response.timed_out !== true
        && response.refused !== true && response.status !== 'refused'
        && response.outcome !== 'refused'
}

function countOutputRepeatsStructuredCounts(response) {
    if (response.ok !== true || response.exhaustive !== true || response.output_mode !== 'count'
        || response.error !== undefined || response.error_code !== undefined
        || response.errors !== undefined || response.partial_reason !== undefined
        || response.partial === true || response.complete === false
        || response.timed_out === true || response.refused === true
        || response.status === 'refused' || response.outcome === 'refused') return false
    const { counts, output } = response
    return Array.isArray(counts) && counts.length > 0 && Array.isArray(output)
        && counts.length === output.length && counts.every((row, index) =>
            row && typeof row.path === 'string' && Number.isSafeInteger(row.count) && row.count >= 0
            && output[index] === `${row.path}:${row.count}`)
}


function equalJsonValues(left, right, depth = 0) {
    if (left === right) return true
    if (depth >= 128) return false
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
    if (Array.isArray(left) !== Array.isArray(right)) return false
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && equalJsonValues(left[key], right[key], depth + 1))
}

export function omitRepeatedFaultStdout(response, outPath) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return response
    const omitted = []
    const omitAt = (object, prefix, depth = 0) => {
        if (!object || typeof object !== 'object' || Array.isArray(object) || depth >= 32) return object
        let next = object
        if (object.data && typeof object.data === 'object' && !Array.isArray(object.data)) {
            const data = omitAt(object.data, prefix + 'data.', depth + 1)
            if (data !== object.data) next = { ...object, data }
        }
        if (typeof object.stdout !== 'string'
            || !(object.ok === false || object.error !== undefined || object.error_code !== undefined)) return next
        let parsed
        try { parsed = JSON.parse(object.stdout) } catch { return next }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return next
        const keys = Object.keys(parsed)
        if (!keys.length || !keys.every(key => Object.hasOwn(object, key) && equalJsonValues(parsed[key], object[key]))) return next
        const { stdout, ...rest } = next
        omitted.push(prefix + 'stdout')
        return rest
    }
    const result = omitAt(response, '')
    if (!omitted.length) return response
    return {
        ...result,
        wire_compacted: {
            ...(result.wire_compacted || {}),
            omitted: [result.wire_compacted?.omitted, ...omitted].filter(Boolean).join(' '),
            full_payload_at: outPath,
            full_payload_via: WIRE_FULL_PAYLOAD_VIA,
        },
    }
}

export function compactWireResponse(response, outPath, receiptVerb = response?.verb) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return response
    const gitReceiptContext = WIRE_GIT_COMMIT_VERBS.has(receiptVerb)
        && gitReceiptCarriesNoFailure(response)
    const committedGitReceipt = gitReceiptContext && response.committed === true
    const redundantCountOutput = countOutputRepeatsStructuredCounts(response)
    const omitted = []
    const shortened = []
    const out = {}
    for (const [key, value] of Object.entries(response)) {
        if (key === 'output' && redundantCountOutput) {
            omitted.push(key)
            continue
        }
        if (WIRE_OMITTED_KEYS.has(key)) {
            omitted.push(key)
            continue
        }
        const siblingGate = WIRE_OMITTED_UNLESS_SIBLING_TRUE.get(key)
        if (siblingGate && response[siblingGate] !== true) {
            omitted.push(key)
            continue
        }
        const fusedInKey = WIRE_OMITTED_WHEN_EVERY_ROW_IS_ALREADY_IN.get(key)
        if (fusedInKey && repeatsRowsOf(response, key, fusedInKey)) {
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
        else if (committedGitReceipt && WIRE_GIT_EXCLUSION_KEYS.has(key) && Array.isArray(next)) next = next.slice(0, WIRE_GIT_EXCLUSIONS_INLINE_MAX)
        if (key === 'data' && next && typeof next === 'object' && !Array.isArray(next)) {
            const inner = compactWireResponse(next, outPath, gitReceiptContext ? receiptVerb : null)
            if (inner !== next) {
                const { wire_compacted: innerWire, ...innerRest } = inner
                if (innerWire?.omitted) omitted.push(`data.${innerWire.omitted}`)
                if (innerWire?.shortened) shortened.push(String(innerWire.shortened).split(' ').map(s => `data.${s}`).join(' '))
                next = innerRest
            }
        }
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

export const VERBATIM_TEXT_MARKER = '--- data (verbatim, no indentation added) ---'

export function renderVerbatimFileText(out, toYaml) {
    if (!out || typeof out !== 'object' || Array.isArray(out) || typeof out.data !== 'string') return undefined
    const { data, ...rest } = out
    return `${toYaml(rest)}${VERBATIM_TEXT_MARKER}\n${data}`
}
