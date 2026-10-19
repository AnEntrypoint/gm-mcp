import { isPlainObject } from './plain-object.js';
import { agentplugDir, spoolDirOf, toolsDir } from './paths.js'
import { createHash } from 'node:crypto'
import { spoolFs as fs, spoolSpawn as spawn } from './spool-port.js'
import { claimByCreate, claimByLink, readJsonOrNull, readLockHolderPid, readOwnerText, readPidTsLock, readStatusJson, readTextOrNull, reclaimLockByRename, replaceLockText, writeTextAtomically as writeFileAtomically, SPOOL_DIR_MODE, SPOOL_FILE_MODE } from './spool-store.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { appendDiagnostic } from './server-log.js'
import { recordChild } from './child-ledger.js'
import { bundleDrift, bundleStalenessAnnouncement } from './bundle-drift.js'
import { CONTINUATION_RESERVE_CHARS, CONTINUATION_STOP_VERB, continuedReply, setContinuationStopped } from './continuation.js'
import { maybeStartDevSync } from './dev-sync.js'
import { gitToplevel, runGit } from './git-adapter.js'
import { hiddenDetachedOptions } from './hidden-spawn.js'
import { tableRow } from './verb-table.js'
import { execFileSync } from './process-port.js'
import { cleanResponse, compactWireResponse, omitRepeatedFaultStdout, renderVerbatimFileText, untruncatedKeysFor, withCodesearchCompleteness, withNoticeCodes, withSearchIncompleteness, PLAIN_TEXT_OUTPUT_INLINE_MAX, FILE_READ_INLINE_MAX, LONG_TEXT_INLINE_MAX_CEILING, VERBATIM_TEXT_MARKER } from './response-compact.js'

let inflightDispatches = 0

export function inflightDispatchCount() {
    return inflightDispatches
}

export function dispatchVerdict() {
    return { busy: inflightDispatches > 0, count: inflightDispatches }
}

function projectRootFor(dir) {
    const resolved = path.resolve(dir)
    return gitToplevel(resolved) || resolved
}

const DEFAULT_CWD_ENV_VARS = ['GM_MCP_DEFAULT_CWD']

function gitRootAt(dir) {
    return gitToplevel(dir) === dir ? dir : null
}

const LAST_PROJECT_FILE = 'last-project-root'

let rememberedProjectRoot = null

function rememberProjectRoot(root) {
    if (root === rememberedProjectRoot || gitRootAt(root) !== root) return
    rememberedProjectRoot = root
    try {
        mkdirSync(agentplugDir(), { recursive: true })
        writeFileSync(path.join(agentplugDir(), LAST_PROJECT_FILE), root)
    } catch {}
}

function lastProjectRoot() {
    try {
        const root = readFileSync(path.join(agentplugDir(), LAST_PROJECT_FILE), 'utf8').trim()
        return root && gitRootAt(root) === root ? root : null
    } catch {
        return null
    }
}

function resolveDispatchRoot(cwd) {
    if (typeof cwd === 'string' && cwd.trim()) {
        const root = projectRootFor(cwd.trim())
        rememberProjectRoot(root)
        return { root, root_source: 'cwd' }
    }
    for (const name of DEFAULT_CWD_ENV_VARS) {
        const value = process.env[name]
        if (typeof value !== 'string' || !value.trim()) continue
        const root = gitRootAt(path.resolve(value.trim()))
        if (root) return { root, root_source: `env:${name}` }
    }
    const launched = path.resolve(process.cwd())
    const top = gitToplevel(launched)
    if (top && top === launched) return { root: launched, root_source: 'process_cwd' }
    const remembered = lastProjectRoot()
    if (remembered) return { root: remembered, root_source: 'last_project' }
    return {
        error: 'cwd-required',
        refused_root: launched,
        root_source: 'process_cwd',
        refused_reason: top
            ? `process.cwd() is ${launched}, inside git repository ${top} but not at its root`
            : `process.cwd() is ${launched}, which is not inside a git repository`,
        note: `no cwd was passed, and the server process cwd ${launched} (refused_root) is not a git project root, so this dispatch was refused rather than run in ${launched}/.gm, which would write instruction state, PRD rows and spool files into the wrong project. Pass cwd (the project root containing .gm/exec-spool) on every dispatch, or set GM_MCP_DEFAULT_CWD to one explicit git root for cwd-less calls.`,
        accepted_fields: ['cwd'],
    }
}

const FETCH_PAGE_KEYS = ['offset', 'length', 'len', 'start_line', 'startLine', 'end_line', 'endLine', 'lines', 'line_count', 'lineCount']

function isBoundedPageFetch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false
    if (typeof body.url !== 'string' || body.url === '') return false
    return FETCH_PAGE_KEYS.some((key) => body[key] !== undefined && body[key] !== null && body[key] !== '')
}

function inlineMaxForVerb({ verb, isPlainText, fullResponse, maxChars, body }) {
    const requested = Number(maxChars)
    if (Number.isFinite(requested) && requested > 0) return Math.min(Math.floor(requested), LONG_TEXT_INLINE_MAX_CEILING)
    if (fullResponse) return LONG_TEXT_INLINE_MAX_CEILING
    if (isPlainText) return PLAIN_TEXT_OUTPUT_INLINE_MAX
    if (verb === 'fs_read') return FILE_READ_INLINE_MAX
    if (verb === 'fetch' && isBoundedPageFetch(body)) return FILE_READ_INLINE_MAX
    return undefined
}

const DEFAULT_REPLY_MAX_CHARS = 24000
const REPLY_NOTICE_RESERVE_CHARS = 300

function replyMaxChars(maxChars) {
    const requested = Number(maxChars)
    if (Number.isFinite(requested) && requested > 0) return Math.min(Math.floor(requested), LONG_TEXT_INLINE_MAX_CEILING)
    return DEFAULT_REPLY_MAX_CHARS
}

const FS_READ_RANGE_PAIRS = [['startLine', 'endLine', false], ['start_line', 'end_line', false], ['start', 'end', false], ['from', 'to', false], ['offset', 'limit', true], ['line', 'lines', true]]
const FS_READ_COUNT_KEYS = ['count', 'limit', 'lines']
const FS_READ_END_KEYS = ['endLine', 'end_line', 'end', 'to']
const FS_READ_RANGE_BASIS = '1-based, inclusive on both ends'
const FS_READ_ACCEPTED_KEYS = tableRow('fs_read').aliases
const FS_READ_ACCEPTED_PAIRS = 'startLine/endLine (or start_line/end_line), start/end, start/count, from/to, offset/limit, line/lines'
const FS_READ_KNOWN_NON_RANGE_KEYS = new Set(['path', 'file', 'allowOutsideRoot', 'allow_outside_root', 'session_id', 'max_bytes', 'maxBytes', 'encoding', 'verbose'])
const FS_READ_RANGE_LOOKING_PATTERNS = [
    /^(start|begin|first|from|head|offset)(_?(line|lines|row|rows|index|idx|number|num|no|n))?$/,
    /^(end|last|to|tail|until|thru|through)(_?(line|lines|row|rows|index|idx|number|num|no|n))?$/,
    /^(line|lines|row|rows|limit|count|maxlines|numlines|nlines)$/,
    /^(range|linerange|linesrange|rangestart|rangeend|startline|endline|startrow|endrow)$/,
]

function fsReadUnknownRangeKeys(body) {
    if (!isPlainObject(body)) return []
    return Object.keys(body)
        .filter((key) => !FS_READ_ACCEPTED_KEYS.includes(key) && !FS_READ_KNOWN_NON_RANGE_KEYS.has(key))
        .filter((key) => FS_READ_RANGE_LOOKING_PATTERNS.some((pattern) => pattern.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))))
        .sort()
}

function fsReadUnknownRangeReply(verb, unknown) {
    const named = unknown.map((key) => JSON.stringify(key)).join(', ')
    return {
        ok: false,
        verb,
        error: `fs_read does not recognise the range key(s) ${named}, and an unrecognised range is never dropped silently: the whole file would come back looking like a successful ranged read. Accepted keys are ${FS_READ_ACCEPTED_PAIRS} -- all ${FS_READ_RANGE_BASIS}, and limit/count/lines is a number of lines, not an end line.`,
        unknown_range_keys: unknown,
        accepted_range_keys: FS_READ_ACCEPTED_KEYS,
    }
}

function fsReadLineNumber(value) {
    if (value === undefined || value === null || value === '') return undefined
    const parsed = typeof value === 'number' ? value : Number(String(value).trim())
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function fsReadRequestedRange(body) {
    if (!isPlainObject(body)) return null
    const has = (key) => body[key] !== undefined && body[key] !== null && body[key] !== ''
    const pair = FS_READ_RANGE_PAIRS.find(([first, second]) => has(first) || has(second))
    if (!pair) {
        if (!has('count')) return null
        return { start: 1, end: undefined, count: fsReadLineNumber(body.count) ?? 0, startKey: 'start' }
    }
    const [startKey, endKey, endKeyIsCount] = pair
    let end
    let count
    if (has(endKey)) {
        const value = fsReadLineNumber(body[endKey]) ?? 0
        if (endKeyIsCount) count = value
        else end = value
    }
    if (end === undefined && count === undefined) {
        for (const key of FS_READ_COUNT_KEYS) {
            if (key === endKey || !has(key)) continue
            count = fsReadLineNumber(body[key]) ?? 0
            break
        }
    }
    if (end === undefined && count === undefined) {
        for (const key of FS_READ_END_KEYS) {
            if (key === endKey || !has(key)) continue
            end = fsReadLineNumber(body[key]) ?? 0
            break
        }
    }
    if (end === undefined && count === undefined && has('count') && 'count' !== endKey) count = fsReadLineNumber(body.count) ?? 0
    return { start: fsReadLineNumber(body[startKey]) ?? 1, end, count, startKey }
}

export function fsReadProjectRelativeBody(verb, body, cwd) {
    if (verb !== 'fs_read' || !isPlainObject(body)) return body
    if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) return body
    const root = resolveDispatchRoot(cwd).root
    if (!root) return body
    const rel = path.relative(root, path.resolve(body.path))
    if (!rel || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) return body
    return { ...body, path: rel.split(path.sep).join('/') }
}

const SIBLING_ROOT_READ_VERBS = ['fs_stat', 'fs_readdir']

export function outsideRootReadRefusal(verb, body, cwd) {
    if (!SIBLING_ROOT_READ_VERBS.includes(verb) || !isPlainObject(body)) return null
    if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) return null
    if (body.allowOutsideRoot === true || body.allow_outside_root === true) return null
    const root = resolveDispatchRoot(cwd).root
    if (!root) return null
    const rel = path.relative(root, path.resolve(body.path))
    const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
    if (!outside) return null
    return `${verb} path ${body.path} is outside the project root ${root}: pass allowOutsideRoot:true with the same path to read this sibling root (a read-only verb; allowOutsideRoot never applies to fs_write)`
}

const VERBATIM_HEADER_SCAN_LINES = 12

export function fsWriteEnvelopeDiagnostic(verb, body) {
    if (verb !== 'fs_write' || !isPlainObject(body) || typeof body.content !== 'string') return null
    const head = body.content.split('\n', VERBATIM_HEADER_SCAN_LINES)
    if (!head[0].startsWith('dispatch_id: ') || !head.includes(VERBATIM_TEXT_MARKER)) return null
    return `fs_write refused: content begins with an fs_read reply envelope (a dispatch_id header and the "${VERBATIM_TEXT_MARKER}" line), so writing it would prepend that wrapper to the file. Send only the file text that follows the marker line, which is what fs_read returns in its data.`
}

export function fsReadRangeCanonicalBody(verb, body) {
    if (verb !== 'fs_read') return body
    if (!isPlainObject(body)) return body
    const requested = fsReadRequestedRange(body)
    if (!requested) return body
    const { start, end, count } = requested
    if (start < 1) return body
    if (end !== undefined && end < start) return body
    if (count !== undefined && count < 1) return body
    const canonical = {}
    for (const [key, value] of Object.entries(body)) {
        if (FS_READ_ACCEPTED_KEYS.includes(key)) continue
        canonical[key] = value
    }
    canonical.startLine = start
    const last = end ?? (count === undefined ? undefined : start + count - 1)
    if (last !== undefined) canonical.endLine = last
    return canonical
}

function fsReadReplyFields(out) {
    const nested = out.data
    if (!isPlainObject(nested)) return out
    const { data, ...rest } = out
    return Object.keys(nested).some((key) => key in rest) ? rest : { ...rest, ...nested }
}

function fsReadTruncation(verb, body, out) {
    if (verb !== 'fs_read') return out
    if (!isPlainObject(out) || out.ok === false) return out
    const fields = fsReadReplyFields(out)
    const requested = fsReadRequestedRange(body)
    let requestedLast
    if (requested) {
        if (requested.end !== undefined) requestedLast = requested.end
        else if (requested.count) requestedLast = requested.start + requested.count - 1
    }
    const returnedLast = Number(fields.end_line)
    const returnedStart = Number(fields.start_line)
    const hasReturned = Number.isFinite(returnedLast)
    const clamped = requestedLast !== undefined && hasReturned && returnedLast < requestedLast
    const byteCut = fields.truncated_at_bytes === true
    const extra = { truncated: byteCut || clamped }
    if (requestedLast !== undefined) extra.requested_range = { start_line: requested.start, end_line: requestedLast }
    if (hasReturned) extra.returned_range = { start_line: Number.isFinite(returnedStart) ? returnedStart : requested?.start ?? 1, end_line: returnedLast }
    return { ...out, ...extra }
}

export function applyFsReadRangeFallback(verb, body, out, inlineMax) {
    return fsReadTruncation(verb, body, applyFsReadRangeFallbackRaw(verb, body, out, inlineMax))
}

function fsReadUnrangedPage(out, inlineMax) {
    if (!(inlineMax > 0) || out.ok === false || typeof out.data !== 'string' || out.data.length <= inlineMax) return out
    const lines = out.data.replace(/\n$/, '').split('\n')
    let count = 0
    let size = 0
    while (count < lines.length) {
        const next = size + lines[count].length + (count > 0 ? 1 : 0)
        if (count > 0 && next > inlineMax) break
        size = next
        count += 1
    }
    const more = count < lines.length
    return {
        ...out,
        data: lines.slice(0, count).join('\n'),
        range_basis: FS_READ_RANGE_BASIS,
        total_lines: lines.length,
        start_line: 1,
        end_line: count,
        returned_lines: count,
        has_more_lines: more,
        truncated_at_bytes: more,
        offset: 0,
        ...(more ? { next_start_line: count + 1 } : {}),
    }
}

function applyFsReadRangeFallbackRaw(verb, body, out, inlineMax) {
    if (verb !== 'fs_read') return out
    if (!isPlainObject(out)) return out
    const fields = fsReadReplyFields(out)
    const guestRanged = Number.isFinite(Number(fields.start_line)) || Number.isFinite(Number(fields.returned_lines)) || typeof fields.content === 'string'
    if (guestRanged) return out
    const requested = fsReadRequestedRange(body)
    if (!requested) {
        const unknown = fsReadUnknownRangeKeys(body)
        return unknown.length === 0 ? fsReadUnrangedPage(out, inlineMax) : fsReadUnknownRangeReply(verb, unknown)
    }
    if (out.ok === false) return out
    const requestedNote = `${requested.startKey} ${requested.start}${requested.end !== undefined ? ` to ${requested.end}` : requested.count !== undefined ? ` plus ${requested.count} lines` : ''}`
    if (typeof out.data !== 'string') {
        return {
            ...out,
            range_applied: false,
            range_requested: requestedNote,
            range_note: `this fs_read reply carries no file text to slice, so the whole file would come back while the caller asked for ${requestedNote}; re-read with the same range keys, or drop them to read the whole file`,
        }
    }
    const path = typeof out.path === 'string' ? out.path : String(body?.path ?? 'the file')
    const file = out.data
    const lines = file.length === 0 ? [] : file.replace(/\n$/, '').split('\n')
    const totalLines = lines.length
    const { start, end: requestedEnd, count, startKey } = requested
    if (start < 1) return { ok: false, verb, error: `invalid range: "${startKey}" (${start}) must be at least 1 -- every fs_read range alias is ${FS_READ_RANGE_BASIS}` }
    if (count !== undefined && count < 1) return { ok: false, verb, error: `invalid range: "count" (${count}) must be at least 1 -- limit/count/lines is a number of lines, not an end line` }
    if (totalLines === 0) return { ok: false, verb, error: `invalid range: ${path} has 0 lines, so no line range can be read from it` }
    if (start > totalLines) return { ok: false, verb, error: `invalid range: "${startKey}" (${start}) is past the end of ${path}, which has ${totalLines} lines, so 1-${totalLines} is the whole readable range` }
    if (requestedEnd !== undefined && requestedEnd < start) return { ok: false, verb, error: `invalid range: the last line requested (${requestedEnd}) is before the first line requested (${start}) -- every fs_read range alias is ${FS_READ_RANGE_BASIS}` }
    const end = Math.min(requestedEnd ?? (count ? start + count - 1 : totalLines), totalLines)
    const content = lines.slice(start - 1, end).join('\n')
    return {
        ok: true,
        verb,
        path,
        content,
        total_lines: totalLines,
        range_basis: FS_READ_RANGE_BASIS,
        start_line: start,
        end_line: end,
        returned_lines: content.length === 0 ? 0 : content.split('\n').length,
        has_more_lines: end < totalLines,
        truncated_at_bytes: false,
        offset: start - 1,
        ...(end < requestedEnd ? { end_line_requested: requestedEnd, clamped_to_total_lines: true } : {}),
        ...(end < totalLines ? { next_start_line: end + 1 } : {}),
    }
}

export function fsReadSpillNote(out, text) {
    if (!isPlainObject(out)) return ''
    const total = Number(out.total_lines)
    const start = Number(out.start_line)
    const end = Number(out.end_line)
    const returned = Number(out.returned_lines)
    if (Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(total)) {
        const lines = Number.isFinite(returned) ? returned : (text.length === 0 ? 0 : text.split('\n').length)
        const note = [`spill_range: lines ${start}-${end} of ${total} (1-based, inclusive)`, `spill_lines: ${lines}`]
        if (end < total) note.push(`next_range: {"startLine":${end + 1},"endLine":${total}}`)
        return note.join('\n') + '\n'
    }
    if (out.verb === 'fs_read' && typeof out.data === 'string') {
        const body = out.data.length === 0 ? '' : out.data.replace(/\n$/, '')
        const lines = body.length === 0 ? 0 : body.split('\n').length
        return `spill_range: lines 1-${lines} of ${lines} (1-based, inclusive)\nspill_lines: ${lines}\n`
    }
    return ''
}

function replyMatchesHolder(out) {
    if (Array.isArray(out?.matches)) return out
    if (out?.data !== null && typeof out?.data === 'object' && !Array.isArray(out.data) && Array.isArray(out.data.matches)) return out.data
    return null
}

function declaredMatchesTotal(holder) {
    const omitted = Number(holder?.matches_omitted)
    if (Number.isFinite(omitted)) return omitted
    const artifactCount = Number(holder?.result_artifact?.match_count)
    if (Number.isFinite(artifactCount)) return artifactCount
    const leadingCount = String(holder?.count ?? '').match(/^(\d+)/)
    return leadingCount ? Number(leadingCount[1]) : NaN
}

function scanMatchesTotal(holder, sampleLength) {
    const declared = declaredMatchesTotal(holder)
    return Number.isFinite(declared) && declared > sampleLength ? declared : sampleLength
}

function renderMatchesKept(out, holder, kept, toYaml) {
    const keptMatches = holder.matches.slice(0, kept)
    return holder === out
        ? toYaml({ ...out, matches: keptMatches })
        : toYaml({ ...out, data: { ...out.data, matches: keptMatches } })
}

function matchesCutNotice(matchesReturned, matchesTotal, maxChars) {
    if (matchesTotal === undefined || matchesReturned >= matchesTotal) return ''
    return `matches_truncated: true\nmatches_returned: ${matchesReturned}\nmatches_total: ${matchesTotal}\nmatches_note: matches_cut (${matchesReturned} of ${matchesTotal} shown at max_chars=${maxChars}; see gm.help)\n`
}

function largestMatchesFittingReply(out, holder, maxChars, matchesTotal, toYaml, buildNotice) {
    let low = 0
    let high = holder.matches.length
    while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const head = renderMatchesKept(out, holder, mid, toYaml)
        if (head.length + buildNotice(mid, matchesTotal).length <= maxChars) low = mid
        else high = mid - 1
    }
    return low
}

function capReplyText(text, maxChars, spillPath, out, toYaml, spillNote = '', requestedMaxChars = maxChars) {
    if (text.length <= maxChars) return text
    const holder = typeof toYaml === 'function' ? replyMatchesHolder(out) : null
    const buildNotice = (matchesReturned, matchesTotal, deliveredChars = text.length) => `reply_truncated: true\nreply_chars: ${deliveredChars}\nreply_max_chars: ${maxChars}\nreply_requested_max_chars: ${requestedMaxChars}\nreply_overhead_chars: ${requestedMaxChars - maxChars}\n${requestedMaxChars > maxChars ? `reply_overhead_reason: continuation_reserve_chars (${CONTINUATION_RESERVE_CHARS}, held back for the continuation block)\n` : ''}spill_file: ${spillPath}\n${spillNote}${matchesCutNotice(matchesReturned, matchesTotal, maxChars)}`
    let head = text
    let matchesTotal
    let matchesReturned
    if (holder) {
        matchesTotal = scanMatchesTotal(holder, holder.matches.length)
        matchesReturned = largestMatchesFittingReply(out, holder, maxChars, matchesTotal, toYaml, buildNotice)
        head = renderMatchesKept(out, holder, matchesReturned, toYaml)
    }
    const notice = buildNotice(matchesReturned, matchesTotal)
    const budget = Math.max(0, maxChars - REPLY_NOTICE_RESERVE_CHARS)
    if (head.length > budget) {
        const cut = head.slice(0, budget)
        const lastBreak = cut.lastIndexOf('\n')
        head = lastBreak > 0 ? cut.slice(0, lastBreak + 1) : cut
    }
    const room = Math.max(0, maxChars - notice.length)
    if (head.length > room) {
        const cut = head.slice(0, room)
        const lastBreak = cut.lastIndexOf('\n')
        head = lastBreak > 0 ? cut.slice(0, lastBreak + 1) : cut
    }
    let delivered = head.length + notice.length
    for (let pass = 0; pass < 2; pass++) delivered = head.length + buildNotice(matchesReturned, matchesTotal, delivered).length
    return `${head}${buildNotice(matchesReturned, matchesTotal, delivered)}`
}

function shapeGitStatusReply(verb, body, out) {
    if (verb !== 'git_status' || !isPlainObject(out)) return out
    if (!Array.isArray(out.first_paths)) return out
    const limit = Number(body?.limit)
    const hasLimit = body?.limit !== undefined && Number.isFinite(limit) && limit >= 0
    if (body?.summary === true && !hasLimit) {
        const { first_paths, first_paths_note, ...rest } = out
        return { ...rest, first_paths_omitted: first_paths.length }
    }
    if (hasLimit && out.first_paths.length > limit) {
        return { ...out, first_paths: out.first_paths.slice(0, limit), first_paths_omitted: out.first_paths.length - limit }
    }
    return out
}

export function shapeGitDiffReply(verb, body, out) {
    if (verb !== 'git_diff' || !isPlainObject(out) || typeof out.diff !== 'string') return out
    const limit = Number(body?.limit)
    if (body?.limit === undefined || !Number.isInteger(limit) || limit < 0) return out
    const lines = out.diff.split('\n')
    const hasPatch = lines.some((line) => line.startsWith('diff --git '))
    if (!hasPatch) {
        const rows = lines.filter((line) => / \| /.test(line))
        if (rows.length <= limit) return out
        const kept = new Set(rows.slice(0, limit))
        return { ...out, diff: lines.filter((line) => !/ \| /.test(line) || kept.has(line)).join('\n'), files_omitted: rows.length - limit }
    }
    const sections = out.diff.split(/^(?=diff --git )/m)
    const files = sections.filter((section) => section.startsWith('diff --git ')).length
    if (files <= limit) return out
    let seen = 0
    const kept = sections.filter((section) => {
        if (!section.startsWith('diff --git ')) return true
        seen += 1
        return seen <= limit
    })
    return { ...out, diff: kept.join(''), files_omitted: files - limit }
}

const GIT_SHOW_CAPTURE_LIMIT = /output exceeded the host capture limit/
const GIT_SHOW_INLINE_MAX = 60000

function gitShowCaptureFallback(verb, body, out, root) {
    if (verb !== 'git_show' || !isPlainObject(out) || out.error_code !== 'git_show_rev_unresolved') return out
    if (!GIT_SHOW_CAPTURE_LIMIT.test(String(out.error ?? ''))) return out
    const rev = typeof out.rev === 'string' && out.rev ? out.rev : 'HEAD'
    const repo = typeof out.repo === 'string' && out.repo ? out.repo : root
    const scoped = Array.isArray(body?.paths) ? body.paths : Array.isArray(body?.files) ? body.files : []
    const argv = ['show', '--no-color', '--stat', rev, ...(scoped.length ? ['--', ...scoped] : [])]
    let stat
    try {
        stat = execFileSync('git', argv, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true })
    } catch (error) {
        const detail = String(error?.stderr ?? error?.message ?? '').trim()
        return { ...out, error_code: 'git_show_failed', error: `git ${argv.join(' ')} failed in cwd ${repo}: ${detail}` }
    }
    const truncated = stat.length > GIT_SHOW_INLINE_MAX
    return {
        ok: true,
        verb: 'git_show',
        rev,
        output: truncated ? stat.slice(0, GIT_SHOW_INLINE_MAX) : stat,
        truncated: true,
        truncated_reason: 'the full diff exceeded the host capture limit; output is the commit header and the per-file stat',
        paging: `read one file's diff with git_show {"rev":"${rev}","paths":["<path from the stat>"]}`,
    }
}

function withExecExitVerdict(verb, out) {
    if (!EXEC_FAMILY_VERBS.includes(verb) || !isPlainObject(out)) return out
    const code = isPlainObject(out.data) ? out.data.exit_code : out.exit_code
    if (typeof code !== 'number' || code === 0) return out
    return { ...out, ok: false }
}

function liftStdoutFault(out) {
    if (!isPlainObject(out) || out.ok !== false || (typeof out.error === 'string' && out.error)) return out
    if (typeof out.stdout !== 'string') return out
    let parsed
    try { parsed = JSON.parse(out.stdout) } catch { return out }
    if (!isPlainObject(parsed) || typeof parsed.error !== 'string' || !parsed.error) return out
    return { ...out, error: parsed.error }
}

function withCheckoutCreateHint(verb, body, out) {
    if (verb !== 'git_checkout' || body?.create !== true || !out || typeof out !== 'object' || out.ok !== false) return out
    const branch = typeof body.ref === 'string' ? body.ref : ''
    if (!branch || !/exist/i.test(String(out.error ?? ''))) return out
    return {
        ...out,
        hint: `branch "${branch}" already exists and was not moved. To bring it up to date, fast-forward it with git_merge or git_pull on "${branch}" instead of create:true.`,
    }
}

let counter = 0
function nextN(session_id) {
    counter += 1
    return `${session_id}-${process.pid}-${Date.now()}-${counter}`
}

const UNEXPANDED_INTERPOLATION = /\$\{[^}]*\}|\$\(|\$env:|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|`/i

const SPOOL_COMPONENT_BYTE_LIMITS = {
    verb: 255,
    session_id: 150,
    task: 200,
}

export function unsafeSpoolName(role, value) {
    if (typeof value !== 'string' || !value) return null
    if (value.includes('\0') || /[\r\n]/.test(value) || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
        return `${role} ${JSON.stringify(value)} is not a single spool name component: it carries a NUL byte, a line break, a path separator, or is a dot component`
    }
    const byteLimit = SPOOL_COMPONENT_BYTE_LIMITS[role]
    const byteLength = Buffer.byteLength(value)
    if (byteLength > byteLimit) {
        return `${role} is ${byteLength} UTF-8 bytes, exceeding its ${byteLimit}-byte spool component limit`
    }
    const found = UNEXPANDED_INTERPOLATION.exec(value)
    if (!found) return null
    return `${role} ${JSON.stringify(value)} still carries the unexpanded interpolation ${JSON.stringify(found[0])} -- the spool ABI is in/<verb>/<session_id>-<N>.txt, so this would land as a literal path component that no daemon ever claims; pass the expanded value`
}

function publishSpoolRequest(inDir, inPath, task, body) {
    const unsafe = unsafeSpoolName('task', task)
    if (unsafe) throw new Error(unsafe)
    fs.mkdirSync(inDir, { recursive: true, mode: SPOOL_DIR_MODE })
    const tempPath = path.join(inDir, `.${task}.${process.pid}.${Date.now()}.tmp`)
    try {
        fs.writeFileSync(tempPath, body, { encoding: 'utf8', mode: SPOOL_FILE_MODE })
        fs.linkSync(tempPath, inPath)
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
}

const JSON_CONTROL_CHARACTER_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }

const JSON_OBJECT_TEXT = /^\s*\{/

const ESCAPE_LOOKING_JSON_ERROR = /Bad escaped character|Unterminated string|Unexpected non-whitespace|Unexpected token|Expected ',' or '\}'/

function nextNonWhitespaceIndex(text, from) {
    for (let index = from; index < text.length; index += 1) {
        const character = text[index]
        if (character !== ' ' && character !== '\n' && character !== '\r' && character !== '\t') return index
    }
    return -1
}

function keyTokenFollows(text, from) {
    const quote = nextNonWhitespaceIndex(text, from)
    if (quote < 0 || text[quote] !== '"') return false
    let index = quote + 1
    while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index += 1
        index += 1
    }
    const colon = nextNonWhitespaceIndex(text, index + 1)
    return colon >= 0 && text[colon] === ':'
}

function closesEveryOpenContainer(text, fromIndex, openContainers) {
    let index = fromIndex
    for (let depth = openContainers.length; depth > 0; depth -= 1) {
        const closer = openContainers[depth - 1] === '{' ? '}' : ']'
        if (index < 0 || index >= text.length || text[index] !== closer) return false
        index = nextNonWhitespaceIndex(text, index + 1)
    }
    return index < 0
}

function stringLiteralEndsAt(text, quoteIndex, openContainers) {
    const next = nextNonWhitespaceIndex(text, quoteIndex + 1)
    if (next < 0) return true
    const character = text[next]
    if (character === ':') return true
    if (character === ',') return keyTokenFollows(text, next + 1)
    if (character === '}' || character === ']') return closesEveryOpenContainer(text, next, openContainers)
    return false
}

function repairedJsonStringLiterals(text) {
    let out = ''
    let inString = false
    let escaped = false
    const openContainers = []
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (!inString) {
            if (character === '{' || character === '[') openContainers.push(character)
            else if ((character === '}' || character === ']') && openContainers.length > 0) openContainers.pop()
            if (character === '"') inString = true
            out += character
            continue
        }
        if (escaped) {
            out += character
            escaped = false
            continue
        }
        if (character === '\\') {
            out += character
            escaped = true
            continue
        }
        if (character !== '"') {
            const code = character.charCodeAt(0)
            out += code >= 0x20 ? character : JSON_CONTROL_CHARACTER_ESCAPES[character] || `\\u${code.toString(16).padStart(4, '0')}`
            continue
        }
        if (stringLiteralEndsAt(text, index, openContainers)) {
            out += character
            inString = false
            continue
        }
        out += '\\"'
    }
    return out
}

function decodedJsonText(text) {
    try {
        return { value: JSON.parse(text) }
    } catch {
        const repaired = repairedJsonStringLiterals(text)
        try {
            return { value: JSON.parse(repaired) }
        } catch (error) {
            return { error, scanned: repaired }
        }
    }
}

function jsonFieldCoveringPosition(text, position) {
    let key = null
    let keyStart = -1
    let valueStart = -1
    let expectingKey = true
    let inString = false
    let escaped = false
    let depth = 0
    const openContainers = []
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (inString) {
            if (escaped) {
                escaped = false
            } else if (character === '\\') {
                escaped = true
            } else if (character === '"') {
                inString = false
                if (depth === 1 && keyStart >= 0 && key === null) key = text.slice(keyStart + 1, index)
            }
            continue
        }
        if (character === '"') {
            if (depth === 1 && expectingKey) {
                keyStart = index
                expectingKey = false
            }
            inString = true
            continue
        }
        if (character === '{' || character === '[') {
            if (depth === 1 && valueStart >= 0) openContainers.push(key)
            depth += 1
            continue
        }
        if (character === '}' || character === ']') {
            depth -= 1
            if (depth > 1) continue
            if (depth === 1) {
                openContainers.pop()
                continue
            }
            if (valueStart >= 0 && key && position >= valueStart && position <= index) return key
            valueStart = -1
            key = null
            expectingKey = true
            continue
        }
        if (character === ':' && depth === 1 && key !== null && valueStart < 0) {
            valueStart = index + 1
            continue
        }
        if (character === ',' && depth === 1) {
            if (valueStart >= 0 && key && position >= valueStart && position <= index) return key
            valueStart = -1
            key = null
            expectingKey = true
        }
    }
    if (valueStart >= 0 && key && position >= valueStart) return key
    return null
}

export function normalizedObjectBody(verb, body) {
    if (body === undefined || body === null) return { value: {} }
    if (typeof body === 'string') {
        const decoded = decodedJsonText(body)
        if (decoded.value === undefined) {
            if (!JSON_OBJECT_TEXT.test(body)) return { rawText: body }
            const position = Number((/at position (\d+)/.exec(decoded.error.message) || [])[1])
            const field = Number.isInteger(position) ? jsonFieldCoveringPosition(decoded.scanned, position) : null

            const repairHint = ESCAPE_LOOKING_JSON_ERROR.test(decoded.error.message)
                ? 'a backslash or a double quote inside a JSON string body must itself be escaped: one backslash is written \\\\ and one quote is written \\", so a regex like \\} has to reach the body as \\\\}; the same value is far simpler as an object body, where the client escapes it for you'
                : 'quote each newline as \\n inside the JSON string (or pass the lines as an array), or pass body as an object instead of a JSON string'
            return { error: `${verb} body${field ? `.${field}` : ''} is not valid JSON: ${decoded.error.message}. Repair it: ${repairHint}.` }
        }
        if (!isPlainObject(decoded.value)) {
            return { error: `${verb} body string must decode to a JSON object; received ${Array.isArray(decoded.value) ? 'an array' : typeof decoded.value}.` }
        }
        return { value: decoded.value }
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
        return { error: `${verb} body must be a JSON object; received ${Array.isArray(body) ? 'an array' : typeof body}. Arguments go in the body field as one JSON object, e.g. body: {"path": "src/index.js"}.` }
    }
    return { value: body }
}

const CODESEARCH_INTEGER_FIELDS = ['limit', 'head_limit', 'k', 'max_results', 'maxResults', 'max_matches', 'max_files', 'max_chars', 'timeout_ms']
const CODESEARCH_BOOLEAN_FIELDS = ['case_insensitive', 'whole_word', 'comments_only']

function withCodesearchScalarsCoerced(verb, body) {
    if (verb !== 'codesearch') return body
    const coerced = { ...body }
    if (coerced.ignore_case !== undefined) {
        if (coerced.case_insensitive === undefined) coerced.case_insensitive = coerced.ignore_case
        delete coerced.ignore_case
    }
    for (const field of CODESEARCH_INTEGER_FIELDS) {
        if (typeof coerced[field] === 'string' && /^[0-9]+$/.test(coerced[field].trim())) coerced[field] = Number(coerced[field])
    }
    for (const field of CODESEARCH_BOOLEAN_FIELDS) {
        if (coerced[field] === 'true' || coerced[field] === 'false') coerced[field] = coerced[field] === 'true'
    }
    return coerced
}

const CODESEARCH_DEFAULT_K = 50
const CODESEARCH_PATH_ALIASES = ['path', ...tableRow('codesearch').body.fields.path.aliases]

// The guest scopes only the literal fallback of mode dual, so a dual scan runs unscoped here and its ranked hits are kept under the path.
export function withCodesearchDualPathRouted(verb, body, cwd) {
    if (verb !== 'codesearch' || !isPlainObject(body) || body.mode !== 'dual') return { body, scope: null }
    const key = CODESEARCH_PATH_ALIASES.find((name) => typeof body[name] === 'string' && body[name].trim() !== '')
    if (key === undefined) return { body, scope: null }
    let scope = body[key].trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    const root = typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : ''
    if (root && scope.startsWith('/')) {
        if (scope === root) scope = ''
        else if (scope.startsWith(`${root}/`)) scope = scope.slice(root.length + 1)
    }
    const routed = { ...body }
    for (const name of CODESEARCH_PATH_ALIASES) delete routed[name]
    return { body: routed, scope: scope === '' || scope === '.' ? null : scope }
}

const DUAL_SCOPE_CHANNELS = ['hits', 'bm25_hits', 'vector_hits', 'definitions', 'references', 'files', 'top_files']

function dualHitPath(hit) {
    const raw = typeof hit === 'string' ? hit : isPlainObject(hit) ? (hit.at ?? hit.path) : undefined
    if (typeof raw !== 'string') return undefined
    const located = /^(.*?):\d+(?::|$)/.exec(raw)
    return (located ? located[1] : raw.replace(/\s+\(\d+\)$/, '')).replace(/^(\.\/)+/, '')
}

export function withCodesearchDualPathScope(scope, out) {
    if (!scope || !isPlainObject(out)) return out
    const inScope = (hit) => {
        const hitPath = dualHitPath(hit)
        return hitPath !== undefined && (hitPath === scope || hitPath.startsWith(`${scope}/`))
    }
    let kept = 0
    let dropped = 0
    const scopeChannels = (source) => {
        const next = { ...source }
        for (const channel of DUAL_SCOPE_CHANNELS) {
            if (!Array.isArray(source[channel])) continue
            next[channel] = source[channel].filter(inScope)
            kept += next[channel].length
            dropped += source[channel].length - next[channel].length
        }
        return next
    }
    const scoped = scopeChannels(out)
    if (isPlainObject(out.data)) scoped.data = scopeChannels(out.data)
    scoped.path_scope = { path: scope, applied: 'post-filter', kept, dropped }
    return scoped
}
const CODESEARCH_DEFAULT_K_MODES = new Set(['literal', 'regex', 'filename'])
const CODESEARCH_K_ALIASES = ['k', ...tableRow('codesearch').body.fields.k.aliases]

export function withCodesearchDefaultK(verb, body) {
    if (verb !== 'codesearch' || !isPlainObject(body)) return { body, defaulted: false }
    if (!CODESEARCH_DEFAULT_K_MODES.has(body.mode)) return { body, defaulted: false }
    if (CODESEARCH_K_ALIASES.some((key) => body[key] !== undefined)) return { body, defaulted: false }
    return { body: { ...body, k: CODESEARCH_DEFAULT_K }, defaulted: true }
}

export function withCodesearchDefaultKHint(defaulted, verb, out) {
    if (!defaulted || verb !== 'codesearch' || !isPlainObject(out)) return out
    const nested = isPlainObject(out.data) && Array.isArray(out.data.matches)
    const source = nested ? out.data : out
    if (!Array.isArray(source.matches)) return out
    const shown = source.matches.length
    const total = Number(/^(\d+) lines?\b/.exec(String(source.count ?? ''))?.[1] ?? shown)
    if (shown === 0 || total <= shown) return out
    const hint = {
        shown,
        total,
        default_k: CODESEARCH_DEFAULT_K,
        hint: `showing ${shown} of ${total} matches (default k=${CODESEARCH_DEFAULT_K}): raise k (0 = all) or scope with path/glob`,
    }
    return nested ? { ...out, data: { ...out.data, ...hint } } : { ...out, ...hint }
}

function withQuietAdmission(out) {
    if (!isPlainObject(out)) return out
    const waited = Number(out.admission_waited_ms)
    const quiet = (out.admission_decision === undefined || out.admission_decision === 'admitted') && !(waited > 0)
    if (!quiet) return out
    const { admission_band, admission_decision, admission_waited_ms, ...rest } = out
    return rest
}

const RESULT_CHUNK_DEFAULT_CHARACTERS = 12000
const RESULT_CHUNK_MAX_CHARACTERS = 16000
const RESULT_FILE_MAX_BYTES = 4 * 1024 * 1024
const RESULT_READ_CHUNK_BYTES = 64 * 1024
const REPLY_SPILL_SUFFIX = '.reply.txt'

function isSpoolOutDirectory(dir) {
    return path.basename(dir) === 'out'
        && path.basename(path.dirname(dir)) === 'exec-spool'
        && path.basename(path.dirname(path.dirname(dir))) === '.gm'
}

function spoolFileCandidates(root, file) {
    const exact = spoolExactCandidates(root, file)
    return exact.flatMap(candidate => candidate.endsWith(REPLY_SPILL_SUFFIX) ? [candidate] : [candidate, candidate + REPLY_SPILL_SUFFIX])
}

function spoolExactCandidates(root, file) {
    if (path.isAbsolute(file)) return [path.resolve(file)]
    const underRoot = path.resolve(root, file)
    const bare = !/[\\/]/.test(file)
    return bare ? [underRoot, path.resolve(root, '.gm', 'exec-spool', 'out', file)] : [underRoot]
}

function validateSpoolFile(candidate) {
    const dir = path.dirname(candidate)
    if (!isSpoolOutDirectory(dir)) throw new Error(`spool file must name a file inside a .gm/exec-spool/out directory: ${candidate}`)
    if (!fs.existsSync(candidate)) throw new Error(`spool file does not exist: ${candidate}`)
    const before = fs.lstatSync(candidate)
    if (!before.isFile() || before.nlink !== 1) throw new Error('spool file must be an unlinked regular spool file')
    const resolvedOutDir = fs.realpathSync(dir)
    const resolvedFile = fs.realpathSync(candidate)
    if (!isSpoolOutDirectory(resolvedOutDir) || path.dirname(resolvedFile) !== resolvedOutDir) {
        throw new Error(`spool file resolves outside the .gm/exec-spool/out directory that names it: ${candidate}`)
    }
    return { candidate, before }
}

function spoolFilePath(root, file) {
    const named = String(file ?? '')
    if (!named) throw new Error('spool file must name a file inside a .gm/exec-spool/out directory')
    if (named.split(/[\\/]+/).includes('..')) throw new Error('spool file must name a file inside a .gm/exec-spool/out directory: ".." is not allowed')
    let failure
    for (const candidate of spoolFileCandidates(root, named)) {
        try {
            return validateSpoolFile(candidate)
        } catch (error) {
            if (!failure || !candidate.endsWith(REPLY_SPILL_SUFFIX)) failure = error
        }
    }
    throw failure
}

function statOrUndefined(candidate) {
    try {
        return fs.statSync(candidate)
    } catch {
        return undefined
    }
}

function openSpoolRegularFile(root, file) {
    const { candidate, before } = spoolFilePath(root, file)
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
        const opened = fs.fstatSync(fd)
        if (!opened.isFile() || opened.nlink !== 1) throw new Error('spool file must be an unlinked regular spool file')
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('spool file changed while opening')
        if (opened.size > RESULT_FILE_MAX_BYTES) throw new Error(`spool file exceeds ${RESULT_FILE_MAX_BYTES} byte limit`)
        const stillNamed = statOrUndefined(candidate)
        if (!stillNamed || stillNamed.dev !== opened.dev || stillNamed.ino !== opened.ino) {
            throw new Error(`spool file is outside the GM output spool: ${candidate} no longer names the file that was opened`)
        }
        return { fd, file: candidate, size: opened.size, mtimeMs: opened.mtimeMs }
    } catch (error) {
        fs.closeSync(fd)
        throw error
    }
}

function openResultFile(root, resultFile) {
    return openSpoolRegularFile(root, resultFile)
}

function readAllBounded(fd, size) {
    const buffer = Buffer.allocUnsafe(size)
    let position = 0
    while (position < size) {
        const read = fs.readSync(fd, buffer, position, size - position, position)
        if (read === 0) break
        position += read
    }
    return buffer.subarray(0, position).toString('utf8')
}

function readUtf8Page(fd, size, offset, limit) {
    const decoder = new TextDecoder()
    const buffer = Buffer.allocUnsafe(Math.min(RESULT_READ_CHUNK_BYTES, Math.max(size, 1)))
    let position = 0
    let totalCharacters = 0
    let content = ''
    const consume = text => {
        const remaining = limit - content.length
        if (remaining > 0 && totalCharacters + text.length > offset) {
            const start = Math.max(0, offset - totalCharacters)
            content += text.slice(start, start + remaining)
        }
        totalCharacters += text.length
    }
    while (position < size) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
        if (read === 0) break
        position += read
        consume(decoder.decode(buffer.subarray(0, read), { stream: true }))
    }
    consume(decoder.decode())
    const nextOffset = offset + limit < totalCharacters ? offset + limit : undefined
    return { content, totalCharacters, nextOffset }
}

function resultField(value, field) {
    const segments = field.split('.').filter(Boolean)
    const atPath = (candidate, candidateSegments) => {
        let current = candidate
        for (const segment of candidateSegments) {
            if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
            current = current[segment]
        }
        return current
    }
    const direct = atPath(value, segments)
    if (direct !== undefined) return { value: direct, path: field }
    if (value && typeof value === 'object' && value.data && typeof value.data === 'object') {
        const nested = atPath(value.data, segments)
        if (nested !== undefined) return { value: nested, path: `data.${field}` }
    }
    const keysOf = o => (o && typeof o === 'object' ? Object.keys(o).join(', ') : '')
    const dataKeys = value && value.data && typeof value.data === 'object' ? keysOf(value.data) : ''
    const available = `top-level keys: [${keysOf(value)}]${dataKeys ? `; data keys: [${dataKeys}]` : ''}`
    throw new Error(`field "${field}" was not found; ${available}; omit field to read the complete raw response`)
}

function parseResultDocument(text) {
    const body = text.replace(/^﻿/, '').replace(/^\s*---[ \t]*\r?\n/, '')
    try {
        return JSON.parse(body)
    } catch (jsonError) {
        let parsed
        try {
            parsed = yaml.load(body)
        } catch {
            throw jsonError
        }
        if (!isPlainObject(parsed)) throw jsonError
        return parsed
    }
}

function wholeNumber(value) {
    if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return Number(value.trim())
    return undefined
}

export function gmResult({ result_file, field, offset = 0, limit = RESULT_CHUNK_DEFAULT_CHARACTERS, cwd, root, projectPath }) {
    const namedRoot = [cwd, root, projectPath].find(value => typeof value === 'string' && value.trim())
    const rootDir = namedRoot ? path.resolve(namedRoot.trim()) : path.resolve(process.cwd())
    const toYaml = value => yaml.dump(value, { lineWidth: 100 })
    if (typeof result_file !== 'string' || !result_file) return toYaml({ error: 'result_file required' })
    if (field !== undefined && (typeof field !== 'string' || !field)) return toYaml({ error: 'field must be a non-empty string when provided' })
    const pageOffset = wholeNumber(offset)
    const pageLimit = wholeNumber(limit)
    if (pageOffset === undefined || pageOffset < 0) return toYaml({ error: 'offset must be a non-negative integer' })
    if (pageLimit === undefined || pageLimit < 1 || pageLimit > RESULT_CHUNK_MAX_CHARACTERS) return toYaml({ error: `limit must be an integer from 1 through ${RESULT_CHUNK_MAX_CHARACTERS}` })
    try {
        const { fd, file, size } = openResultFile(rootDir, result_file)
        try {
            let content
            let totalCharacters
            let nextOffset
            let resolvedField
            if (field) {
                const selected = resultField(parseResultDocument(readAllBounded(fd, size)), field)
                content = JSON.stringify(selected.value, null, 2)
                resolvedField = selected.path
                totalCharacters = content.length
                nextOffset = pageOffset + pageLimit < totalCharacters ? pageOffset + pageLimit : undefined
            } else {
                ({ content, totalCharacters, nextOffset } = readUtf8Page(fd, size, pageOffset, pageLimit))
            }
            const page = field ? content.slice(pageOffset, pageOffset + pageLimit) : content
            return toYaml({
                result_file: file,
                ...(resolvedField ? { field: resolvedField } : {}),
                offset: pageOffset,
                returned_characters: page.length,
                total_characters: totalCharacters,
                ...(nextOffset === undefined ? { complete: true } : { next_offset: nextOffset }),
                content: page,
            })
        } finally {
            fs.closeSync(fd)
        }
    } catch (error) {
        return toYaml({ error: `result_file could not be read: ${error.message}` })
    }
}

const PLAIN_TEXT_BODY_FIELDS = ['raw_body', 'code', 'script', 'command', 'source', 'text', 'body']

function plainTextFromBody(body) {
    if (typeof body === 'string') return body
    if (!isPlainObject(body)) return undefined
    const present = PLAIN_TEXT_BODY_FIELDS.filter(field => typeof body[field] === 'string')
    if (present.length === 0) return undefined
    const chosen = present[0]
    if (present.length > 1 && present.some(field => body[field] !== body[chosen])) {
        appendDiagnostic('plain-text-body-field-chosen', { chosen, present })
    }
    return body[chosen]
}

const GLOB_FILTER_FIELDS = ['glob', 'path_glob', 'include']
const GLOB_EXCLUDE_FIELDS = ['exclude_glob', 'exclude_globs']

export function withGlobFiltersCoerced(verb, body) {
    if (!body || typeof body !== 'object') return { value: body }
    const coerced = { ...body }
    for (const field of [...GLOB_FILTER_FIELDS, ...GLOB_EXCLUDE_FIELDS]) {
        const value = coerced[field]
        if (value === null || value === undefined) continue
        const single = `${verb} body.${field}`
        if (typeof value === 'string') {
            const trimmed = value.trim()
            if (!trimmed) return { error: `${single} is an empty string -- a blank glob is dropped before the scan runs, so it silently searched everything; omit the field to search unscoped` }
            coerced[field] = trimmed
            continue
        }
        if (!Array.isArray(value)) {
            return { error: `${single} must be a string or an array of strings; received ${typeof value}. This filter takes one glob, e.g. {"${field}":"**/*.rs"} or {"${field}":["**/*.rs","!**/dist/**"]}` }
        }
        if (value.length === 0) return { error: `${single} is an empty array -- a blank glob is dropped before the scan runs; omit the field to search unscoped` }
        const patterns = []
        for (const element of value) {
            if (typeof element !== 'string' || !element.trim()) {
                return { error: `${single} is an array whose entries must all be non-empty glob strings; received ${JSON.stringify(element)}` }
            }
            patterns.push(element.trim())
        }
        coerced[field] = patterns
    }
    return { value: coerced }
}

const PRD_ADD_SLUG_SOURCE_FIELDS = ['subject', 'title', 'name', 'task', 'goal', 'description', 'notes']
const PRD_ADD_MINIMAL_BODY = '{"id":"kebab-case-slug","subject":"one line of intent"}'

function prdAddIdDiagnostic(body) {
    if (body.help === true) return undefined
    if (typeof body.id === 'string') {
        if (body.id.trim()) return undefined
        return `prd-add requires a non-empty body.id: body.id is present but blank. Send ${PRD_ADD_MINIMAL_BODY}, or drop id and send {"subject":"one line of intent"} so the id is derived from it. Send {"help": true} for every field.`
    }
    if (PRD_ADD_SLUG_SOURCE_FIELDS.some(field => typeof body[field] === 'string' && body[field].trim())) return undefined
    return `prd-add requires body.id -- the missing key is "id". Send ${PRD_ADD_MINIMAL_BODY}, or omit id and send {"subject":"one line of intent"}: the id is then derived from the first non-empty one of ${PRD_ADD_SLUG_SOURCE_FIELDS.join(', ')}, and a body with no text anywhere cannot derive one. Send {"help": true} for every field.`
}

function objectBodyDiagnostic(verb, body) {
    if (verb === 'prd-add') return prdAddIdDiagnostic(body)
    if (verb !== 'git_merge' || typeof body.ref === 'string' && body.ref.trim()) return undefined
    if (typeof body.branch === 'string' && body.branch.trim()) {
        return 'git_merge requires body.ref. body.branch is not a git_merge field; call again with {"ref":"' + body.branch + '"}.'
    }
    return 'git_merge requires a non-empty body.ref, for example {"ref":"origin/main"}.'
}

const RUNNER_DIR = toolsDir()
const RUNNER_PATH = path.join(RUNNER_DIR, process.platform === 'win32' ? 'agentplug-runner.exe' : 'agentplug-runner')
const AGENTPLUG_DIR = agentplugDir()
const GLOBAL_DAEMON_STATUS_PATH = path.join(AGENTPLUG_DIR, 'daemon-status.json')
const GLOBAL_DAEMON_OWNER_LOCK_PATH = path.join(AGENTPLUG_DIR, 'daemon-owner.lock')
const GLOBAL_DAEMON_LOG_PATH = path.join(AGENTPLUG_DIR, 'daemon.log')

const ENSURE_INTERVAL_MS = 2_000
const ENSURE_LEASE_MS = 3_000
const ENSURE_BOOT_GRACE_MS = 30_000
const WATCHDOG_INTERVAL_MS = 5_000
const lastEnsuredAtByRoot = new Map()
const watchdogTimersByRoot = new Map()

function runnerBinaryMissing() {
    return !fs.existsSync(RUNNER_PATH)
}

function readJsonFile(filePath) {
    return readJsonOrNull(filePath)
}

export function pidAlive(pid) {
    const value = Number(pid)
    if (!Number.isInteger(value) || value <= 0) return null
    try {
        process.kill(value, 0)
        return true
    } catch (error) {
        return error?.code === 'EPERM' ? true : false
    }
}

function globalDaemonPid() {
    const status = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    if (pidAlive(status?.pid) === true) return status.pid
    try {
        const ownerText = readOwnerText(GLOBAL_DAEMON_OWNER_LOCK_PATH)
        if (!/^[1-9][0-9]*$/.test(ownerText)) return null
        const owner = Number(ownerText)
        if (pidAlive(owner) === true) return owner
    } catch {
    }
    return null
}

export function daemonBootGraceActive() {
    const status = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    const bootTs = status?.daemon_boot_ts
    const age = timestampAgeMs(bootTs)
    if (age === null || age < -DAEMON_TIMESTAMP_FUTURE_SKEW_MS || age >= ENSURE_BOOT_GRACE_MS) return false
    return globalDaemonPid() !== null || isFreshDaemonTimestamp(status.ts)
}

export function liveDaemonSweepsProject(spoolDir) {
    const status = readJsonFile(path.join(spoolDir, '.status.json'))
    if (!status) return false
    if (status.pid === undefined) return isFreshDaemonTimestamp(status.ts)
    if (pidAlive(status.pid) !== true) return sharedDaemonWillSweep()
    if (isFreshDaemonTimestamp(status.ts)) return true
    const globalStatus = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    return Number(globalStatus?.pid) === Number(status.pid) || Number(status.pid) === globalDaemonPid()
}

function sharedDaemonWillSweep() {
    const sharedPid = globalDaemonPid()
    if (sharedPid === null) return false
    return isFreshDaemonTimestamp(readJsonFile(GLOBAL_DAEMON_STATUS_PATH)?.ts)
}

const LEASES_DIR = path.join(AGENTPLUG_DIR, 'leases')

export function ensureAgentLease(root, session_id) {
    const entry = path.resolve(root)
    const key = leaseKeyFor(entry)
    const file = path.join(LEASES_DIR, `${key}.${process.pid}.lease`)
    try {
        if (!fs.existsSync(file)) {
            fs.mkdirSync(LEASES_DIR, { recursive: true })
            writeFileAtomically(file, entry)
            appendDiagnostic('lease-attached', { root: entry, pid: process.pid, lease_file: file })
        }
        if (session_id) recordLeaseSession(key, process.pid, session_id)
    } catch (error) {
        appendDiagnostic('lease-write-failed', { root: entry, error: String(error?.message || error) })
    }
}

function refreshCallerHeartbeat(root, session_id) {
    const heartbeat = path.join(root, '.gm', 'pool', `${session_id}.live`)
    try {
        const now = new Date()
        fs.utimesSync(heartbeat, now, now)
    } catch (error) {
        if (error?.code !== 'ENOENT') appendDiagnostic('heartbeat-refresh-failed', { heartbeat, error: String(error?.message || error) })
    }
}

function leaseKeyFor(root) {
    return createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)
}

function leaseSessionSidecarName(key, pid, session_id) {
    const tag = createHash('sha256').update(session_id).digest('hex').slice(0, 16)
    return `${key}.${pid}.${tag}.session`
}

function recordLeaseSession(key, pid, session_id) {
    const file = path.join(LEASES_DIR, leaseSessionSidecarName(key, pid, session_id))
    if (readTextOrNull(file) !== session_id) writeFileAtomically(file, session_id)
}

const LEASE_SESSION_SIDECAR = /^([0-9a-f]{16})\.(\d+)\.([0-9a-f]{16})\.session$/
const LEASE_FILE = /^([0-9a-f]{16})\.(\d+)\.lease$/

export function releaseAgentLeases() {
    let names
    try {
        names = fs.readdirSync(LEASES_DIR)
    } catch {
        return 0
    }
    const pid = String(process.pid)
    let released = 0
    for (const name of names) {
        const owner = (LEASE_FILE.exec(name) ?? LEASE_SESSION_SIDECAR.exec(name))?.[2]
        if (owner !== pid) continue
        try {
            fs.rmSync(path.join(LEASES_DIR, name), { force: true })
            released++
        } catch (error) {
            appendDiagnostic('lease-release-failed', { lease_file: name, error: String(error?.message || error) })
        }
    }
    return released
}

export function leaseSessionsFor(root) {
    const key = leaseKeyFor(root)
    let names
    try {
        names = fs.readdirSync(LEASES_DIR)
    } catch (error) {
        return error?.code === 'ENOENT' ? [] : null
    }
    const sessions = []
    for (const name of names) {
        const match = LEASE_SESSION_SIDECAR.exec(name)
        if (!match || match[1] !== key) continue
        const pid = Number(match[2])
        const sidecar = path.join(LEASES_DIR, name)
        if (!fs.existsSync(path.join(LEASES_DIR, `${key}.${pid}.lease`))) {
            try {
                fs.rmSync(sidecar, { force: true })
            } catch {
            }
            continue
        }
        const session_id = readTextOrNull(sidecar)?.trim()
        if (!session_id) continue
        sessions.push({ session_id, pid, live: pidAlive(pid) === true })
    }
    return sessions
}

const SESSION_ID_BODY_ALIASES = ['SESSION_ID', 'session_id', 'sessionId']

export function explicitBodySessionId(body) {
    if (!isPlainObject(body)) return null
    const value = SESSION_ID_BODY_ALIASES.map(key => body[key]).find(candidate => typeof candidate === 'string' && candidate.trim())
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

const READ_ONLY_STATUS_VERBS = new Set(['phase-status', 'prd-list', 'pool-observe', 'health'])

export function isReadOnlyStatusDispatch(verb, body) {
    if (READ_ONLY_STATUS_VERBS.has(verb)) return true
    return verb === 'instruction' && !(isPlainObject(body) && typeof body.prompt === 'string' && body.prompt.trim() !== '')
}

export function applySessionLeaseVerdict(reply, { body, root, verb }) {
    const target = reply && typeof reply === 'object' && isPlainObject(reply.data) ? reply.data : reply
    if (!isPlainObject(target)) return reply
    if (!('session_owner_before_this_dispatch' in target) && !('session_mismatch' in target)) return reply
    if (isReadOnlyStatusDispatch(verb, body)) {
        target.session_mismatch = false
        target.session_read_only = true
        target.session_owner_before_this_dispatch = typeof target.session_owner_before_this_dispatch === 'string' ? target.session_owner_before_this_dispatch : null
        return reply
    }
    const owner = typeof target.session_owner_before_this_dispatch === 'string' && target.session_owner_before_this_dispatch ? target.session_owner_before_this_dispatch : null
    const incoming = explicitBodySessionId(body) || (typeof target.session_id === 'string' && target.session_id ? target.session_id : null)
    const leases = leaseSessionsFor(root)
    const ownerLeases = leases === null || owner === null ? null : leases.filter(lease => lease.session_id === owner)
    const liveLease = ownerLeases?.find(lease => lease.live) ?? null
    const namedLease = liveLease ?? ownerLeases?.[0] ?? null
    const identityDiffers = Boolean(owner && incoming && incoming !== owner)
    target.session_mismatch = identityDiffers && (ownerLeases === null || liveLease !== null)
    target.session_owner_lease = owner === null ? null : {
        session_id: owner,
        pid: namedLease?.pid ?? null,
        live: ownerLeases === null ? null : liveLease !== null,
    }
    return reply
}

const GLOBAL_LAUNCHER_LOCK_PATH = path.join(AGENTPLUG_DIR, 'spool-launch.lock')

const LAUNCHER_LOCK_UNREADABLE_GRACE_MS = 120_000

function readLauncherLock() {
    try {
        return readPidTsLock(GLOBAL_LAUNCHER_LOCK_PATH)
    } catch {
        return null
    }
}

export function launcherLockMayBeReclaimed(held, lockPath) {
    if (held) return pidAlive(held.pid) !== true
    if (!lockPath) return true
    try {
        return Date.now() - fs.statSync(lockPath).mtimeMs > LAUNCHER_LOCK_UNREADABLE_GRACE_MS
    } catch {
        return false
    }
}

function claimGlobalLauncher() {
    fs.mkdirSync(AGENTPLUG_DIR, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
        let claimed
        try {
            claimed = claimByLink(GLOBAL_LAUNCHER_LOCK_PATH, path.join(AGENTPLUG_DIR, '.spool-launch'), `${process.pid} ${Date.now()}`, 0o600)
        } catch {
            return false
        }
        if (claimed) return true
        const held = readLauncherLock()
        if (!launcherLockMayBeReclaimed(held, GLOBAL_LAUNCHER_LOCK_PATH)) return false
        try {
            fs.unlinkSync(GLOBAL_LAUNCHER_LOCK_PATH)
        } catch {
            return false
        }
    }
    return false
}

function claimRunnerEnsure(root) {
    const lockPath = path.join(spoolDirOf(root), '.runner-ensure.lock')
    const claim = () => claimByCreate(lockPath, `${process.pid} ${Date.now()}`, 0o600)
    try {
        return claim()
    } catch (error) {
        if (error?.code !== 'EEXIST') return false
    }
    try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
        if (ageMs <= ENSURE_LEASE_MS) return false
        const holderPid = readLockHolderPid(lockPath)
        if (ageMs < ENSURE_CHILD_MAX_AGE_MS && pidAlive(holderPid) === true) return false
        reclaimLockByRename(lockPath)
    } catch {
        return false
    }
    try {
        return claim()
    } catch {
        return false
    }
}

const ENSURE_CHILD_MAX_AGE_MS = 120_000
const inflightEnsuresByRoot = new Map()
const consecutiveFailedEnsuresByRoot = new Map()
const ENSURE_BACKOFF_CEILING_MS = 60_000

export function runnerEnsureInFlight(root, now = Date.now()) {
    const entry = inflightEnsuresByRoot.get(root)
    if (!entry) return false
    if (entry.exitCode !== null && entry.exitCode !== undefined) return false
    if (pidAlive(entry.pid) === false) return false
    if (now - entry.spawnedAtMs >= ENSURE_CHILD_MAX_AGE_MS) return false
    return true
}

export function reapRunnerEnsureInFlight(root, now = Date.now()) {
    const entry = inflightEnsuresByRoot.get(root)
    if (!entry || runnerEnsureInFlight(root, now)) return
    inflightEnsuresByRoot.delete(root)
    if (now - entry.spawnedAtMs >= ENSURE_CHILD_MAX_AGE_MS) entry.child?.kill()
}

const DAEMON_RESPAWN_DISABLED_PATH = path.join(AGENTPLUG_DIR, 'daemon-respawn-disabled')

function daemonRespawnDisabled() {
    if (process.env.GM_MCP_DAEMON_RESPAWN === '0') return true
    return fs.existsSync(DAEMON_RESPAWN_DISABLED_PATH)
}

function ensureSpoolDecision(root, now) {
    if (daemonRespawnDisabled()) return false
    if (runnerBinaryMissing()) return false
    if (liveDaemonSweepsProject(spoolDirOf(root))) {
        consecutiveFailedEnsuresByRoot.delete(root)
        return false
    }
    reapRunnerEnsureInFlight(root, now)
    if (runnerEnsureInFlight(root, now)) return false
    if (now - (lastEnsuredAtByRoot.get(root) || 0) < ENSURE_INTERVAL_MS) return false
    if (daemonBootGraceActive()) {
        lastEnsuredAtByRoot.set(root, now)
        return false
    }
    const failures = consecutiveFailedEnsuresByRoot.get(root) || 0
    lastEnsuredAtByRoot.set(root, now + Math.min(ENSURE_BACKOFF_CEILING_MS, ENSURE_INTERVAL_MS * (2 ** failures)) - ENSURE_INTERVAL_MS)
    if (!claimRunnerEnsure(root)) return false
    if (!claimGlobalLauncher()) return false
    consecutiveFailedEnsuresByRoot.set(root, failures + 1)
    return true
}

function runnerEnv() {
    return { ...process.env, GM_TOOLS_DIR: RUNNER_DIR, AGENTPLUG_HOME: AGENTPLUG_DIR, AGENTPLUG_LEASE_PID: String(process.pid) }
}

function callerLaneWait(body) {
    if (!isPlainObject(body)) return null
    const ms = Number(body.lane_wait_ms)
    return body.lane_wait_ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : null
}

function spawnRunnerDetached(root, now) {
    try {
        const child = spawn(RUNNER_PATH, ['spool'], {
            cwd: root,
            env: runnerEnv(),
            ...hiddenDetachedOptions(),
        })
        try {
            replaceLockText(GLOBAL_LAUNCHER_LOCK_PATH, `${child.pid} ${now}`)
        } catch {
        }
        return child
    } catch {
        try {
            fs.unlinkSync(GLOBAL_LAUNCHER_LOCK_PATH)
        } catch {
        }
        return null
    }
}

function trackRunnerEnsureChild(root, child, now) {
    const entry = { pid: child.pid, child, spawnedAtMs: now, exitCode: null }
    const settle = (code) => {
        entry.exitCode = code ?? 0
        if (inflightEnsuresByRoot.get(root) === entry) inflightEnsuresByRoot.delete(root)
    }
    child.on('error', () => settle(-1))
    child.on('exit', (code) => settle(code))
    recordRunnerEnsureInflight(root, entry)
    if (child.pid) recordChild({ root, pid: child.pid, kind: 'spool-runner', verb: 'spool', note: 'daemon sweeper for this project' })
    try {
        replaceLockText(path.join(spoolDirOf(root), '.runner-ensure.lock'), `${child.pid} ${now}`)
    } catch {
    }
    child.unref()
}

function ensureSpoolRunnerRunning(root) {
    const now = Date.now()
    if (!ensureSpoolDecision(root, now)) return
    const child = spawnRunnerDetached(root, now)
    if (child) trackRunnerEnsureChild(root, child, now)
}

export function recordRunnerEnsureInflight(root, entry) {
    inflightEnsuresByRoot.set(root, entry)
}

function startRunnerWatchdog(root) {
    if (process.env.GM_MCP_RUNNER_WATCHDOG === '0') return
    if (watchdogTimersByRoot.has(root)) return
    const timer = setInterval(() => {
        try {
            ensureSpoolRunnerRunning(root)
        } catch {
        }
    }, WATCHDOG_INTERVAL_MS)
    timer.unref?.()
    watchdogTimersByRoot.set(root, timer)
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            reject(new Error('aborted'))
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

const SPOOL_WATCHED_FALLBACK_MS = 2000
const SPOOL_RESPONSE_MAX_AGE_MS = 60 * 60 * 1000
const SPOOL_REFUSED_MAX_AGE_MS = 15 * 60 * 1000
const SPOOL_PRUNE_EVERY_MS = 10 * 60 * 1000
const SPOOL_REFUSAL_HEAD_BYTES = 4096
const SPOOL_REFUSAL_HEAD = /"refused"\s*:\s*true|"status"\s*:\s*"refused"|"outcome"\s*:\s*"refused"/
const spoolPrunedAt = new Map()

function isUnreadRefusalFile(file) {
    let fd
    try {
        fd = fs.openSync(file, 'r')
        const head = Buffer.alloc(SPOOL_REFUSAL_HEAD_BYTES)
        const n = fs.readSync(fd, head, 0, SPOOL_REFUSAL_HEAD_BYTES, 0)
        return SPOOL_REFUSAL_HEAD.test(head.toString('utf8', 0, n))
    } catch {
        return false
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
    }
}

function pruneSpoolResponsesOnce(outDir) {
    const now = Date.now()
    if (now - (spoolPrunedAt.get(outDir) ?? 0) < SPOOL_PRUNE_EVERY_MS) return
    spoolPrunedAt.set(outDir, now)
    let names
    try {
        names = fs.readdirSync(outDir)
    } catch {
        return
    }
    for (const name of names) {
        const file = path.join(outDir, name)
        try {
            const age = now - fs.statSync(file).mtimeMs
            if (age > SPOOL_RESPONSE_MAX_AGE_MS) fs.unlinkSync(file)
            else if (age > SPOOL_REFUSED_MAX_AGE_MS && isUnreadRefusalFile(file)) fs.unlinkSync(file)
        } catch {
        }
    }
}

const LATEST_ONLY_VERBS = new Set(['prd-list', 'prd_list'])

function isRefusalReply(parsed) {
    return isPlainObject(parsed) && (parsed.refused === true || parsed.status === 'refused' || parsed.outcome === 'refused')
}

const SECRET_REPLY_VERBS = new Set(['env_get', 'kv_get', 'ci_log'])

function removeReadReply(outPath) {
    try {
        fs.unlinkSync(outPath)
    } catch {
    }
}

function pruneSupersededListings(outDir, verb, sessionId, keepPath, callStartedAtMs) {
    const prefix = `${verb}-${sessionId}-`
    let names
    try {
        names = fs.readdirSync(outDir)
    } catch {
        return
    }
    for (const name of names) {
        if (!name.startsWith(prefix)) continue
        const file = path.join(outDir, name)
        if (file === keepPath) continue
        try {
            if (fs.statSync(file).mtimeMs < callStartedAtMs) fs.unlinkSync(file)
        } catch {
        }
    }
}

function waitForSpoolChange(outDir, outPath, waitMs, fallbackMs, signal, exactFallback = false) {
    return new Promise((resolve, reject) => {
        let outWatch
        let wakeTimer
        let fallbackTimer
        let settled = false
        const finish = (wakeSource, error) => {
            if (settled) return
            settled = true
            clearTimeout(wakeTimer)
            clearTimeout(fallbackTimer)
            outWatch?.close()
            signal?.removeEventListener('abort', onAbort)
            if (error) reject(error)
            else resolve(wakeSource)
        }
        const onAbort = () => finish(undefined, new Error('aborted'))
        const wake = (_event, filename) => {
            if (!filename || filename.toString() === path.basename(outPath)) finish('filesystem_event')
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
            outWatch = fs.watch(outDir, { persistent: false }, wake)
            outWatch.on('error', () => {
                outWatch?.close()
                outWatch = undefined
            })
        } catch {
            outWatch = undefined
        }
        if (fs.existsSync(outPath)) return finish('already_landed')
        wakeTimer = setTimeout(() => finish('deadline'), Math.max(1, waitMs))
        const watched = outWatch !== undefined
        const fallbackFloorMs = watched && !exactFallback ? SPOOL_WATCHED_FALLBACK_MS : 25
        fallbackTimer = setTimeout(() => finish('fallback_poll'), Math.min(Math.max(fallbackFloorMs, fallbackMs), Math.max(1, waitMs)))
    })
}

const EXEC_FAMILY_VERBS = ['exec_js', 'nodejs', 'javascript', 'node', 'js', 'bash', 'sh', 'shell', 'zsh', 'python', 'py', 'powershell', 'ps1', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno']

const SSH_OBJECT_BODY = 'ssh'

const PLAIN_TEXT_BODY_VERBS = new Set([...EXEC_FAMILY_VERBS.filter((verb) => verb !== SSH_OBJECT_BODY), 'crawl'])

const TIMEOUT_MS_PREFIX_VERBS = new Set(EXEC_FAMILY_VERBS)

const TIMEOUT_MS_PREFIX_LINE = /^\s*timeout(?:Ms|_ms)=/

const TIMEOUT_MS_PREFIX_VALUE = /^\s*timeout(?:Ms|_ms)=([0-9]+)[ \t]*(?:\r?\n|$)/

const DEFAULT_TIMEOUT_SECONDS = 120

const EXEC_DEFAULT_LIMIT_SECONDS = 300

const EXEC_DEFAULT_LIMIT_MS = EXEC_DEFAULT_LIMIT_SECONDS * 1000

const EXEC_HARD_CEILING_MS = 900000

const POLL_MARGIN_PAST_EXEC_TIMEOUT_MS = 5000

const POLL_TIMEOUT_CEILING_DEFAULT_MS = 600000

export function pollTimeoutCeilingMs() {
    const configured = Number(process.env.GM_MCP_POLL_TIMEOUT_CEILING_MS)
    return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : POLL_TIMEOUT_CEILING_DEFAULT_MS
}

const MAX_TIMER_TIMEOUT_MS = 2_147_483_647

const MAX_EXEC_TIMEOUT_MS = MAX_TIMER_TIMEOUT_MS - POLL_MARGIN_PAST_EXEC_TIMEOUT_MS

function unpackExecOutputEnvelope(verb, parsed) {
    if (!EXEC_FAMILY_VERBS.includes(verb) || !parsed || typeof parsed.data !== 'string') return parsed
    try {
        const inner = JSON.parse(parsed.data)
        return isPlainObject(inner) ? { ...parsed, data: inner } : parsed
    } catch {
        return parsed
    }
}

function timeoutMilliseconds(timeout_seconds, fallbackSeconds) {
    const seconds = Number(timeout_seconds)
    if (!Number.isFinite(seconds) || seconds <= 0) return fallbackSeconds * 1000
    return Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(1, Math.round(seconds * 1000)))
}

function timeoutInputDiagnostic(verb, raw_body, timeout_seconds) {
    if (timeout_seconds !== undefined && timeout_seconds !== null && timeout_seconds !== '') {
        const seconds = Number(timeout_seconds)
        if (!Number.isFinite(seconds)) return 'timeout_seconds must be a finite number of seconds'
        const milliseconds = seconds * 1000
        if (seconds > 0 && (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_TIMER_TIMEOUT_MS)) {
            return `timeout_seconds must not exceed ${MAX_TIMER_TIMEOUT_MS / 1000} seconds`
        }
    }
    if (!TIMEOUT_MS_PREFIX_VERBS.has(verb) || typeof raw_body !== 'string' || !TIMEOUT_MS_PREFIX_LINE.test(raw_body)) return undefined
    const bodyPrefix = TIMEOUT_MS_PREFIX_VALUE.exec(raw_body)
    if (!bodyPrefix) return 'timeoutMs must be a decimal millisecond value on its own first line'
    const milliseconds = Number(bodyPrefix[1])
    if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_EXEC_TIMEOUT_MS) {
        return `timeoutMs must not exceed ${MAX_EXEC_TIMEOUT_MS} milliseconds`
    }
    if (milliseconds > EXEC_HARD_CEILING_MS) {
        return `timeoutMs must not exceed ${EXEC_HARD_CEILING_MS} milliseconds: agentplug-host clamps a larger value to that ceiling in silence, so a longer child budget cannot be bought; split the work or resume with resume_task`
    }
    return undefined
}

function foldTypedTimeoutMs(timeoutMs, raw_body) {
    const milliseconds = Number(timeoutMs)
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return { error: 'timeoutMs must be a positive integer number of milliseconds' }
    if (TIMEOUT_MS_PREFIX_LINE.test(raw_body)) return { error: 'timeoutMs is set both as the typed field and as a leading timeoutMs= line of the body; send one' }
    return { raw_body: `timeoutMs=${milliseconds}\n${raw_body}` }
}

export function pollTimeoutMs(verb, raw_body, timeout_seconds) {
    const explicitMs = timeoutMilliseconds(timeout_seconds, 0)
    if (explicitMs > 0) return explicitMs
    const bodyPrefix = TIMEOUT_MS_PREFIX_VERBS.has(verb) && typeof raw_body === 'string' ? TIMEOUT_MS_PREFIX_VALUE.exec(raw_body) : null
    if (bodyPrefix) {
        const milliseconds = Number(bodyPrefix[1])
        if (Number.isSafeInteger(milliseconds) && milliseconds <= MAX_EXEC_TIMEOUT_MS) {
            return Math.max(DEFAULT_TIMEOUT_SECONDS * 1000, milliseconds + POLL_MARGIN_PAST_EXEC_TIMEOUT_MS)
        }
    }
    return DEFAULT_TIMEOUT_SECONDS * 1000
}

export function execLimitMs(verb, raw_body, timeout_seconds) {
    const bodyPrefix = TIMEOUT_MS_PREFIX_VERBS.has(verb) && typeof raw_body === 'string' ? TIMEOUT_MS_PREFIX_VALUE.exec(raw_body) : null
    if (bodyPrefix) {
        const milliseconds = Number(bodyPrefix[1])
        if (Number.isSafeInteger(milliseconds)) return Math.min(milliseconds, EXEC_HARD_CEILING_MS)
    }
    const pollBudgetMs = Math.min(pollTimeoutMs(verb, raw_body, timeout_seconds), pollTimeoutCeilingMs())
    return Math.min(EXEC_HARD_CEILING_MS, Math.max(EXEC_DEFAULT_LIMIT_MS, pollBudgetMs - POLL_MARGIN_PAST_EXEC_TIMEOUT_MS))
}

export function withTimeoutMsPrefix(verb, raw_body, timeout_seconds) {
    if (!TIMEOUT_MS_PREFIX_VERBS.has(verb)) return raw_body
    if (TIMEOUT_MS_PREFIX_LINE.test(raw_body)) return raw_body
    return `timeoutMs=${execLimitMs(verb, raw_body, timeout_seconds)}\n${raw_body}`
}

const DAEMON_HEARTBEAT_STALE_MS = Number(process.env.GM_MCP_DAEMON_HEARTBEAT_STALE_MS) > 0
    ? Number(process.env.GM_MCP_DAEMON_HEARTBEAT_STALE_MS)
    : 20_000

const DAEMON_TIMESTAMP_FUTURE_SKEW_MS = 60000


function timestampAgeMs(timestamp, now = Date.now()) {
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? now - timestamp : null
}


function isFreshDaemonTimestamp(timestamp, now = Date.now()) {
    const age = timestampAgeMs(timestamp, now)
    return age !== null && age >= -DAEMON_TIMESTAMP_FUTURE_SKEW_MS && age < DAEMON_HEARTBEAT_STALE_MS
}

function projectRootOfSpool(spoolDir) {
    return path.resolve(spoolDir, '..', '..')
}

function heartbeatAgeMs(spoolDir) {
    const status = readJsonFile(path.join(spoolDir, '.status.json'))
    return timestampAgeMs(status?.ts)
}

function daemonRestartCommand(root) {
    return `"${RUNNER_PATH}" spool   (run with cwd ${path.resolve(root)}; the launcher detaches agentplug-runner daemon for this project)`
}

function coldProjectLiveness() {
    const shared = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    const sharedPid = globalDaemonPid()
    if (sharedPid === null) {
        return { alive: null, note: 'no .status.json heartbeat found for this project yet and no shared daemon process is running -- nothing has swept this project; start one with the restart command for this project' }
    }
    return {
        alive: null,
        shared_daemon_pid: sharedPid,
        shared_daemon_active_projects: shared?.active_projects ?? null,
        note: `no .status.json heartbeat for this project yet, but the shared daemon (pid ${sharedPid}, serving ${shared?.active_projects ?? 'many'} registered projects) is running -- this is a cold project waiting its turn behind that daemon's other work (measured 85-110 s for a brand-new project, git repo or not; the project is keyed on its own directory, so a non-git cwd needs no git_root_override). The dispatch is still queued and will be claimed: re-dispatch with resume_task set to this response's task instead of writing a second request`,
    }
}

const LIVENESS_STATUS_FIELDS = [
    ['shared_process', 'boolean'],
    ['last_claimed_queue_wait_ms', 'number'],
    ['queue_depth', 'number'],
    ['queue_position', 'number'],
    ['claimed_step_count', 'number'],
    ['queued_step_count', 'number'],
    ['gm_processor_capacity', 'number'],
]

export function readDaemonLiveness(spoolDir) {
    let status
    try {
        status = readStatusJson(spoolDir)
    } catch {
        return coldProjectLiveness()
    }
    if (!status || typeof status !== 'object') return coldProjectLiveness()
    const now = Date.now()
    const globalStatus = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    const pid = typeof status.pid === 'number' ? status.pid : Number(status.pid) || null
    const pidAliveFlag = pidAlive(pid)
    const projectFresh = isFreshDaemonTimestamp(status.ts, now)
    const globalFresh = isFreshDaemonTimestamp(globalStatus?.ts, now)
    const sameDaemon = Number(status.pid) === Number(globalStatus?.pid) || Number(pid) === globalDaemonPid()
    const sameLiveDaemon = globalFresh && sameDaemon
    const pidOwnsDaemon = pidAliveFlag === true && sameDaemon
    const sharedPid = globalDaemonPid()
    const sharedFresh = sharedPid !== null && globalFresh
    const servedBySharedDaemon = sharedFresh
    const useGlobalHeartbeat = !projectFresh && globalStatus !== null && (sameLiveDaemon || pidOwnsDaemon || servedBySharedDaemon)
    const heartbeatTs = useGlobalHeartbeat ? globalStatus.ts : status.ts
    const heartbeatAgeMs = timestampAgeMs(heartbeatTs, now)
    const alive = (pidAliveFlag === true && (projectFresh || sameLiveDaemon || pidOwnsDaemon)) || servedBySharedDaemon
    const busyForMs = typeof status.busy_until === 'number' ? status.busy_until - now : null
    const busy = busyForMs !== null && busyForMs > 0
    const staleProjectHeartbeat = alive && !projectFresh
    const note = !alive
        ? runnerBinaryMissing()
            ? `no live daemon heartbeat for this project and the agentplug-runner binary is not installed at ${RUNNER_PATH} -- nothing can claim this dispatch until the runner is installed`
            : pidAliveFlag === false
                ? `the daemon process that last swept this project (pid ${pid}) is gone -- the daemon recycles itself on idle/memory pressure and on a runner version handoff, and is restarted on demand; this call already asked for a replacement, so a dispatch submitted now waits for its cold start (wasm compile, tens of seconds) instead of for a queue`
                : `daemon heartbeat is ${heartbeatAgeMs} ms stale (alive means under ${DAEMON_HEARTBEAT_STALE_MS} ms) -- it is down, hung, or has not registered this project; its own log is ${GLOBAL_DAEMON_LOG_PATH} (this project's spool log is ${path.join(spoolDir, '.watcher.log')}) and it restarts with ${daemonRestartCommand(projectRootOfSpool(spoolDir))}; this is not necessarily this dispatch's fault`
        : busy
            ? 'daemon is alive and still actively working on this project'
            : staleProjectHeartbeat && pidAliveFlag !== true
                ? `the daemon process that last swept this project (pid ${pid}) is gone, but this machine's shared daemon (pid ${sharedPid}) is alive with a fresh heartbeat and sweeps every leased project, so a stale heartbeat here is a heartbeat-write gap rather than a dead daemon -- the dispatch is queued normally`
                : staleProjectHeartbeat
                ? `daemon is alive: its own heartbeat for this project is ${timestampAgeMs(status.ts, now)} ms old (alive means under ${DAEMON_HEARTBEAT_STALE_MS} ms), which is expected for an idle project -- a project heartbeat only refreshes while the daemon is sweeping that project -- but pid ${pid} is alive and still owns this machine's daemon, so nothing is down`
                : 'daemon is alive; busy_until is project-scoped and currently unset, which says nothing about this particular dispatch -- read dispatch_state for that'
    const liveness = { alive, heartbeat_age_ms: heartbeatAgeMs, busy, busy_for_ms: busy ? busyForMs : null, note }
    if (pid !== null) liveness.pid = pid
    if (pidAliveFlag !== null) liveness.pid_alive = pidAliveFlag
    liveness.heartbeat_source = useGlobalHeartbeat ? 'shared-daemon' : 'project'
    liveness.project_heartbeat_age_ms = timestampAgeMs(status.ts, now)
    if (sharedPid !== null) liveness.shared_daemon_pid = sharedPid
    liveness.shared_daemon_fresh = sharedFresh
    if (status.plugin_compiling) liveness.plugin_compiling = true
    if (status.runtime) liveness.runtime = status.runtime
    for (const [key, type] of LIVENESS_STATUS_FIELDS) {
        if (typeof status[key] === type) liveness[key] = status[key]
    }
    const sharedProjects = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)?.active_projects
    if (typeof sharedProjects === 'number') liveness.daemon_active_projects = sharedProjects
    if (status.runner_update_in_progress) {
        liveness.runner_update_in_progress = true
        liveness.runner_update_staged_age_ms = status.runner_update_staged_age_ms ?? null
    }
    const stuck = stuckQueueReport(spoolDir)
    if (stuck) Object.assign(liveness, stuck)
    return liveness
}

const STUCK_QUEUE_BOUND_MS = 30_000

function stuckQueueReport(spoolDir, pressure) {
    const status = readJsonFile(path.join(spoolDir, '.status.json'))
    const queueDepth = typeof status?.queue_depth === 'number' ? status.queue_depth : null
    const claimedSteps = typeof status?.claimed_step_count === 'number' ? status.claimed_step_count : null
    if (queueDepth === null || claimedSteps === null) return null
    if (!(queueDepth > 0 && claimedSteps === 0)) return null
    const scan = pressure ?? scanSpoolQueue(spoolDir, null)
    const forMs = scan?.oldest_unclaimed_age_ms ?? null
    const cause = status?.plugin_compiling === true
        ? 'the daemon is compiling a plugin wasm synchronously on its sweep thread right now, which stalls the pass for every project'
        : 'a synchronous plugin compile or a saturated shared plugin pool stalls the whole pass, not just this dispatch'
    const unclaimed = scan?.project_unclaimed_count ?? null
    const queueing = unclaimed === null
        ? 're-dispatching cannot be claimed any sooner'
        : `re-dispatching only adds to the ${unclaimed} already queued`
    return {
        queue_stuck: true,
        queue_stuck_for_ms: forMs,
        queue_stuck_bound_ms: STUCK_QUEUE_BOUND_MS,
        queue_stuck_past_bound: forMs !== null && forMs >= STUCK_QUEUE_BOUND_MS,
        queue_stuck_unclaimed_files: unclaimed,
        queue_stuck_note: `queue_depth ${queueDepth} with claimed_step_count 0: the daemon counts work here and is claiming none of it, so the pass that claims requests is not reaching this project (${cause}). Those steps stay pending until the pass resumes; ${queueing}. Keep waiting on the dispatch you have with resume_task instead.`,
    }
}

function runnerUnavailable(root, spoolDir) {
    if (!runnerBinaryMissing()) return null
    if (readDaemonLiveness(spoolDir).alive) return null
    return {
        error: 'runner-not-installed',
        runner_binary_missing: true,
        runner_path: RUNNER_PATH,
        note: `the agentplug-runner binary is not installed at ${RUNNER_PATH} and no live daemon heartbeat was found for ${path.resolve(root)}, so this dispatch could never be claimed. Install it once, then dispatch again: npx github:AnEntrypoint/gm -g   (or, in this project: curl -fsSL https://raw.githubusercontent.com/AnEntrypoint/gm/main/install.sh | sh -s -- spool)`,
    }
}

const DAEMON_START_GRACE_MS = Number(process.env.GM_MCP_DAEMON_START_GRACE_MS) > 0
    ? Number(process.env.GM_MCP_DAEMON_START_GRACE_MS)
    : 15_000
const DAEMON_START_POLL_MS = 250
const DAEMON_COLD_START_GRACE_MS = Number(process.env.GM_MCP_DAEMON_COLD_START_GRACE_MS) > 0
    ? Number(process.env.GM_MCP_DAEMON_COLD_START_GRACE_MS)
    : 90_000

export async function awaitDaemonHeartbeat(spoolDir, signal, waitMs) {
    const budgetMs = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DAEMON_START_GRACE_MS
    const deadline = Date.now() + budgetMs
    while (true) {
        if (liveDaemonSweepsProject(spoolDir)) return 'recovered'
        if (Date.now() >= deadline) return 'still_dead'
        try {
            await sleep(DAEMON_START_POLL_MS, signal)
        } catch {
            return 'aborted'
        }
    }
}

export async function daemonNotRunning(root, spoolDir, signal) {
    if (process.env.GM_MCP_DAEMON_PREFLIGHT === '0') return undefined
    const liveness = readDaemonLiveness(spoolDir)
    if (liveness.alive) return undefined
    const statusPath = path.join(spoolDir, '.status.json')
    const age = heartbeatAgeMs(spoolDir)
    if (age === null && !fs.existsSync(statusPath)) return undefined
    if (daemonBootGraceActive()) return undefined
    if (readJsonFile(statusPath)?.runner_update_in_progress) return undefined
    ensureSpoolRunnerRunning(root)
    startRunnerWatchdog(root)
    const coldStart = globalDaemonPid() === null
    const graceMs = coldStart ? DAEMON_COLD_START_GRACE_MS : DAEMON_START_GRACE_MS
    if (await awaitDaemonHeartbeat(spoolDir, signal, graceMs) !== 'still_dead') return undefined
    if (globalDaemonPid() !== null) {
        return undefined
    }
    const staleFor = heartbeatAgeMs(spoolDir)
    const stuck = stuckQueueReport(spoolDir)
    return {
        error: 'daemon-not-running',
        daemon_not_running: true,
        heartbeat_age_ms: staleFor,
        stale_after_ms: DAEMON_HEARTBEAT_STALE_MS,
        waited_for_start_ms: graceMs,
        checked_status_file: path.join(spoolDir, '.status.json'),
        daemon_log: GLOBAL_DAEMON_LOG_PATH,
        spool_log: path.join(spoolDir, '.watcher.log'),
        ...(stuck ?? {}),
        note: `no daemon process exists on this machine: it did not come back within ${graceMs} ms of asking for a runner (a cold start compiles the plugin wasm, so it is given ${DAEMON_COLD_START_GRACE_MS} ms), so no dispatch was written -- it would sit queued_not_yet_claimed and only fail at the poll timeout. Restart it and dispatch again: ${daemonRestartCommand(root)}`,
    }
}

export function readSpoolDispatchState(spoolDir, verb, task) {
    const queuedPath = path.join(spoolDir, 'in', verb, `${task}.txt`)
    const claimedPath = `${queuedPath}.inflight`
    const claimed = fs.existsSync(claimedPath)
    const queued = !claimed && fs.existsSync(queuedPath)
    const state = claimed ? 'claimed_still_in_flight' : queued ? 'queued_not_yet_claimed' : 'no_input_file_left'
    const pressure = scanSpoolQueue(spoolDir, queuedPath)
    const stall = claimSweepStall(pressure, queued)
    const note = claimed
        ? `the daemon HAS claimed this dispatch (${claimedPath} exists) and has not written its out-file yet -- it is still running, not lost. Do NOT re-dispatch: call again with the same verb and cwd, resume_task set to this response's task and no body, to keep waiting on the SAME request`
        : queued && pressure
            ? queuePressureNote(pressure, queuedPath, stall)
            : queued
                ? `this request is still sitting UNCLAIMED in the spool queue (${queuedPath} exists) -- the daemon has not picked it up yet; it claims every settled ticket on each tick, so do NOT re-dispatch: call again with the same verb and cwd, resume_task set to this response's task and no body; writing a second dispatch only deepens the queue`
                : 'neither an input file nor an out-file exists for this task id, so the spool holds no evidence either way: either the id was never written (a resume_task typo), or it was claimed and then lost to a daemon exit / self-update handoff. A lost claim normally leaves a dispatch_orphaned out-file behind; since none appeared, re-dispatch fresh rather than resuming this id'
    return { state, claimed, queued, ...(stall ?? {}), ...(pressure ?? {}), ...(stuckQueueReport(spoolDir, pressure) ?? {}), note }
}

const DISPATCH_WAIT_LEDGER_FILE = '.dispatch-wait.json'

const DISPATCH_WAIT_LEDGER_STALE_MS = 5000

const DISPATCH_WAIT_STATE_NOTES = {
    never_claimed: 'the request file is in the spool but the daemon has not claimed it yet',
    claimed_not_yet_tracked: 'the daemon claimed the request but has not started tracking it yet',
    claimed_waiting_for_admission: 'the daemon holds the request and is waiting for a shared plugin pool slot',
    claimed_waiting_for_serial_lane: 'the daemon holds the request and is waiting for this project serial lane (git, store or state)',
    claimed_waiting_for_tool_queue: 'the daemon holds the request and is waiting in the FIFO queue for this plugin and verb',
    claimed_running: 'the daemon is executing the request',
}

function dispatchWaitStateNote(state, lane) {
    const note = DISPATCH_WAIT_STATE_NOTES[state] ?? 'unrecognized state'
    if (state !== 'claimed_waiting_for_serial_lane' || lane !== null) return note
    return `${note}, and this row names no lane: the daemon writes a null lane for a verb that has no project serial lane, and a verb with no lane is admitted without waiting for one, so this is the stage recorded at the moment of the claim rather than a lane this dispatch is queued on`
}

function dispatchWaitStaleNote(ledgerAgeMs) {
    return `${DISPATCH_WAIT_LEDGER_FILE} was last rewritten ${ledgerAgeMs} ms ago, so this row is a snapshot taken then and not a reading of what the dispatch is doing now: the daemon rewrites the ledger when a dispatch changes stage and on a few answer paths, never on a timer, so a dispatch that has already moved past this stage keeps the older row until something else in this project triggers the next rewrite. row.stage_age_ms was measured at that same moment, not now, so neither number says how long the dispatch has been doing what it is doing at this instant`
}

export function readDispatchWaitRow(spoolDir, verb, task, outPath) {
    const ledgerPath = path.join(spoolDir, DISPATCH_WAIT_LEDGER_FILE)
    const ledger = readJsonFile(ledgerPath)
    if (!ledger) {
        return {
            ledger_path: ledgerPath,
            row: null,
            note: `no ${DISPATCH_WAIT_LEDGER_FILE} exists, so the daemon has no unanswered request in this project: the request was already answered or removed. Looked at out_path ${outPath}`,
        }
    }
    const header = {
        ledger_path: ledgerPath,
        ledger_age_ms: typeof ledger.ts === 'number' ? Date.now() - ledger.ts : null,
        daemon_pid: ledger.daemon_pid ?? null,
        project_in_flight: ledger.project_in_flight ?? null,
        project_in_flight_cap: ledger.project_in_flight_cap ?? null,
    }
    const found = (Array.isArray(ledger.requests) ? ledger.requests : []).find(r => r?.verb === verb && r?.task === task)
    if (!found) {
        return {
            ...header,
            row: null,
            note: `${DISPATCH_WAIT_LEDGER_FILE} holds no row for this task, so the request was already answered or removed. Looked at out_path ${outPath}`,
        }
    }
    const stale = header.ledger_age_ms !== null && header.ledger_age_ms >= DISPATCH_WAIT_LEDGER_STALE_MS
    return {
        ...header,
        row: {
            state: found.state,
            state_meaning: dispatchWaitStateNote(found.state, found.lane ?? null),
            snapshot_stale: stale,
            lane: found.lane ?? null,
            admission_kind: found.admission_kind ?? null,
            file_age_ms: found.file_age_ms ?? null,
            stage_age_ms: found.stage_age_ms ?? null,
            request_path: found.request_path,
            claim_path: found.claim_path || null,
            out_path: found.out_path,
        },
        ...(stale ? { note: dispatchWaitStaleNote(header.ledger_age_ms) } : {}),
    }
}

const CLAIM_SWEEP_STALL_MS = 30_000

function claimSweepStall(pressure, queued) {
    const oldestMs = queued && pressure ? pressure.oldest_unclaimed_age_ms : null
    if (!queued || !pressure || pressure.cap_saturated || oldestMs === null) {
        return { claim_sweep_stalled: false, claim_sweep_stalled_for_ms: oldestMs === null ? null : oldestMs }
    }
    const stalled = oldestMs >= CLAIM_SWEEP_STALL_MS
    return { claim_sweep_stalled: stalled, claim_sweep_stalled_for_ms: oldestMs }
}

const MAX_CLAIMED_DISPATCHES_PER_PROJECT = 32

export function scanSpoolQueue(spoolDir, myQueuedPath) {
    const inDir = path.join(spoolDir, 'in')
    let verbs
    try {
        verbs = fs.readdirSync(inDir, { withFileTypes: true })
    } catch {
        return null
    }
    const now = Date.now()
    let myMtimeMs = null
    try {
        myMtimeMs = fs.statSync(myQueuedPath).mtimeMs
    } catch {
    }
    let claimedCount = 0
    let unclaimedCount = 0
    let aheadOfMine = 0
    let oldestUnclaimedMs = null
    for (const verbEntry of verbs) {
        if (!verbEntry.isDirectory()) continue
        const verbDir = path.join(inDir, verbEntry.name)
        let files
        try {
            files = fs.readdirSync(verbDir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const fileEntry of files) {
            if (!fileEntry.isFile() || fileEntry.name.startsWith('.')) continue
            if (fileEntry.name.endsWith('.inflight')) {
                claimedCount += 1
                continue
            }
            if (!path.extname(fileEntry.name)) continue
            unclaimedCount += 1
            let mtimeMs = null
            try {
                mtimeMs = fs.statSync(path.join(verbDir, fileEntry.name)).mtimeMs
            } catch {
            }
            if (mtimeMs === null) continue
            if (oldestUnclaimedMs === null || mtimeMs < oldestUnclaimedMs) oldestUnclaimedMs = mtimeMs
            if (myMtimeMs !== null && mtimeMs < myMtimeMs) aheadOfMine += 1
        }
    }
    return {
        project_claimed_count: claimedCount,
        project_unclaimed_count: unclaimedCount,
        oldest_unclaimed_age_ms: oldestUnclaimedMs === null ? null : now - oldestUnclaimedMs,
        unclaimed_ahead_of_mine: myMtimeMs === null ? null : aheadOfMine,
        claimed_dispatch_cap: MAX_CLAIMED_DISPATCHES_PER_PROJECT,
        claim_budget_left: Math.max(0, MAX_CLAIMED_DISPATCHES_PER_PROJECT - claimedCount),
        cap_saturated: claimedCount >= MAX_CLAIMED_DISPATCHES_PER_PROJECT,
    }
}

function queuePressureNote(pressure, queuedPath, stall) {
    const head = `${queuedPath} is still UNCLAIMED -- measured from the spool: ${pressure.project_claimed_count}/${pressure.claimed_dispatch_cap} dispatches claimed in flight for this project, ${pressure.project_unclaimed_count} unclaimed, ${pressure.unclaimed_ahead_of_mine} of them older than this one, oldest unclaimed waiting ${pressure.oldest_unclaimed_age_ms} ms`
    const stalled = Boolean(stall && stall.claim_sweep_stalled)
    const stallTail = stalled
        ? `. CLAIM SWEEP STALLED: ${pressure.claim_budget_left} claim slot(s) are free and the oldest queued dispatch has been waiting ${pressure.oldest_unclaimed_age_ms} ms (past the ${CLAIM_SWEEP_STALL_MS} ms sweep bound), so the pass that claims requests is not reaching this project -- it walks every registered root in order, so a stalled pass delays everything behind it. This dispatch is still queued and will be claimed when the pass resumes: keep waiting on it with resume_task, and check the daemon log for a synchronous update poll or a saturated shared plugin pool holding the pass up.`
        : ''
    return pressure.cap_saturated
        ? `${head}. THIS PROJECT IS AT ITS CLAIM CAP: the daemon claims nothing new here until one of the ${pressure.project_claimed_count} in-flight dispatches finishes. Wait it out on this same dispatch with resume_task -- re-dispatching adds to the ${pressure.project_unclaimed_count} already queued and cannot be claimed any sooner.`
        : `${head}. Not cap saturation (${pressure.claim_budget_left} claim slot(s) free): the daemon is between sweeps of this project or busy elsewhere -- see daemon.daemon_active_projects and daemon.gm_processor_capacity for how many projects share it. Keep waiting on this dispatch with resume_task; nothing here is wedged.${stallTail}`
}

const CLAIM_SAMPLE_MS = 100
const CLAIM_SAMPLE_WINDOW_MS = 10000
const FINAL_OUT_RECHECK_WINDOW_MS = 2500
const FINAL_OUT_RECHECK_INTERVAL_MS = 150

function resumeDisclosure(task, landedAtMs, callStartedAtMs) {
    const resultPredatesResume = typeof landedAtMs === 'number' && landedAtMs < callStartedAtMs
    return {
        task,
        sent_no_body: true,
        wrote_no_new_dispatch: true,
        result_predates_this_resume: resultPredatesResume,
        note: resultPredatesResume
            ? 'this is the original dispatch\'s stored result, read back unchanged -- any error below (including a missing-body/validation error) came from that dispatch, NOT from this resume call, which sent no body'
            : 'the original dispatch finished while this resume was polling -- the result below is its own',
    }
}

function carriedNoFailure(out) {
    return isPlainObject(out)
        && out.error === undefined && out.error_code === undefined
        && out.dispatch_ledger_error === undefined && out.dream_rsi_observation_error === undefined
        && out.timed_out !== true && out.ok !== false
        && (!isPlainObject(out.data) || carriedNoFailure(out.data))
}

const DISPATCH_WAIT_DISCLOSED_AT_MS = 5000

function withDispatchWait(out, waitedMs, claimedAtMs) {
    if (waitedMs < DISPATCH_WAIT_DISCLOSED_AT_MS || !isPlainObject(out)) return out
    const starved = out.error_code === 'dispatch_starved_waiting_for_admission'
    const admitted = Number(starved ? out.waited_ms : out.admission_waited_ms)
    const admissionMs = Number.isFinite(admitted) && admitted > 0 ? Math.min(admitted, waitedMs) : 0
    const lane = starved ? { admission_kind: out.admission_kind, admission_in_flight: out.admission_in_flight, admission_limit: out.admission_limit, admission_holders: out.admission_holders } : {}
    const executed = firstReportedMs(out, ['duration_ms', 'guest_elapsed_ms'])
    const beforeGuestCapMs = waitedMs - admissionMs
    const claimMs = claimedAtMs !== null
        ? Math.max(0, Math.min(claimedAtMs - admissionMs, beforeGuestCapMs))
        : beforeGuestCapMs - (executed === null ? 0 : Math.min(executed, beforeGuestCapMs))
    const postClaimMs = waitedMs - admissionMs - claimMs
    const execMs = executed === null ? postClaimMs : Math.min(executed, postClaimMs)
    const guestMs = firstReportedMs(out, ['guest_elapsed_ms'])
    const embedMs = firstReportedMs(out, ['embed_ms', 'embed_query'])
    return { ...out, dispatch_waited_ms: waitedMs, dispatch_wait_split: { admission_ms: admissionMs, claim_wait_ms: claimMs, claim_observed: claimedAtMs !== null, exec_ms: execMs, exec_timed: executed !== null, guest_elapsed_ms: guestMs, embed_ms: embedMs, lane_wait_ms: claimMs, unattributed_ms: waitedMs - admissionMs - claimMs - execMs, ...lane } }
}

function firstReportedMs(out, keys) {
    for (const key of keys) {
        const value = Number(out[key] ?? out.data?.[key])
        if (Number.isFinite(value) && value > 0) return value
    }
    return null
}

function withResumeDisclosure(out, disclosure) {
    if (!isPlainObject(out)) return { resumed: disclosure, response: out }
    const key = 'resumed' in out ? 'resumed_dispatch' : 'resumed'
    return { ...out, [key]: disclosure }
}

const deliveredInstructionHashByOwner = new Map()

function instructionOwnerKey(root, session_id) {
    return `${path.resolve(root)} ${session_id}`
}

const deliveredReplyHashByOwner = new Map()

function withAssertedInstructionHash(verb, body) {
    if (verb !== 'instruction') return body
    return body
}

const INSTRUCTION_HASH_KEYS = ['instruction_hash', 'known_instruction_hash', 'ih']
function bodyCarriesInstructionHash(body) {
    return !!body && typeof body === 'object' && INSTRUCTION_HASH_KEYS.some(k => !!body[k])
}

function rememberDeliveredInstructionHash(verb, parsed, root, session_id) {
    if (verb !== 'instruction' || !parsed || parsed.ok === false) return
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
    const hash = typeof data.instruction_hash === 'string' ? data.instruction_hash : ''
    if (!hash) return
    const prose = typeof data.instruction === 'string' ? data.instruction : ''
    if (prose || data.instruction_unchanged === true) {
        deliveredInstructionHashByOwner.set(instructionOwnerKey(root, session_id), hash)
    }
    if (typeof data.reply_hash === 'string' && data.reply_hash) {
        deliveredReplyHashByOwner.set(instructionOwnerKey(root, session_id), data.reply_hash)
    }
}


const ownerHeaderCapabilityByRuntime = new Map()
const OWNER_HEADER_CAPABILITY_CACHE_MAX = 64

function ownerHeaderRuntimeIdentity(root) {
    const status = readJsonFile(GLOBAL_DAEMON_STATUS_PATH)
    const hash = status?.loaded_plugin_content_sha256?.gm
    const slots = status?.shared_pool_slot_content_sha256?.gm
    if (!status || !Number.isSafeInteger(status.pid) || pidAlive(status.pid) !== true
        || !isFreshDaemonTimestamp(status.ts, Date.now())
        || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)
        || !Array.isArray(slots) || !slots.some(value => value === hash)
        || slots.some(value => value !== null && value !== hash && value !== 'busy-dispatch-in-flight')
        || (Array.isArray(status.mixed_version_pools) && status.mixed_version_pools.length)) return null
    const project = readJsonFile(path.join(spoolDirOf(root), '.status.json'))
    if (project && (project.pid !== status.pid || !isFreshDaemonTimestamp(project.ts, Date.now()))) return null
    return JSON.stringify([root, GLOBAL_DAEMON_STATUS_PATH, status.pid, status.daemon_boot_ts, hash])
}

async function plainTextOwnerTransport(root, session_id, signal) {
    const before = ownerHeaderRuntimeIdentity(root)
    if (before && ownerHeaderCapabilityByRuntime.has(before)) {
        const cached = await ownerHeaderCapabilityByRuntime.get(before)
        return ownerHeaderRuntimeIdentity(root) === before ? cached : 'unverified'
    }
    const probe = async () => {
        let response
        try {
            await gmDispatch({
                verb: 'phase-status', body: {}, session_id,
                cwd: root, timeout_seconds: 20, full_response: true,
            }, signal, value => { response = value })
        } catch { return 'unverified' }
        if (!before || ownerHeaderRuntimeIdentity(root) !== before) return 'unverified'
        if (response?.gm_session_header_version === 1) return 'header-v1'
        if (response?.ok === true && response.timed_out !== true) return 'legacy-unverified'
        return 'unverified'
    }
    const pending = probe()
    if (before) {
        if (ownerHeaderCapabilityByRuntime.size >= OWNER_HEADER_CAPABILITY_CACHE_MAX) {
            ownerHeaderCapabilityByRuntime.delete(ownerHeaderCapabilityByRuntime.keys().next().value)
        }
        ownerHeaderCapabilityByRuntime.set(before, pending)
    }
    const transport = await pending
    if (before && transport === 'unverified'
        && ownerHeaderCapabilityByRuntime.get(before) === pending) ownerHeaderCapabilityByRuntime.delete(before)
    return transport
}

const VERBATIM_REPLY_VERBS = new Set(['fs_read', 'result', 'gm_result'])

const noticedBundleKeys = new Set()

function withStaleBundleNotice(verb, text) {
    if (VERBATIM_REPLY_VERBS.has(verb)) return text
    if (typeof text !== 'string' || text === '') return text
    const drift = bundleDrift()
    if (!drift.stale) return text
    const key = `${drift.installed_sha256 ?? ''}|${drift.refusal_code ?? ''}|${drift.running_sha256 ?? ''}`
    if (noticedBundleKeys.has(key)) return text
    noticedBundleKeys.add(key)
    const withNewline = text.endsWith('\n') ? text : `${text}\n`
    const line = bundleStalenessAnnouncement(drift)
    const block = yaml.dump({
        bundle_stale: true,
        bundle_served_version: drift.running_version,
        bundle_served_sha: drift.running_sha256,
        bundle_installed_version: drift.installed_version,
        bundle_installed_sha: drift.installed_sha256,
        bundle_reloadable: drift.reloadable === true,
    }, { lineWidth: 100 })
    if (!line || READ_ONLY_STATUS_VERBS.has(verb)) return `${withNewline}${block}\n`
    return `${withNewline}${block}\n${line}\n`
}

function spoolDiagnostics(spoolDir, verb, requestNumber, outPath) {
    const guarded = (key, read) => {
        try {
            return { [key]: read() }
        } catch {
            return {}
        }
    }
    return {
        ...guarded('dispatch_state', () => readSpoolDispatchState(spoolDir, verb, requestNumber)),
        ...guarded('dispatch_wait', () => readDispatchWaitRow(spoolDir, verb, requestNumber, outPath)),
        ...guarded('daemon', () => readDaemonLiveness(spoolDir)),
    }
}

export function timeoutReply({ spoolDir, verb, requestNumber, inPath, outPath, timeoutMs, requestedPollTimeoutMs, pollCeilingMs, execMs, resumeTask, callStartedAtMs }) {
    const truth = {
        timed_out: true,
        task: requestNumber,
        poll_timeout_ms: timeoutMs,
        in_path: inPath,
        out_path: outPath,
        resume_task_supported: true,
        resumed_this_call: Boolean(resumeTask),
    }
    try {
        const capped = requestedPollTimeoutMs > timeoutMs
        const execRemainingMs = execMs === null || resumeTask ? null : Math.max(0, execMs - (Date.now() - callStartedAtMs))
        const execNote = execMs === null ? null : [
            `this timeout does NOT kill the child: the daemon holds it and reaps it only when it reaches its own ${execMs}ms exec budget, measured from the original dispatch start`,
            execRemainingMs === null ? null : execRemainingMs > 0 ? `about ${Math.ceil(execRemainingMs / 1000)}s from now` : 'which has already elapsed, so the out-file will report killed:true/exec_timeout',
            `resume this same task with resume_task and a timeout_seconds that outlasts that budget, or set the budget yourself with a timeoutMs=<ms> first line in the body (up to ${EXEC_HARD_CEILING_MS})`,
        ].filter(Boolean).join('; ')
        return {
            ...truth,
            requested_poll_timeout_ms: requestedPollTimeoutMs,
            poll_timeout_capped: capped,
            poll_timeout_ceiling_ms: pollCeilingMs,
            poll_timeout_cap_reason: capped
                ? `gm stopped waiting at its ${pollCeilingMs}ms poll ceiling, not because the dispatch failed: set GM_MCP_POLL_TIMEOUT_CEILING_MS higher for this server, or resume_task, to keep waiting on the same dispatch`
                : 'gm stopped waiting because the caller-supplied budget ran out; the dispatch itself is untouched',
            ...(execMs === null ? {} : { exec_limit_ms: execMs, child_reaped_at_exec_limit: true, exec_child: execNote }),
            final_out_recheck_window_ms: FINAL_OUT_RECHECK_WINDOW_MS,
            ...spoolDiagnostics(spoolDir, verb, requestNumber, outPath),
        }
    } catch (e) {
        return {
            ...truth,
            not_a_result: true,
            diagnostics_failed: `the timeout reply could not build its own diagnostics (${e?.message ?? e}): this dispatch produced NO result, so an absent match set here means the result was never reported, not that the search found nothing -- resume it with resume_task ${requestNumber}`,
        }
    }
}

export function replyEnvelopeSelfCheck() {
    const fields = {
        spoolDir: path.join(os.tmpdir(), 'gm-mcp-self-check-absent-spool'),
        verb: 'git_finalize',
        requestNumber: 4242,
        inPath: path.join('in', '4242.txt'),
        outPath: path.join('out', 'git_finalize-4242.json'),
        timeoutMs: 1000,
        requestedPollTimeoutMs: 120000,
        pollCeilingMs: 600000,
        execMs: null,
        resumeTask: false,
        callStartedAtMs: Date.now(),
    }
    return {
        timeout_reply: timeoutReply(fields),
        timeout_reply_capped_by_ceiling: timeoutReply({ ...fields, timeoutMs: 600000, requestedPollTimeoutMs: 900000 }),
        timeout_reply_with_exec_child: timeoutReply({ ...fields, execMs: 300000 }),
        timeout_reply_resumed: timeoutReply({ ...fields, resumeTask: '4242' }),
    }
}

function continuationKeyOf(args) {
    return explicitBodySessionId(args?.body) || args?.session_id || ''
}

const CI_STATUS_VERBS = new Set(['ci-status', 'ci_status'])
const CI_STATUS_WAIT_DEFAULT_MS = 300000
const CI_STATUS_WAIT_CEILING_MS = 900000
const CI_STATUS_WAIT_POLL_MS = 15000
const CI_STATUS_NON_TERMINAL = new Set(['pending', 'in_progress', 'queued', 'waiting', 'requested'])
const CI_STATUS_ORIGIN_TIMEOUT_MS = 10000
const GITHUB_REMOTE_PATH = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/

function withCiStatusRepo(body, root) {
    const dir = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : root
    const explicit = [body.github_repo, body.repo].find((value) => typeof value === 'string' && value.trim())
    if (explicit) return { body: { ...body, github_repo: explicit.trim(), cwd: dir } }
    const origin = runGit(dir, ['remote', 'get-url', 'origin'], CI_STATUS_ORIGIN_TIMEOUT_MS)
    const match = origin.ok ? GITHUB_REMOTE_PATH.exec(origin.out) : null
    if (!match) {
        const found = origin.ok && origin.out ? `origin is ${origin.out}` : 'no origin remote'
        return { error: `ci-status cannot resolve owner/name for ${dir} (${found}); pass github_repo as owner/name` }
    }
    return { body: { ...body, github_repo: `${match[1]}/${match[2]}`, cwd: dir } }
}

function ciStatusReplyRunStatus(reply) {
    if (typeof reply !== 'string') return undefined
    let parsed
    try { parsed = yaml.load(reply) } catch { return undefined }
    if (!isPlainObject(parsed)) return undefined
    const status = parsed.run_status ?? parsed.data?.run_status
    return typeof status === 'string' ? status : undefined
}

function sleepUnlessAborted(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms)
        function done() {
            clearTimeout(timer)
            signal?.removeEventListener('abort', done)
            resolve()
        }
        signal?.addEventListener('abort', done, { once: true })
    })
}

async function runCiStatusWithWait(args, signal, responseValueObserver) {
    const { wait, timeout_ms, ...body } = args.body
    const requested = Number(timeout_ms)
    const budgetMs = Math.min(CI_STATUS_WAIT_CEILING_MS, Number.isFinite(requested) && requested > 0 ? Math.round(requested) : CI_STATUS_WAIT_DEFAULT_MS)
    const deadline = Date.now() + budgetMs
    const inner = { ...args, body }
    for (;;) {
        const reply = await runDispatch(inner, signal, responseValueObserver)
        const status = ciStatusReplyRunStatus(reply)
        const remainingMs = deadline - Date.now()
        if (!CI_STATUS_NON_TERMINAL.has(status) || remainingMs <= 0 || signal?.aborted) return reply
        await sleepUnlessAborted(Math.min(CI_STATUS_WAIT_POLL_MS, remainingMs), signal)
    }
}

export async function gmDispatch(args, signal, responseValueObserver) {
    if (typeof args?.max_chars === 'number' && args.max_chars > 2 * CONTINUATION_RESERVE_CHARS) args = { ...args, max_chars: args.max_chars - CONTINUATION_RESERVE_CHARS, requested_max_chars: args.max_chars }
    if (args?.verb === CONTINUATION_STOP_VERB) {
        const key = continuationKeyOf(args)
        setContinuationStopped(key, true)
        return continuedReply(key, yaml.dump({ ok: true, verb: CONTINUATION_STOP_VERB, session_id: key || null }, { lineWidth: 100 }))
    }
    if (args?.verb === 'instruction' && typeof args?.body?.prompt === 'string' && args.body.prompt.trim() !== '') {
        setContinuationStopped(continuationKeyOf(args), false)
    }
    inflightDispatches += 1
    const startedAtMs = Date.now()
    appendDiagnostic('dispatch-start', { verb: args?.verb ?? null, cwd: args?.cwd ?? null, resume_task: args?.resume_task ?? null })
    try {
        const waits = CI_STATUS_VERBS.has(args?.verb) && isPlainObject(args?.body) && args.body.wait === true
        const reply = withStaleBundleNotice(args?.verb, waits ? await runCiStatusWithWait(args, signal, responseValueObserver) : await runDispatch(args, signal, responseValueObserver))
        if (VERBATIM_REPLY_VERBS.has(args?.verb)) return reply
        return continuedReply(continuationKeyOf(args), reply)
    } catch (error) {
        appendDiagnostic('dispatch-error', { verb: args?.verb ?? null, error: error?.message ? String(error.message) : String(error) })
        throw error
    } finally {
        appendDiagnostic('dispatch-end', { verb: args?.verb ?? null, ms: Date.now() - startedAtMs, inflight: inflightDispatches - 1 })
        inflightDispatches -= 1
    }
}

async function runDispatch({ verb, body, raw_body, session_id, cwd, timeout_seconds, poll_interval_seconds, include_timing, resume_task, full_response, max_chars, requested_max_chars }, signal, responseValueObserver) {
    if (!verb) return 'error: verb required'
    if (typeof session_id === 'string') session_id = session_id.trim()
    session_id = explicitBodySessionId(body) || session_id
    if (!session_id) return 'error: session_id required'
    const requestNumber = resume_task || nextN(session_id)
    const unsafeName = unsafeSpoolName('verb', verb) || unsafeSpoolName('session_id', session_id) || unsafeSpoolName('task', requestNumber)
    if (unsafeName) return `error: ${unsafeName} -- nothing was written to the spool, so no dispatch was queued`
    const resolvedRoot = resolveDispatchRoot(cwd)
    if (resolvedRoot.error) {
        appendDiagnostic('dispatch-root-refused', { verb, root: resolvedRoot.refused_root, reason: resolvedRoot.refused_reason })
        return yaml.dump(resolvedRoot, { lineWidth: 100 })
    }
    if (resolvedRoot.root_source !== 'cwd') {
        appendDiagnostic('dispatch-root-defaulted', { verb, root: resolvedRoot.root, source: resolvedRoot.root_source })
    }
    const root = resolvedRoot.root
    ensureAgentLease(root, session_id)
    refreshCallerHeartbeat(root, session_id)
    try {
        maybeStartDevSync(root)
    } catch (error) {
        appendDiagnostic('dev-sync-trigger-failed', { root, error: String(error?.message || error) })
    }
    const spoolDir = spoolDirOf(root)
    const inDir = path.join(spoolDir, 'in', verb)
    const outDir = path.join(spoolDir, 'out')
    fs.mkdirSync(outDir, { recursive: true })
    pruneSpoolResponsesOnce(outDir)
    const callStartedAtMs = Date.now()
    let lastWakeSource = 'initial_check'
    const toYaml = (obj) => yaml.dump(obj, { lineWidth: 100 })

    const isPlainText = PLAIN_TEXT_BODY_VERBS.has(verb) || typeof raw_body === 'string'
    if (!resume_task && isPlainText && typeof raw_body !== 'string') {
        raw_body = plainTextFromBody(body)
        if (typeof raw_body !== 'string') {
            const carried = isPlainObject(body) ? Object.keys(body).join(', ') || 'none' : typeof body
            return `error: ${verb} takes a plain-text body -- pass the text as the top-level raw_body argument (a string), e.g. raw_body: "ls -la". body is accepted here too: as a plain string ("ls -la"), or as an object carrying one of ${PLAIN_TEXT_BODY_FIELDS.join(', ')}; when it carries several of them the first of those names wins. This body carried none of them (keys: ${carried}).`
        }
    }

    if (!resume_task && isPlainText && TIMEOUT_MS_PREFIX_VERBS.has(verb) && typeof raw_body === 'string' && isPlainObject(body) && body.timeoutMs !== undefined) {
        const folded = foldTypedTimeoutMs(body.timeoutMs, raw_body)
        if (folded.error) return `error: ${folded.error}`
        raw_body = folded.raw_body
    }
    const timeoutDiagnostic = timeoutInputDiagnostic(verb, raw_body, timeout_seconds)
    if (timeoutDiagnostic) return `error: ${timeoutDiagnostic}`

    let normalizedBody
    let codesearchKDefaulted = false
    let codesearchDualScope = null
    let rawBodyText
    if (!resume_task && !isPlainText) {
        const normalized = normalizedObjectBody(verb, body)
        if (normalized.error) return `error: ${normalized.error}`
        if (normalized.rawText !== undefined) {
            rawBodyText = normalized.rawText
        } else {
            const globCoerced = withGlobFiltersCoerced(verb, normalized.value)
            if (globCoerced.error) return `error: ${globCoerced.error}`
            const diagnostic = objectBodyDiagnostic(verb, globCoerced.value) ?? fsWriteEnvelopeDiagnostic(verb, globCoerced.value)
            if (diagnostic) return `error: ${diagnostic}`
            const coerced = withCodesearchScalarsCoerced(verb, globCoerced.value)
            const dualRouted = withCodesearchDualPathRouted(verb, coerced, cwd)
            codesearchDualScope = dualRouted.scope
            const withDefaultK = withCodesearchDefaultK(verb, dualRouted.body)
            codesearchKDefaulted = withDefaultK.defaulted
            const siblingRefusal = outsideRootReadRefusal(verb, withDefaultK.body, cwd)
            if (siblingRefusal) return `error: ${siblingRefusal}`
            normalizedBody = withAssertedInstructionHash(verb, fsReadRangeCanonicalBody(verb, fsReadProjectRelativeBody(verb, withDefaultK.body, cwd)))
        }
    }

    if (!resume_task && CI_STATUS_VERBS.has(verb) && normalizedBody !== undefined) {
        const scoped = withCiStatusRepo(normalizedBody, root)
        if (scoped.error) return `error: ${scoped.error}`
        normalizedBody = scoped.body
    }

    let ownerTransport
    const inPath = path.join(inDir, `${requestNumber}.txt`)
    const outPath = path.join(outDir, `${verb}-${requestNumber}.json`)

    if (resume_task && !fs.existsSync(outPath) && !fs.existsSync(inPath) && !fs.existsSync(`${inPath}.inflight`)) {
        return toYaml({
            error: `resume_task "${requestNumber}" names no dispatch in this project's spool -- nothing was dispatched`,
            resumed: {
                task: requestNumber,
                sent_no_body: true,
                wrote_no_new_dispatch: true,
                checked_out_file: outPath,
                checked_queued_input: inPath,
                checked_claimed_input: `${inPath}.inflight`,
                note: 'a resume never re-sends a body; it only re-polls a dispatch the daemon already accepted, so verb and cwd must match the original call exactly and task must be the `task` field copied verbatim from that call\'s timed_out/aborted response. A task whose out-file has since been cleaned up cannot be resumed -- dispatch it again with its original body',
            },
        })
    }

    const requestedPollTimeoutMs = resume_task ? timeoutMilliseconds(timeout_seconds, DEFAULT_TIMEOUT_SECONDS) : pollTimeoutMs(verb, raw_body, timeout_seconds)
    const pollCeilingMs = pollTimeoutCeilingMs()
    const callerLaneWaitMs = callerLaneWait(normalizedBody)
    const timeoutMs = Math.min(Math.max(requestedPollTimeoutMs, callerLaneWaitMs ?? 0), pollCeilingMs)
    const execMs = EXEC_FAMILY_VERBS.includes(verb) ? execLimitMs(verb, raw_body, timeout_seconds) : null

    if (!resume_task) {
        const unavailable = runnerUnavailable(root, spoolDir)
        if (unavailable) return toYaml(unavailable)
        const notRunning = await daemonNotRunning(root, spoolDir, signal)
        if (notRunning) return toYaml(notRunning)
        ensureSpoolRunnerRunning(root)
        startRunnerWatchdog(root)
        if (isPlainText) {
            ownerTransport = await plainTextOwnerTransport(root, session_id, signal)
            if (signal?.aborted) return toYaml({ error: 'aborted', owner_transport: ownerTransport, wrote_no_new_dispatch: true })
            const plaintext = withTimeoutMsPrefix(verb, raw_body, timeout_seconds)
            publishSpoolRequest(inDir, inPath, requestNumber, ownerTransport === 'header-v1' ? 'gm_session_id=' + session_id + '\n' + plaintext : plaintext)
        } else if (rawBodyText !== undefined) {
            publishSpoolRequest(inDir, inPath, requestNumber, rawBodyText)
        } else {
            const { lane_wait_ms: _publicLaneWait, ...callerBody } = normalizedBody
            const fullBody = { ...callerBody, session_id }
            fullBody._agentplug_lane_wait_ms = callerLaneWaitMs === null ? timeoutMs : Math.min(callerLaneWaitMs, timeoutMs)
            if (verb === 'instruction') {
                const leases = leaseSessionsFor(root)
                if (leases) fullBody._lease_sessions = leases.filter(lease => lease.live).map(({ session_id: leaseSession, pid }) => ({ session_id: leaseSession, pid }))
            }
            publishSpoolRequest(inDir, inPath, requestNumber, JSON.stringify(fullBody))
        }
    }

    const pollMs = Math.max(25, (Number(poll_interval_seconds) || 0.25) * 1000)
    const deadline = Date.now() + timeoutMs


    const readLandedOutFile = () => {
        if (!fs.existsSync(outPath)) return undefined
        let landedAtMs = null
        let opened
        let readRefusal = false
        try {
            opened = openSpoolRegularFile(root, outPath)
            landedAtMs = opened.mtimeMs
            const original = JSON.parse(readAllBounded(opened.fd, opened.size))
            readRefusal = isRefusalReply(original)
            responseValueObserver?.(original)
            const parsed = full_response ? original : unpackExecOutputEnvelope(verb, original)
            applySessionLeaseVerdict(parsed, { body: normalizedBody ?? body, root, verb })
            rememberDeliveredInstructionHash(verb, parsed, root, session_id)
            const plainTextFile = typeof parsed?.result_file === 'string' ? parsed.result_file : undefined
            const ranged = full_response ? parsed : applyFsReadRangeFallback(verb, normalizedBody, parsed, inlineMaxForVerb({ verb, isPlainText, fullResponse: full_response, maxChars: max_chars, body: normalizedBody }))
            const named = withSearchIncompleteness(ranged)
            const cleaned = full_response ? named : cleanResponse(named, undefined, outPath, plainTextFile, untruncatedKeysFor(verb, normalizedBody), inlineMaxForVerb({ verb, isPlainText, fullResponse: full_response, maxChars: max_chars, body: normalizedBody }))
            let out = cleaned
            if (!full_response && isPlainObject(cleaned) && isPlainObject(cleaned.data)) {
                const { data, ...rest } = cleaned
                const collides = Object.keys(data).some(k => k in rest)
                if (!collides) out = { ...rest, ...data }
            }
            out = withExecExitVerdict(verb, out)
            out = liftStdoutFault(out)
            out = withCodesearchCompleteness(verb, out)
            if (!full_response) out = withQuietAdmission(withNoticeCodes(out))
            if (ownerTransport && ownerTransport !== 'header-v1' && isPlainObject(out)) out = { ...out, owner_transport: ownerTransport }
            if (!full_response) out = carriedNoFailure(out) ? compactWireResponse(out, outPath) : omitRepeatedFaultStdout(out, outPath)
            if (verb === 'prd-list' && isPlainObject(out) && out.ledger === undefined) out = { ...out, ledger: root, ledger_source: resolvedRoot.root_source }
            out = withCheckoutCreateHint(verb, normalizedBody, shapeGitStatusReply(verb, normalizedBody, shapeGitDiffReply(verb, normalizedBody, gitShowCaptureFallback(verb, normalizedBody, out, root))))
            out = withCodesearchDualPathScope(codesearchDualScope, out)
            out = withCodesearchDefaultKHint(codesearchKDefaulted, verb, out)
            if (resume_task) out = withResumeDisclosure(out, resumeDisclosure(requestNumber, landedAtMs, callStartedAtMs))
            else out = withDispatchWait(out, Date.now() - callStartedAtMs, claimedAtMs)
            if (out && typeof out === 'object' && out.instruction_unchanged === true && bodyCarriesInstructionHash(normalizedBody)) {
                out = { ...out, instruction_text_at: path.join(root, '.gm', 'next-step.md') }
            }
            if (include_timing === true || include_timing === 'true') {
                const timingKey = isPlainObject(out) && 'mcp_timing' in out ? 'mcp_client_timing' : 'mcp_timing'
                const { last_claimed_queue_wait_ms, ...daemonLiveness } = readDaemonLiveness(spoolDir)
                const timing = {
                    submitted_at_ms: callStartedAtMs,
                    response_observed_at_ms: Date.now(),
                    round_trip_ms: Date.now() - callStartedAtMs,
                    response_wakeup: lastWakeSource,
                    queue_wait_ms: claimedAtMs,
                    daemon_at_submission: { ...daemonLiveness, previous_claimed_queue_wait_ms: last_claimed_queue_wait_ms },
                }
                out = isPlainObject(out) ? { ...out, [timingKey]: timing } : { response: out, [timingKey]: timing }
            }
            const rendered = (verb === 'fs_read' ? renderVerbatimFileText(out, toYaml) : undefined) ?? toYaml(out)
            const spillNote = verb === 'fs_read' ? fsReadSpillNote(out, rendered) : ''
            if (LATEST_ONLY_VERBS.has(verb)) pruneSupersededListings(outDir, verb, session_id, outPath, callStartedAtMs)
            const replyCap = replyMaxChars(max_chars)
            const spillPath = `${outPath}.reply.txt`
            if (rendered.length > replyCap) fs.writeFileSync(spillPath, rendered)
            return capReplyText(rendered, replyCap, spillPath, out, toYaml, spillNote, requested_max_chars ?? replyCap)
        } catch (e) {
            const failed = { error: `response file was not valid JSON: ${e.message}`, task: requestNumber, out_path: outPath }
            return toYaml(resume_task ? withResumeDisclosure(failed, resumeDisclosure(requestNumber, landedAtMs, callStartedAtMs)) : failed)
        } finally {
            if (opened) fs.closeSync(opened.fd)
            if (readRefusal || SECRET_REPLY_VERBS.has(verb.replace(/-/g, '_'))) removeReadReply(outPath)
        }
    }

    const withdrawUnclaimedRequest = () => {
        if (resume_task) return false
        try {
            fs.unlinkSync(inPath)
            return true
        } catch {
            return false
        }
    }
    const abortedReply = () => toYaml({
        error: 'aborted',
        task: requestNumber,
        in_path: inPath,
        out_path: outPath,
        request_withdrawn_before_claim: withdrawUnclaimedRequest(),
    })

    let claimedAtMs = null
    while (true) {
        if (signal?.aborted) return abortedReply()
        ensureSpoolRunnerRunning(root)
        const landed = readLandedOutFile()
        if (landed !== undefined) return landed
        if (claimedAtMs === null && fs.existsSync(`${inPath}.inflight`)) claimedAtMs = Date.now() - callStartedAtMs
        if (Date.now() >= deadline) {
            const finalRecheckDeadline = Date.now() + FINAL_OUT_RECHECK_WINDOW_MS
            while (Date.now() < finalRecheckDeadline) {
                try {
                    await sleep(FINAL_OUT_RECHECK_INTERVAL_MS, signal)
                } catch {
                    break
                }
                const landedLate = readLandedOutFile()
                if (landedLate !== undefined) return landedLate
            }
            return toYaml(timeoutReply({
                spoolDir, verb, requestNumber, inPath, outPath,
                timeoutMs, requestedPollTimeoutMs, pollCeilingMs, execMs,
                resumeTask: resume_task, callStartedAtMs,
            }))
        }
        try {
            const claimPending = claimedAtMs === null && Date.now() - callStartedAtMs < CLAIM_SAMPLE_WINDOW_MS
            lastWakeSource = await waitForSpoolChange(outDir, outPath, deadline - Date.now(), claimPending ? CLAIM_SAMPLE_MS : pollMs, signal, claimPending)
        } catch {
            return abortedReply()
        }
    }
}
