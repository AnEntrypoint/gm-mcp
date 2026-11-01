// Housekeeping that the hourly leak-watch pass runs. It removes scratch directories, backup generations, stale records and
// old install directories, and it signals no process. A file that names a live pid, and a path a live process uses, stays.
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { pidAlive } from './dispatch.js'
import { agentplugDir, toolsDir } from './paths.js'
import { readProcessTableAsync } from './process-table.js'
import { appendDiagnostic, describeError } from './server-log.js'

export const SCRATCH_ROOT = '/tmp/gm-scratch'
const LEGACY_TMP_ROOT = '/tmp'
const OLD_INSTALL_SEARCH = ['/data/cache', '/home', '/root', '/config']
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const SCRATCH_MAX_AGE_MS = DAY_MS
const CLAIM_MAX_AGE_MS = DAY_MS
const INTENTIONAL_EXIT_MAX_AGE_MS = HOUR_MS
const OLD_INSTALL_IDLE_MS = 7 * DAY_MS
const ITEM_LIST_CAP = 50
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])
const LEGACY_TMP_PATTERNS = [/^gm-drain-/, /^gm-validate-/, /^gm-.*-witness/, /^gm-p7-/, /^gm-port-/, /^gm-57-/, /^gm-arc-probe$/, /^gh-artifact\..*\.zip$/, /^gm-spin/]
const PROTECTED_RECORDS = new Set(['daemon-owner.lock', 'daemon-owner.takeover.lock', 'daemon-status.json', 'daemon-config.json'])
const PID_CLAIM = /\.claim\.(\d+)(?:\.stale)?$/
const UNSUFFIXED_CLAIM = /\.claim$/
const ROTATED_LOG = /\.log\.(\d+)$/

// GM_MCP_JANITOR=0 turns the hourly sweep off. A manual janitor run ignores it.
export function janitorEnabled() {
    return !OFF_VALUES.has((process.env.GM_MCP_JANITOR || '').trim().toLowerCase())
}

// The pid a lock file holds as a bare integer, or null when the file is missing or unreadable.
export function lockPidOf(dir, name) {
    try {
        const value = Number.parseInt(readFileSync(path.join(dir, name), 'utf8').trim(), 10)
        return Number.isSafeInteger(value) && value > 0 ? value : null
    } catch {
        return null
    }
}

function textOf(file) {
    try {
        return readFileSync(file, 'utf8')
    } catch {
        return ''
    }
}

function jsonOf(file) {
    try {
        const value = JSON.parse(textOf(file))
        return value !== null && typeof value === 'object' ? value : {}
    } catch {
        return {}
    }
}

function namesIn(dir) {
    try {
        return readdirSync(dir)
    } catch {
        return []
    }
}

function isDirectory(target) {
    try {
        return statSync(target).isDirectory()
    } catch {
        return false
    }
}

function mtimeOf(target) {
    try {
        return lstatSync(target).mtimeMs
    } catch {
        return 0
    }
}

// Newest mtime of an entry and of a directory's direct children. A directory's own mtime moves only when a child is added
// or removed, so a file rewritten inside an old directory still counts as recent.
function newestMtime(target) {
    let newest = mtimeOf(target)
    if (isDirectory(target)) {
        for (const name of namesIn(target)) newest = Math.max(newest, mtimeOf(path.join(target, name)))
    }
    return newest
}

function sizeOf(target) {
    let bytes = 0
    const stack = [target]
    while (stack.length > 0) {
        const current = stack.pop()
        let stat
        try {
            stat = lstatSync(current)
        } catch {
            continue
        }
        if (stat.isDirectory()) {
            for (const name of namesIn(current)) stack.push(path.join(current, name))
        } else {
            bytes += stat.size
        }
    }
    return bytes
}

// What live processes use: each cwd that /proc exposes, and each command line, which carries the argv paths.
function liveReferences(table) {
    const cwds = []
    const commands = []
    for (const row of table) {
        if (typeof row.command === 'string') commands.push(row.command)
        const pid = Number(row.pid)
        if (!Number.isInteger(pid) || pid <= 0) continue
        try {
            cwds.push(readlinkSync('/proc/' + pid + '/cwd'))
        } catch {
            // cwd is unreadable for this process; its command line is still checked
        }
    }
    return { cwds, commands }
}

function isReferenced(target, refs) {
    const inside = (candidate) => candidate === target || candidate.startsWith(target + path.sep)
    return refs.cwds.some(inside) || refs.commands.some((command) => command.includes(target))
}

// The KEEP manifest of a scratch owner directory: one relative path per line. A listed path, and every top-level entry that
// contains one, is never swept. The janitor never descends into a listed path.
function keepSetOf(ownerDir) {
    const kept = []
    for (const line of textOf(path.join(ownerDir, 'KEEP')).split('\n')) {
        const rel = line.trim()
        if (rel === '' || rel.startsWith('#')) continue
        const abs = path.resolve(ownerDir, rel)
        if (abs.startsWith(ownerDir + path.sep)) kept.push(abs)
    }
    return kept
}

function scratchItems(now, refs) {
    const items = []
    for (const owner of namesIn(SCRATCH_ROOT)) {
        const ownerDir = path.join(SCRATCH_ROOT, owner)
        const kept = keepSetOf(ownerDir)
        for (const name of namesIn(ownerDir)) {
            const target = path.join(ownerDir, name)
            if (name === 'KEEP' || kept.some((abs) => abs === target || abs.startsWith(target + path.sep))) continue
            if (now - newestMtime(target) < SCRATCH_MAX_AGE_MS || isReferenced(target, refs)) continue
            items.push({ kind: 'scratch', path: target, reason: 'older than 24 h and no live process references it' })
        }
    }
    return items
}

function legacyTmpItems(now, refs) {
    const items = []
    for (const name of namesIn(LEGACY_TMP_ROOT)) {
        if (!LEGACY_TMP_PATTERNS.some((pattern) => pattern.test(name))) continue
        const target = path.join(LEGACY_TMP_ROOT, name)
        if (now - newestMtime(target) < SCRATCH_MAX_AGE_MS || isReferenced(target, refs)) continue
        items.push({ kind: 'legacy-tmp', path: target, reason: 'legacy scratch older than 24 h and no live process references it' })
    }
    return items
}

function generationItems(dirs) {
    const items = []
    for (const dir of dirs) {
        for (const name of namesIn(dir)) {
            const target = path.join(dir, name)
            if (name.includes('.bak-') || name.endsWith('-reverted.bak')) {
                items.push({ kind: 'generation', path: target, reason: 'backup generation' })
                continue
            }
            const rotation = ROTATED_LOG.exec(name)
            if (rotation !== null && Number(rotation[1]) >= 2) items.push({ kind: 'generation', path: target, reason: 'log rotation beyond .1' })
        }
    }
    return items
}

function recordItems(dir, now) {
    const items = []
    const add = (target, reason) => items.push({ kind: 'record', path: target, reason })
    for (const name of namesIn(dir)) {
        if (PROTECTED_RECORDS.has(name)) continue
        const target = path.join(dir, name)
        const claim = PID_CLAIM.exec(name)
        if (claim !== null) {
            if (pidAlive(Number(claim[1])) === false) add(target, 'claim for dead pid ' + claim[1])
            continue
        }
        if (name === 'daemon-guard.lock') {
            const pid = lockPidOf(dir, name)
            if (pid !== null && pidAlive(pid) === false) add(target, 'guard lock names dead pid ' + pid)
            continue
        }
        if (name === 'daemon-guard.owner.json') {
            const pid = Number(jsonOf(target).pid)
            if (Number.isInteger(pid) && pid > 0 && pidAlive(pid) === false) add(target, 'guard owner names dead pid ' + pid)
            continue
        }
        if (name === 'daemon-intentional-exit.json') {
            const pid = Number(jsonOf(target).pid)
            if (Number.isInteger(pid) && pid > 0 && pidAlive(pid) === false && now - mtimeOf(target) >= INTENTIONAL_EXIT_MAX_AGE_MS) {
                add(target, 'intentional-exit record for dead pid ' + pid)
            }
            continue
        }
        if (UNSUFFIXED_CLAIM.test(name)) {
            const stamp = Number(textOf(target).trim())
            if (Number.isSafeInteger(stamp) && stamp > 1e12 && now - stamp >= CLAIM_MAX_AGE_MS) add(target, 'claim timestamp older than 24 h')
        }
    }
    return items
}

function installDirCandidates() {
    const dirs = []
    for (const base of OLD_INSTALL_SEARCH) {
        dirs.push(path.join(base, '.agentplug'))
        for (const name of namesIn(base)) dirs.push(path.join(base, name, '.agentplug'))
    }
    return [...new Set(dirs)].filter(isDirectory)
}

function oldInstallItems(now, refs) {
    const configured = path.resolve(agentplugDir())
    const items = []
    for (const dir of installDirCandidates()) {
        if (path.resolve(dir) === configured) continue
        const owner = lockPidOf(dir, 'daemon-owner.lock')
        if (owner === null || pidAlive(owner) !== false) continue
        const newest = Math.max(0, ...namesIn(dir).map((name) => mtimeOf(path.join(dir, name))))
        if (now - newest < OLD_INSTALL_IDLE_MS || isReferenced(dir, refs)) continue
        items.push({ kind: 'old-install', path: dir, reason: 'owner pid ' + owner + ' is dead and the install is untouched for 7 days' })
    }
    return items
}

// Every candidate one sweep would remove, with its size. Nothing is removed here.
export async function janitorPlan({ now = Date.now(), table = null } = {}) {
    const processes = Array.isArray(table) ? table : await readProcessTableAsync()
    const refs = liveReferences(processes)
    const agentDir = agentplugDir()
    const items = [
        ...scratchItems(now, refs),
        ...legacyTmpItems(now, refs),
        ...generationItems([...new Set([toolsDir(), agentDir])]),
        ...recordItems(agentDir, now),
        ...oldInstallItems(now, refs),
    ]
    for (const item of items) item.bytes = sizeOf(item.path)
    return { items, processes_scanned: processes.length }
}

// One sweep: plan, remove what the plan holds when apply is set, and write one diagnostic event with the counts and bytes.
export async function runJanitorPass({ apply = true, force = false, now = Date.now(), table = null } = {}) {
    if (!force && !janitorEnabled()) return { outcome: 'disabled' }
    const eventId = 'janitor-' + now + '-' + process.pid
    let plan
    try {
        plan = await janitorPlan({ now, table })
    } catch (error) {
        appendDiagnostic('janitor-failed', { event_id: eventId, error: describeError(error) })
        return { outcome: 'failed', event_id: eventId }
    }
    const removed = []
    const failed = []
    if (apply) {
        for (const item of plan.items) {
            try {
                rmSync(item.path, { recursive: true, force: true })
                removed.push(item)
            } catch (error) {
                failed.push({ path: item.path, error: describeError(error) })
            }
        }
    }
    const byKind = {}
    for (const item of removed) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    const event = {
        event_id: eventId,
        apply,
        candidates: plan.items.length,
        candidate_bytes: plan.items.reduce((sum, item) => sum + item.bytes, 0),
        removed: removed.length,
        removed_by_kind: byKind,
        bytes_freed: removed.reduce((sum, item) => sum + item.bytes, 0),
        failed: failed.length,
        processes_scanned: plan.processes_scanned,
    }
    appendDiagnostic('janitor', { ...event, items: plan.items.slice(0, ITEM_LIST_CAP).map((item) => ({ kind: item.kind, path: item.path, bytes: item.bytes, reason: item.reason })) })
    return { outcome: 'swept', ...event, items: plan.items, failures: failed }
}
