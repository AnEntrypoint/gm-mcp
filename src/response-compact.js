import { isPlainObject } from './plain-object.js';
import * as yaml from 'js-yaml'
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

const CI_LOG_TEXT_KEYS = new Set(['text'])

const NO_KEYS = new Set()

const NULL_IS_THE_ANSWER_KEYS = new Set(['concurrency_shortfall'])

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
    'candidates',
    'live_rows',
    'launch',
    'bm25_hits',
    'vector_hits',
    'commits',
])

const SEARCH_VERBS = new Set(['codesearch', 'grep', 'codeinsight', 'code_index', 'callers', 'callees', 'impact'])

const INCOMPLETE_SCAN_WHEN_TRUE = ['budget_exhausted', 'timed_out', 'files_truncated', 'listing_incomplete', 'matches_truncated', 'partial']

const INCOMPLETE_SCAN_WHEN_FALSE = ['exhaustive', 'complete']

const SEARCH_SCOPE_SIZE_KEYS = ['files_scanned', 'scanned']

const SEARCH_EMPTY_RESULT_KEYS = ['match_count', 'returned_count', 'files_with_matches']

export const SEARCH_ZERO_FILES_KEY = 'searched_zero_files'

export const SEARCH_UNPROVEN_KEY = 'zero_hits_is_not_a_finding'

NEVER_TRUNCATE_KEYS.add(SEARCH_ZERO_FILES_KEY).add(SEARCH_UNPROVEN_KEY)

function searchScopeSize(source) {
    for (const key of SEARCH_SCOPE_SIZE_KEYS) {
        const value = source[key]
        if (Number.isFinite(value)) return value
    }
    return undefined
}

function incompleteScanReasons(source) {
    const reasons = []
    for (const key of INCOMPLETE_SCAN_WHEN_TRUE) {
        const value = source[key]
        if (value === true) reasons.push(key)
        else if (typeof value === 'string' && value.length > 0) reasons.push(`${key}:${value}`)
    }
    for (const key of INCOMPLETE_SCAN_WHEN_FALSE) if (source[key] === false) reasons.push(`${key}:false`)
    const uncovered = source.uncovered_scan
    if (uncovered && typeof uncovered === 'object' && uncovered.complete === false) reasons.push('uncovered_scan.complete:false')
    return reasons
}

const HIT_COUNT_KEYS = ['comment_count', 'count', 'match_count', 'returned_count', 'files_with_matches']

function searchShowsNoHits(source) {
    if (HIT_COUNT_KEYS.some((key) => Number.isFinite(source[key]) && source[key] > 0)) return false
    if (Array.isArray(source.comments) && source.comments.length > 0) return false
    if (Array.isArray(source.counts) && source.counts.some((row) => Number(row?.count) > 0)) return false
    if (/^[1-9]\d* lines?\b/.test(String(source.count ?? ''))) return false
    if (Array.isArray(source.matches)) return source.matches.length === 0
    if (Array.isArray(source.hits)) return source.hits.length === 0
    if (Number.isFinite(source.comment_count)) return source.comment_count === 0
    const counts = source.counts
    if (isPlainObject(counts)) {
        const definitions = counts.definitions
        const references = counts.references
        if (Number.isFinite(definitions) || Number.isFinite(references)) {
            return (definitions ?? 0) + (references ?? 0) === 0
        }
    }
    for (const key of SEARCH_EMPTY_RESULT_KEYS) {
        const value = source[key]
        if (Number.isFinite(value)) return value === 0
    }
    if (Number.isFinite(source.count)) return source.count === 0
    return true
}

export function withSearchIncompleteness(out) {
    if (!isPlainObject(out)) return out
    const data = isPlainObject(out.data) ? out.data : null
    const verb = typeof out.verb === 'string' ? out.verb : (data && typeof data.verb === 'string' ? data.verb : '')
    if (!SEARCH_VERBS.has(verb)) return out
    const source = data || out
    const scopeSize = searchScopeSize(source)
    if (scopeSize === 0) {
        return {
            [SEARCH_ZERO_FILES_KEY]: true,
            [SEARCH_UNPROVEN_KEY]: 'scanner_zero_files: searched 0 files, not a finding; see gm.help',
            ...out,
        }
    }
    const reasons = verb === 'codesearch' ? codesearchIncompleteReasons(out) : incompleteScanReasons(source)
    if (!reasons.length || !searchShowsNoHits(source)) return out
    return {
        [SEARCH_UNPROVEN_KEY]: `unproven_zero: scan INCOMPLETE (${reasons.join(', ')}); this zero is NOT a finding; see gm.help`,
        ...out,
    }
}

function codesearchIncompleteReasons(out) {
    const data = out.data && typeof out.data === 'object' && !Array.isArray(out.data) ? out.data : {}
    const reasons = []
    if (out.ok === false || out.error !== undefined || data.error !== undefined) reasons.push('error')
    if (searchScopeSize(data) === 0 || searchScopeSize(out) === 0) reasons.push('searched_zero_files')
    for (const source of [out, data]) {
        reasons.push(...incompleteScanReasons(source))
        if (source.stale_tree && typeof source.stale_tree === 'object') reasons.push('stale_tree')
        if (source.truncated === true) reasons.push('truncated')
        if (Number.isFinite(source.dropped) && source.dropped > 0) reasons.push(`dropped:${source.dropped}`)
        if (Array.isArray(source.skipped_files) && source.skipped_files.length > 0) reasons.push('skipped_files')
        for (const [key, value] of Object.entries(source)) {
            if (key.startsWith('files_skipped') && !key.startsWith('files_skipped_binary') && Number.isFinite(value) && value > 0) reasons.push(`${key}:${value}`)
        }
    }
    return [...new Set(reasons)]
}

export const CODESEARCH_COMPLETE_KEY = 'complete'

export const CODESEARCH_COMPLETE_REASON_KEY = 'complete_reason'

export function withCodesearchCompleteness(verb, out) {
    if (verb !== 'codesearch' || !out || typeof out !== 'object' || Array.isArray(out)) return out
    const { [CODESEARCH_COMPLETE_KEY]: _complete, [CODESEARCH_COMPLETE_REASON_KEY]: _reason, ...rest } = out
    const reasons = codesearchIncompleteReasons(out)
    if (!reasons.length) return { [CODESEARCH_COMPLETE_KEY]: true, ...rest }
    const ordered = reasons.includes('stale_tree') ? ['stale_tree', ...reasons.filter(reason => reason !== 'stale_tree')] : reasons
    return {
        [CODESEARCH_COMPLETE_KEY]: false,
        [CODESEARCH_COMPLETE_REASON_KEY]: ordered.join(', '),
        ...rest,
    }
}

const SEARCH_PROSE_NOTICE_KEYS = new Map([
    ['exhaustive_note', 'exhaustive_scope'],
    ['file_source_detail', 'file_source_git'],
])

const CAP_CUT_REASON_RE = /hit cap|match cap|max_matches|matches_truncated/i

function isCapCut(levels) {
    return levels.some(level => isPlainObject(level) && (level.matches_truncated === true || CAP_CUT_REASON_RE.test(String(level.partial_reason ?? ''))))
}

function withNoticeCodesAt(level, capCut) {
    const replaced = {}
    for (const [key, value] of Object.entries(level)) {
        if (key === 'exhaustive_note' && capCut && typeof value === 'string') replaced[key] = 'exhaustive_cap'
        else if (key === 'file_source_detail' && level.file_source !== 'git') replaced[key] = value
        else replaced[key] = SEARCH_PROSE_NOTICE_KEYS.has(key) && typeof value === 'string' ? SEARCH_PROSE_NOTICE_KEYS.get(key) : value
    }
    return replaced
}

export function withNoticeCodes(out) {
    if (!isPlainObject(out)) return out
    const capCut = isCapCut([out, out.data])
    const top = withNoticeCodesAt(out, capCut)
    if (isPlainObject(top.data)) return { ...top, data: withNoticeCodesAt(top.data, capCut) }
    return top
}

const PRD_LISTING_KEYS = new Set(['why', 'hint'])

const PRD_FULL_LISTING_KEYS = new Set(['why', 'hint', 'description'])

const POOL_BRIEF_KEYS = new Set(['brief'])

const HELP_TEXT_KEYS = new Set(['parameters'])

export function untruncatedKeysFor(verb, body) {
    if (body && typeof body === 'object' && body.help === true) return HELP_TEXT_KEYS
    if (verb === 'ci-log' || verb === 'ci_log') return CI_LOG_TEXT_KEYS
    if (verb === 'prd-list') {
        const wholeRow = body && typeof body === 'object' && (typeof body.id === 'string' || body.full === true || body.full === 'true')
        return wholeRow ? PRD_FULL_LISTING_KEYS : PRD_LISTING_KEYS
    }
    if (verb === 'pool-brief') return POOL_BRIEF_KEYS
    const expandsRecall = verb === 'recall' && body && typeof body === 'object' && (body.full === true || typeof body.key === 'string')
    return expandsRecall ? EXPANDED_RECALL_KEYS : NO_KEYS
}

function resolvedInlineMax(inlineMax, key) {
    if (Number.isFinite(inlineMax) && inlineMax > 0) return Math.floor(inlineMax)
    return EXEC_OUTPUT_KEYS.has(key) ? EXEC_OUTPUT_FIELD_TRUNCATE_AT : LONG_TEXT_FIELD_TRUNCATE_AT
}

function cutAtWordBoundary(value, budget) {
    if (value.length <= budget || /\s/.test(value[budget])) return value.slice(0, budget)
    const space = value.slice(0, budget).search(/\s\S*$/)
    return space > budget / 2 ? value.slice(0, space) : value.slice(0, budget)
}

export function truncateLongText(value, key, outPath, plainTextFile, untruncatedKeys = NO_KEYS, inlineMax) {
    if (typeof value !== 'string') return value
    const budget = resolvedInlineMax(inlineMax, key)
    if (EXEC_OUTPUT_KEYS.has(key)) {
        if (value.length <= budget) return value
        const where = plainTextFile
            ? `the full text is in ${plainTextFile}, plain text with a '## ${key}' section, readable directly`
            : `the full output is in ${outPath}, in the JSON string field 'data' (parse it, then read '${key}')`
        return `${cutAtWordBoundary(value, budget)}... [OUTPUT TRUNCATED: showing ${budget} of ${value.length} chars of '${key}' -- ${where}]`
    }
    if (value.length <= budget) return value
    if (NEVER_TRUNCATE_KEYS.has(key) || untruncatedKeys.has(key)) return value
    return `${cutAtWordBoundary(value, budget)}... [${value.length} chars total, full text at ${outPath} field '${key}']`
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
            : (isPlainObject(v)) ? cleanHit(v, outPath, plainTextFile, untruncatedKeys, inlineMax)
            : v
    }
    return out
}

const MATCH_WINDOW_CHARS = 160

function matchWindowed(row) {
    if (typeof row.column !== 'number' || typeof row.text !== 'string' || row.text.length <= LONG_TEXT_FIELD_TRUNCATE_AT) return row
    const start = Math.min(Math.max(0, row.column - 1 - MATCH_WINDOW_CHARS / 2), row.text.length - MATCH_WINDOW_CHARS)
    return { ...row, text: row.text.slice(start, start + MATCH_WINDOW_CHARS) }
}

export function cleanResponse(value, keyHint, outPath, plainTextFile, untruncatedKeys = NO_KEYS, inlineMax) {
    if (Array.isArray(value)) {
        if (HIT_ARRAY_KEYS.has(keyHint)) return dropDuplicateRows(value.map(h => cleanHit(h, outPath, plainTextFile, untruncatedKeys, inlineMax)))
        const cleaned = value.map(v => cleanResponse(v, undefined, outPath, plainTextFile, untruncatedKeys, inlineMax)).filter(v => v !== undefined)
        return dropDuplicateRows(cleaned)
    }
    if (value && typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(matchWindowed(value))) {
            if (NOISE_KEYS.has(k)) continue
            if (v === null && NULL_IS_THE_ANSWER_KEYS.has(k)) {
                out[k] = null
                continue
            }
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
            if (isPlainObject(cleanedV) && Object.keys(cleanedV).length === 0) continue
            out[k] = cleanedV
        }
        return out
    }
    if (typeof value === 'string' && keyHint) return truncateLongText(value, keyHint, outPath, plainTextFile, untruncatedKeys, inlineMax)
    return value
}

const WIRE_EXCERPT_CHARS = 160

const WIRE_EXCERPT_IMMUNE_KEYS = new Set(['id', 'key', 'status', 'session_id', 'verb', 'hint', 'why', 'description'])

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

const WIRE_CODESEARCH_CHANNEL_KEYS = new Set(['bm25_hits', 'vector_hits'])

const WIRE_CODESEARCH_CHANNEL_INLINE_MAX = 20

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
    if (!isPlainObject(row)) return row
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

const WIRE_FIELD_COMPACTORS = new Map([
    ['codeinsight_overview', compactCodeinsightOverview],
    ['codeinsight_start', compactCodeinsightStart],
    ['config_changed', compactConfigChanged],
    ['phase_history', compactPhaseHistory],
    ['supply_chain_scan', compactSupplyChainScan],
])

function sameJsonValue(a, b) {
    if (a === b) return true
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameJsonValue(v, b[i]))
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    return keysA.length === keysB.length
        && keysA.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameJsonValue(a[k], b[k]))
}

function unchangedByCompaction(before, after) {
    return sameJsonValue(before, after)
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

// The reply's own top-level dispatch_id already names the full payload; repeat it only when that is absent.
function fullPayloadIdOf(response) {
    return typeof response.dispatch_id === 'string' && response.dispatch_id.length > 0 ? {} : { full_payload_dispatch_id: null }
}

export function omitRepeatedFaultStdout(response, outPath) {
    if (!isPlainObject(response)) return response
    const omitted = []
    const omitAt = (object, prefix, depth = 0) => {
        if (!isPlainObject(object) || depth >= 32) return object
        let next = object
        if (isPlainObject(object.data)) {
            const data = omitAt(object.data, prefix + 'data.', depth + 1)
            if (data !== object.data) next = { ...object, data }
        }
        if (typeof object.stdout !== 'string'
            || !(object.ok === false || object.error !== undefined || object.error_code !== undefined)) return next
        let parsed
        try { parsed = JSON.parse(object.stdout) } catch { return next }
        if (!isPlainObject(parsed)) return next
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
            ...fullPayloadIdOf(response),
            full_payload_via: WIRE_FULL_PAYLOAD_VIA,
        },
    }
}

function codesearchEnvelopeDuplicates(response, data) {
    const dropped = []
    if (typeof response.complete === 'boolean' && data.complete === response.complete) dropped.push('complete')
    if (typeof data.file_source === 'string' && data.file_source_detail !== undefined) dropped.push('file_source_detail')
    return dropped
}

function compactWireFields(response, outPath, receiptVerb = response?.verb) {
    if (!isPlainObject(response)) return response
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
        let next = omittedSubkeys && isPlainObject(value)
            ? omitKeys(value, omittedSubkeys)
            : value
        const fieldCompactor = WIRE_FIELD_COMPACTORS.get(key)
        if (fieldCompactor) next = fieldCompactor(next)
        else if (WIRE_HIT_ARRAY_KEYS.has(key) && Array.isArray(next)) next = next.slice(0, WIRE_CODESEARCH_CHANNEL_KEYS.has(key) ? WIRE_CODESEARCH_CHANNEL_INLINE_MAX : WIRE_HITS_INLINE_MAX).map(excerptRow)
        else if (WIRE_ROW_ARRAY_KEYS.has(key) && Array.isArray(next)) next = next.map(excerptRow)
        else if (committedGitReceipt && WIRE_GIT_EXCLUSION_KEYS.has(key) && Array.isArray(next)) next = next.slice(0, WIRE_GIT_EXCLUSIONS_INLINE_MAX)
        if (key === 'data' && isPlainObject(next) && response.verb === 'codesearch') {
            const dropped = codesearchEnvelopeDuplicates(response, next)
            if (dropped.length) {
                omitted.push(...dropped.map(k => `data.${k}`))
                next = omitKeys(next, dropped)
            }
        }
        if (key === 'data' && isPlainObject(next)) {
            const inner = compactWireFields(next, outPath, gitReceiptContext ? receiptVerb : null)
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
        ...fullPayloadIdOf(response),
        full_payload_via: WIRE_FULL_PAYLOAD_VIA,
    })
    return out
}

export function compactWireResponse(response, outPath, receiptVerb = response?.verb) {
    const compacted = compactWireFields(response, outPath, receiptVerb)
    if (compacted === response) return response
    return wireTextBytes(compacted) < wireTextBytes(response) ? compacted : response
}

const toYaml = value => yaml.dump(value, { lineWidth: 100 })

function wireTextBytes(value) {
    const text = (value.verb === 'fs_read' ? renderVerbatimFileText(value, toYaml) : undefined) ?? toYaml(value)
    return Buffer.byteLength(text, 'utf8')
}

export const VERBATIM_TEXT_MARKER = '--- data (verbatim, no indentation added) ---'

export function renderVerbatimFileText(out, toYaml) {
    if (!isPlainObject(out)) return undefined
    if (typeof out.data === 'string') {
        const { data, ...rest } = out
        return `${toYaml(rest)}${VERBATIM_TEXT_MARKER}\n${data}`
    }
    if (out.verb === 'fs_read' && isPlainObject(out.data) && typeof out.data.content === 'string') {
        const { data: { content, ...fields }, ...rest } = out
        return `${toYaml({ ...rest, data: fields })}${VERBATIM_TEXT_MARKER}\n${content}`
    }
    if (out.verb === 'fs_read' && typeof out.content === 'string') {
        const { content, ...rest } = out
        return `${toYaml(rest)}${VERBATIM_TEXT_MARKER}\n${content}`
    }
    return undefined
}
