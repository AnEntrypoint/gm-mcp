#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const yaml = createRequire(import.meta.url)('js-yaml')

const BROWSER_WORDS = ['cdp', 'browser', 'chrome', 'headful', 'live page', 'boot']
const GPU_WORDS = ['gpu', 'webgpu', 'amd', 'nvidia', 'accelerated', 'gpulock', 'frame-time', 'p50', 'dpr']
const DESIGN_WORDS = ['design decision', 'cluster-enabled', 'circumnavigat', 'planet wrap']
const OUTCOME_KINDS = ['outcome', 'witness-outcome']
const CLOSED_STATUSES = ['done', 'complete', 'completed', 'resolved']
const HEARTBEAT_INNER_MS = 540_000
const HEARTBEAT_OUTER_MS = 660_000

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const project = flags.project ?? 'C:/dev/spoint'
const client = flags.client ?? path.join(os.homedir(), '.gm-tools', 'gm-mcp-server.mjs')

function dispatchText(clientPath, cwd, verb, body) {
    const argv = [clientPath, 'dispatch', verb, '--cwd', cwd]
    if (body !== undefined) argv.push('--body', JSON.stringify(body))
    return execFileSync(process.execPath, argv, {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 900_000,
    })
}

const text = (row, key) => (typeof row?.[key] === 'string' ? row[key] : undefined)
const idOf = row => text(row, 'id')

function mentionsAny(haystack, words) {
    return words.some(word => {
        let at = haystack.indexOf(word)
        while (at !== -1) {
            if (at === 0 || !/[a-z0-9]/i.test(haystack[at - 1])) return true
            at = haystack.indexOf(word, at + 1)
        }
        return false
    })
}

const rowText = row => ['title', 'subject', 'body', 'text', 'description', 'acceptance_criteria']
    .map(key => text(row, key))
    .filter(value => value !== undefined)
    .join(' ')
    .toLowerCase()

function needsDesign(row) {
    const explicit = ['decision', 'needs_design'].filter(key => typeof row[key] === 'boolean').map(key => row[key])
    return explicit.length === 0 ? mentionsAny(rowText(row), DESIGN_WORDS) : explicit.includes(true)
}

function armOf(row) {
    const explicit = text(row, 'arm')
    if (explicit) return explicit === 'gpu' ? 'gpu' : explicit === 'browser' ? 'browser' : null
    const haystack = rowText(row)
    if (mentionsAny(haystack, BROWSER_WORDS)) return 'browser'
    if (mentionsAny(haystack, GPU_WORDS)) return 'gpu'
    return null
}

function isBlockerRow(row) {
    const id = idOf(row)
    if (id !== undefined && id.toLowerCase().includes('blocker')) return true
    const subject = text(row, 'subject')
    return subject !== undefined && subject.trimStart().toUpperCase().startsWith('BLOCKER')
}

const hasIdSegment = (id, segment) => id.split('-').includes(segment)

function isOutcomeRow(row) {
    const id = idOf(row)
    const byId = id !== undefined && (hasIdSegment(id, 'outcome') || id.includes('outcome-hop'))
    const kind = text(row, 'kind')
    const byKind = kind !== undefined && OUTCOME_KINDS.includes(kind.trim().toLowerCase())
    return byId || byKind
}

function isRefutedRow(row) {
    const id = idOf(row)
    const byId = id !== undefined && hasIdSegment(id, 'refuted')
    const byTitle = ['title', 'subject'].some(key => {
        const value = text(row, key)
        return value !== undefined && value.trimStart().toUpperCase().startsWith('REFUTED')
    })
    return byId || byTitle
}

function severityRank(row) {
    const value = text(row, 'severity')?.trim().toLowerCase()
    if (value === 'critical' || value === 'p0') return 4
    if (value === 'high' || value === 'p1') return 3
    if (value === 'low' || value === 'p3') return 1
    return 2
}

function openRowsWithRecency(items) {
    const folded = []
    const position = new Map()
    items.forEach((item, index) => {
        const id = idOf(item)
        if (id !== undefined && position.has(id)) {
            folded[position.get(id)] = { row: item, recency: index }
            return
        }
        if (id !== undefined) position.set(id, folded.length)
        folded.push({ row: item, recency: index })
    })
    return folded.filter(({ row }) => {
        const status = text(row, 'status') ?? 'pending'
        const closed = CLOSED_STATUSES.includes(status.trim().toLowerCase())
        const blockedExternal = Array.isArray(row.blockedBy) && row.blockedBy.includes('external')
        return !closed && !blockedExternal
    })
}

function heartbeatRows(poolDir, nowMs) {
    const inner = new Set()
    const outer = new Set()
    if (!fs.existsSync(poolDir)) return { inner, outer }
    for (const name of fs.readdirSync(poolDir)) {
        if (!name.endsWith('.live')) continue
        const file = path.join(poolDir, name)
        const ageMs = nowMs - fs.statSync(file).mtimeMs
        if (ageMs > HEARTBEAT_OUTER_MS) continue
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim().replace(/^\uFEFF/, ''))
        const field = key => lines.find(line => line.startsWith(key))?.slice(key.length).trim()
        if (!field('session:')) continue
        const row = field('row:')
        if (!row) continue
        outer.add(row)
        if (ageMs <= HEARTBEAT_INNER_MS) inner.add(row)
    }
    return { inner, outer }
}

const results = []
function check(name, ok, detail) {
    results.push(ok)
    console.log(`CHECK ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`)
}

function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1
        if (a[i] > b[i]) return 1
    }
    return 0
}

function runServedChecks() {
    const servedText = flags.served ? fs.readFileSync(flags.served, 'utf8') : dispatchText(client, project, 'pool-observe')
    if (flags.save) fs.writeFileSync(flags.save, servedText)
    const served = yaml.load(servedText)
    const slots = served?.data?.slots ?? {}
    const candidates = Array.isArray(slots.candidates) ? slots.candidates : []
    const liveRows = Array.isArray(slots.live_rows) ? slots.live_rows : []
    check(
        'K1_candidates_and_live_rows_are_arrays',
        Array.isArray(slots.candidates) && Array.isArray(slots.live_rows),
        `candidates=${Array.isArray(slots.candidates) ? candidates.length : 'absent'} live_rows=${Array.isArray(slots.live_rows) ? liveRows.length : 'absent'}`,
    )

    const store = yaml.load(fs.readFileSync(path.join(project, '.gm', 'prd.yml'), 'utf8'))
    const items = Array.isArray(store) ? store : Array.isArray(store?.items) ? store.items : []
    const servedLive = new Set(liveRows)
    const heartbeats = heartbeatRows(path.join(project, '.gm', 'pool'), Date.now())
    check(
        'K2_live_rows_match_fresh_heartbeats',
        [...servedLive].every(row => heartbeats.outer.has(row)) && [...heartbeats.inner].every(row => servedLive.has(row)),
        `served=${servedLive.size} fresh_inner=${heartbeats.inner.size} fresh_outer=${heartbeats.outer.size}`,
    )

    const open = openRowsWithRecency(items)
    const pendingBlocked = new Set(
        open.filter(({ row }) => isBlockerRow(row))
            .map(({ row }) => idOf(row))
            .filter(id => id !== undefined)
            .map(id => id.split('-blocker-')[0])
            .filter(Boolean),
    )
    const work = open.filter(({ row }) => !isBlockerRow(row))
    const workById = new Map()
    for (const entry of work) {
        const id = idOf(entry.row)
        if (id !== undefined) workById.set(id, entry)
    }
    const countWhere = predicate => work.filter(({ row }) => idOf(row) !== undefined && predicate(row)).length
    const mirror = {
        open_rows: work.length,
        blocker_rows: open.length - work.length,
        node_rows: countWhere(row => !needsDesign(row) && armOf(row) === null),
        gpu_arm_rows: countWhere(row => armOf(row) === 'gpu'),
        browser_arm_rows: countWhere(row => armOf(row) === 'browser'),
        design_decision_rows: countWhere(row => needsDesign(row)),
        rows_with_pending_blocker: countWhere(row => pendingBlocked.has(idOf(row))),
    }
    const servedSupply = slots.supply ?? {}
    const mismatched = Object.keys(mirror).filter(key => (
        key === 'open_rows' || key === 'blocker_rows' ? mirror[key] !== slots[key] : mirror[key] !== servedSupply[key]
    ))
    check(
        'K0_store_mirror_matches_served_counts',
        mismatched.length === 0,
        `mismatched=${mismatched.length ? mismatched.join(',') : 'none'} mirror=${JSON.stringify(mirror)}`,
    )

    const armCandidates = candidates.map(id => (workById.has(id) ? armOf(workById.get(id).row) : undefined))

    const offending = candidates.filter(id => {
        const entry = workById.get(id)
        if (!entry) return true
        return servedLive.has(id) || isBlockerRow(entry.row) || isOutcomeRow(entry.row) || isRefutedRow(entry.row) || needsDesign(entry.row)
    })
    check(
        'K3_no_live_blocker_outcome_refuted_or_design_candidates',
        offending.length === 0,
        `offending=${offending.length}${offending.length ? ` e.g. ${offending.slice(0, 3).join(',')}` : ''}`,
    )

    const candidateSet = new Set(candidates)
    check('K4_candidates_are_unique', candidateSet.size === candidates.length, `unique=${candidateSet.size} listed=${candidates.length}`)

    const firstArm = armCandidates.findIndex(arm => arm !== null && arm !== undefined)
    const nodeAfterArm = firstArm === -1 ? -1 : armCandidates.findIndex((arm, index) => index > firstArm && arm === null)
    check(
        'K5_node_candidates_precede_arm_candidates',
        nodeAfterArm === -1,
        `first_arm_index=${firstArm} node_after_arm_index=${nodeAfterArm}`,
    )

    const keyOf = id => {
        const entry = workById.get(id)
        return [armOf(entry.row) === null ? 0 : 1, pendingBlocked.has(id) ? 1 : 0, -severityRank(entry.row), -entry.recency, id]
    }
    const orderViolations = []
    for (let i = 0; i + 1 < candidates.length; i++) {
        const a = candidates[i]
        const b = candidates[i + 1]
        if (!workById.has(a) || !workById.has(b)) continue
        if (compareKeys(keyOf(a), keyOf(b)) >= 0) orderViolations.push(`${a} before ${b}`)
    }
    check(
        'K6_node_first_then_unblocked_then_severity_then_recency',
        orderViolations.length === 0,
        `violations=${orderViolations.length}${orderViolations.length ? ` e.g. ${orderViolations[0]}` : ''}`,
    )

    const eligibleNode = work
        .filter(({ row }) => {
            const id = idOf(row)
            return id !== undefined && !needsDesign(row) && armOf(row) === null && !isOutcomeRow(row) && !isRefutedRow(row) && !servedLive.has(id)
        })
        .map(({ row }) => idOf(row))
    const missing = eligibleNode.filter(id => !candidateSet.has(id))
    check(
        'K7_every_pending_node_row_is_reachable',
        missing.length === 0,
        `eligible_node=${eligibleNode.length} candidates=${candidates.length} missing=${missing.length}${missing.length ? ` e.g. ${missing.slice(0, 5).join(',')}` : ''}`,
    )

    const gpuCount = armCandidates.filter(arm => arm === 'gpu').length
    const browserCount = armCandidates.filter(arm => arm === 'browser').length
    check('K8_at_most_one_gpu_and_one_browser_candidate', gpuCount <= 1 && browserCount <= 1, `gpu=${gpuCount} browser=${browserCount}`)
}

function runEmptyProjectChecks(emptyDir) {
    const doc = yaml.load(dispatchText(client, emptyDir, 'pool-observe'))
    const empty = doc?.data?.slots ?? {}
    check(
        'E1_empty_project_candidates_present',
        Array.isArray(empty.candidates),
        `candidates=${Array.isArray(empty.candidates) ? JSON.stringify(empty.candidates) : 'absent'}`,
    )
    check(
        'E2_empty_project_live_rows_present',
        Array.isArray(empty.live_rows),
        `live_rows=${Array.isArray(empty.live_rows) ? JSON.stringify(empty.live_rows) : 'absent'}`,
    )
}

console.log(`witness pool-observe-served project=${project} client=${client} at=${new Date().toISOString()}`)
try {
    runServedChecks()
    if (flags.empty) runEmptyProjectChecks(flags.empty)
} catch (error) {
    results.push(false)
    console.log(`CHECK ERROR: ${error.message}`)
}
const pass = results.length > 0 && results.every(Boolean)
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
