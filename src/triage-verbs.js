// Operator verbs that replace the scripts in scripts/triage: writer_lock (writer-lock.sh), write_queue
// (write-queue.sh), shards (shards.sh), publish_on_origin (publish-on-origin.sh), spool_orphans
// (spool-orphans.sh) and resources (resources.sh). They are local tools bound on gm the way gm_result is:
// no request is written to a spool, so they answer without a daemon.
//
// Every reply is flat `key: value` text. exit_code carries the script's exit status. 0 answers ok: true.
// 1 is a refusal the script printed before it failed (a held lock, a dirty checkout, a rejected push): it
// answers ok: false with error_code and returns normally, as an exec child's nonzero exit does. 2 is a usage
// or input error and throws like any failed verb (isError).

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { lastTableError, readProcessTableAsync } from './process-table.js'
import { appendDiagnostic } from './server-log.js'
import { appendRowNote, checkReferences, ensureReferenceGate, readRow, recordedUrls, REFERENCE_CAP, referenceGateRefusal, runGhSearch, searchPlan, validRowId } from './public-search.js'

const LOCAL_TIMEOUT_MS = 60_000
const NETWORK_TIMEOUT_MS = 180_000
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const EMPTY = Buffer.alloc(0)
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' }
// Every commit this verb builds carries the lanmower identity, whatever git identity the host process inherits.
const PUBLISH_IDENTITY = {
    GIT_AUTHOR_NAME: 'lanmower',
    GIT_AUTHOR_EMAIL: 'almagestfraternite@gmail.com',
    GIT_COMMITTER_NAME: 'lanmower',
    GIT_COMMITTER_EMAIL: 'almagestfraternite@gmail.com',
}
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const LINE_UNSAFE = /[\t\r\n\0]/
const WRITE_COMMAND = /git (?:add|commit|push|pull|merge|rebase|reset|checkout)/
const SHARD_OWNERS = ['rs-plugkit', 'gm-mcp', 'agentplug', 'ci-scripts', 'skills-docs', 'other']
const SHARD_OWNER_RULES = [
    ['rs-plugkit', ['rs-plugkit', 'plugkit-core', 'wasm_dispatch', 'dream_rsi', 'orchestrator']],
    ['agentplug', ['agentplug', 'daemon', 'runner']],
    ['gm-mcp', ['gm-mcp', 'codemode', 'spool-transport']],
    ['ci-scripts', ['ci', 'workflow', 'bump-pins', 'github']],
    ['skills-docs', ['skill', 'docs/', 'readme']],
]
const SHARD_ROWS = 20
const SHARD_LIMIT = 100
const QUEUE_LOCK_WAIT_MS = 5_000
const QUEUE_LOCK_STALE_MS = 30_000
const CPU_SAMPLE_MS = 500
const CLOSE_STATUSES = ['resolved', 'stale']
const WITNESS_ID = /^\d+-\d+-[0-9a-f]+$/
const PROC = '/proc'

class VerbFault extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

const usage = (message) => new VerbFault('usage', message)
const ok = (result, fields = [], lines = []) => ({ exit: 0, result, fields, lines })
const refused = (code, result, fields = [], lines = []) => ({ exit: 1, code, result, fields, lines })

const LEDGER_BODY_MAX = 2000

function answer({ exit, code = null, error = null, result = null, dispatchId = null, fields = [], lines = [] }) {
    const head = [`ok: ${exit === 0}`]
    if (code !== null) head.push(`error_code: ${code}`)
    if (error !== null) head.push(`error: ${error}`)
    head.push(`exit_code: ${exit}`)
    if (dispatchId !== null) head.push(`dispatch_id: ${dispatchId}`)
    if (result !== null) head.push(`result: ${result}`)
    return [...head, ...fields.map(([key, value]) => `${key}: ${value}`), ...lines].join('\n')
}

// A dispatch id in the runner's shape (<ms>-<pid>-<hex>), so prd-resolve reads it like any runner dispatch.
const newDispatchId = () => `${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}`

function callerRoot(args) {
    try {
        return rootOf(args)
    } catch {
        return null
    }
}

// True when the ledger does not end with a newline, so the next append must start a new line first.
function needsNewline(file) {
    const size = statOf(file)?.size ?? 0
    if (size === 0) return false
    const fd = fs.openSync(file, 'r')
    try {
        const last = Buffer.alloc(1)
        fs.readSync(fd, last, 0, 1, size - 1)
        return last[0] !== 0x0a
    } finally {
        fs.closeSync(fd)
    }
}

// Appends the two lines a runner dispatch leaves in .gm/exec-spool/.dispatch-ledger.json (rs-plugkit dispatch_ledger.rs
// record): the entry, then its reply_sha256. prd-resolve attributes a witness only through these lines. Returns the
// failure text, or null when both lines were appended.
function recordTriageDispatch(root, { dispatchId, verb, sessionId, exit, args, text }) {
    try {
        const request = JSON.stringify(args)
        const file = path.join(root, '.gm', 'exec-spool', '.dispatch-ledger.json')
        const entry = {
            cwd: root,
            dispatch_id: dispatchId,
            exit_code: exit,
            fingerprint: createHash('sha256').update(`${verb}\n${request}`).digest('hex').slice(0, 16),
            output_bytes: Buffer.byteLength(text),
            request_body: request.slice(0, LEDGER_BODY_MAX),
            request_body_truncated: request.length > LEDGER_BODY_MAX,
            session_id: sessionId,
            ts: Date.now(),
            verb,
        }
        const reply = { dispatch_id: dispatchId, reply_sha256: createHash('sha256').update(text).digest('hex') }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.appendFileSync(file, `${needsNewline(file) ? '\n' : ''}${JSON.stringify(entry)}\n${JSON.stringify(reply)}\n`)
        return null
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
}

// Wraps a verb body: a returned object is the reply (exit 0 or 1); a thrown error is a usage or input error (exit 2).
// Each reply carries its dispatch_id, and the dispatch is recorded in the project ledger under the caller's session.
function toolReply(verb, body) {
    return async (args = {}) => {
        const dispatchId = newDispatchId()
        let reply
        try {
            reply = await body(args)
        } catch (error) {
            const fault = error instanceof VerbFault ? error : new VerbFault('internal', error instanceof Error ? error.message : String(error))
            reply = { exit: 2, code: fault.code, error: fault.message, isError: true }
        }
        const text = answer({ ...reply, dispatchId })
        const root = callerRoot(args)
        const sessionId = [args.session_id, args.session].find((value) => typeof value === 'string' && value !== '') ?? null
        const ledgerError = root === null ? null : recordTriageDispatch(root, { dispatchId, verb, sessionId, exit: reply.exit, args, text })
        return {
            content: [{ type: 'text', text: ledgerError === null ? text : `${text}\nledger_error: ${ledgerError}` }],
            ...(reply.isError === true ? { isError: true } : {}),
        }
    }
}

function run(file, args, { cwd, env, timeout = LOCAL_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const options = { cwd, env: env === undefined ? process.env : { ...process.env, ...env }, encoding: 'buffer', maxBuffer: MAX_OUTPUT_BYTES, timeout, windowsHide: true }
        execFile(file, args, options, (error, stdout, stderr) => {
            const status = error === null ? 0 : Number.isInteger(error.code) ? error.code : 1
            resolve({ status, stdout: stdout ?? EMPTY, stderr: stderr ?? EMPTY })
        })
    })
}

const utf8 = (buffer) => buffer.toString('utf8')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
const mb = (kb) => Math.trunc(kb / 1024)

function statOf(file) {
    try {
        return fs.statSync(file)
    } catch {
        return null
    }
}

const isFile = (file) => statOf(file)?.isFile() === true
const isDirectory = (file) => statOf(file)?.isDirectory() === true

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

function tempBeside(file) {
    return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

// Temp file in the same directory, then rename: a reader sees the old file or the new one, never a partial write.
function writeAtomic(file, data) {
    const tmp = tempBeside(file)
    try {
        fs.writeFileSync(tmp, data)
        fs.renameSync(tmp, file)
    } catch (error) {
        fs.rmSync(tmp, { force: true })
        throw error
    }
}

function utcStamp(now = new Date()) {
    return now.toISOString().slice(0, 19).replace(/[-:]/g, '')
}

function rootOf(args) {
    if (typeof args.cwd !== 'string' || args.cwd.trim() === '') throw new VerbFault('cwd_required', 'cwd is required: pass the gm checkout root that holds .gm/ (the verb never guesses a root)')
    return path.resolve(args.cwd)
}

function repoName(value) {
    if (typeof value !== 'string' || !SAFE_NAME.test(value) || value.includes('..')) throw usage('repo must be one path component, such as gm or rs-plugkit')
    return value
}

function singleLine(value, name) {
    if (typeof value !== 'string' || value === '' || LINE_UNSAFE.test(value)) throw usage(`${name} must be a non-empty single line`)
    return value
}

// The holder as `cat` reads it: trailing newlines removed. Null when the lock is absent.
function readHolder(file) {
    const text = readText(file)
    return text === null ? null : text.replace(/\n+$/, '')
}

// The host process table, or the reason liveness is unmeasured. A failed ps can come back as an empty table with no
// recorded error, and a live host always lists at least this process, so an empty table is unmeasured too.
async function measuredTable() {
    const rows = await readProcessTableAsync()
    const error = lastTableError() ?? (rows.length === 0 ? 'no process rows (ps unavailable?)' : null)
    return { rows, error }
}

// ---------------------------------------------------------------- writer_lock (writer-lock.sh)

async function writerLock(args) {
    const root = rootOf(args)
    const action = args.action.replace(/-/g, '_')
    const repo = repoName(args.repo)
    const dir = path.join(root, '.gm', 'locks')
    fs.mkdirSync(dir, { recursive: true })
    const lock = path.join(dir, `${repo}.writer`)

    if (action === 'take') {
        const session = singleLine(args.session ?? args.session_id, 'session')
        const tmp = tempBeside(lock)
        fs.writeFileSync(tmp, `${session}\n`)
        try {
            // A hard link of the temp file is an atomic create: it fails with EEXIST while a holder exists, and the marker is whole when it appears.
            fs.linkSync(tmp, lock)
        } catch (error) {
            if (error.code === 'EEXIST') return refused('held', `held by ${readHolder(lock) ?? ''}`)
            throw error
        } finally {
            fs.rmSync(tmp, { force: true })
        }
        return ok(`took ${repo} for ${session}`, [['repo', repo], ['holder', session]])
    }

    if (action === 'release') {
        const session = singleLine(args.session ?? args.session_id, 'session')
        if (readHolder(lock) !== session) return refused('not_holder', `not the holder of ${repo}`)
        fs.rmSync(lock, { force: true })
        return ok(`released ${repo}`, [['repo', repo]])
    }

    if (action === 'status') return ok(readHolder(lock) ?? 'free', [['repo', repo]])

    if (action === 'check') {
        const checkout = repo === 'gm' ? root : path.join(root, repo)
        const fetched = await run('git', ['fetch', '-q', 'origin', 'main'], { cwd: checkout, env: NO_PROMPT, timeout: NETWORK_TIMEOUT_MS })
        const status = await run('git', ['status', '--porcelain'], { cwd: checkout })
        const dirty = utf8(status.stdout).split('\n').filter((line) => line !== '' && !line.startsWith(' D .gm/dream-rsi')).length
        const counted = await run('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: checkout })
        const ahead = counted.status === 0 ? utf8(counted.stdout).trim() : null
        const clean = dirty === 0 && ahead === '0'
        const result = `${repo}: dirty=${dirty} ahead=${ahead ?? ''}`
        const fields = [['fetch', fetched.status === 0 ? 'ok' : 'failed']]
        return clean ? ok(result, fields) : refused('not_clean', result, fields)
    }

    if (action === 'quarantine_stale') {
        if (!isFile(lock)) return ok('free', [['repo', repo]])
        const holder = readHolder(lock)
        if (holder === null) return ok('free', [['repo', repo]])
        const table = await measuredTable()
        if (table.error !== null) return refused('process_table_unreadable', `process table unreadable (${table.error}); lock kept`)
        const others = table.rows.filter((row) => row.pid !== process.pid)
        if (others.some((row) => WRITE_COMMAND.test(row.command) && !row.command.includes('grep'))) return refused('git_write_live', 'a git write is live; lock kept')
        if (others.some((row) => row.command.includes(holder))) return refused('holder_live', `holder ${holder} is live; lock kept`)
        const stamp = utcStamp()
        let target = path.join(dir, `quarantine-stale-${stamp}`)
        for (let n = 2; fs.existsSync(path.join(target, `${repo}.writer`)); n += 1) target = path.join(dir, `quarantine-stale-${stamp}-${n}`)
        fs.mkdirSync(target, { recursive: true })
        const moved = path.join(target, `${repo}.writer`)
        fs.renameSync(lock, moved)
        if (readHolder(moved) !== holder) {
            // The lock changed hands between the check and the move: put it back when no lock has taken its place.
            try {
                fs.linkSync(moved, lock)
                fs.rmSync(moved, { force: true })
            } catch {
                // A new lock took the path: the moved file stays in quarantine.
            }
            const where = fs.existsSync(moved) ? `the moved file is kept at ${moved}` : 'the lock is restored'
            return refused('holder_changed', `lock changed hands during quarantine; ${where}`)
        }
        return ok(`quarantined ${repo} lock held by ${holder} to ${target}`, [['repo', repo], ['holder', holder]])
    }

    throw usage(`unknown action ${args.action}`)
}

// ---------------------------------------------------------------- write_queue (write-queue.sh)

// Read-modify-write under a lock file created with an exclusive create. A lock older than QUEUE_LOCK_STALE_MS is a dead writer's and is removed.
async function withQueueLock(file, body) {
    const lock = `${file}.lock`
    const deadline = Date.now() + QUEUE_LOCK_WAIT_MS
    for (;;) {
        try {
            fs.closeSync(fs.openSync(lock, 'wx'))
            break
        } catch (error) {
            if (error.code !== 'EEXIST') throw error
            const found = statOf(lock)
            if (found !== null && Date.now() - found.mtimeMs > QUEUE_LOCK_STALE_MS) {
                fs.rmSync(lock, { force: true })
                continue
            }
            if (Date.now() >= deadline) return refused('queue_busy', `${path.basename(file)} is locked by another writer; try again`)
            await sleep(50)
        }
    }
    try {
        return await body()
    } finally {
        fs.rmSync(lock, { force: true })
    }
}

async function writeQueue(args) {
    const root = rootOf(args)
    const repo = repoName(args.repo)
    const dir = path.join(root, '.gm', 'queues')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${repo}.rows`)

    if (args.action === 'list') {
        const rows = (readText(file) ?? '').split('\n').filter((line) => line !== '')
        return rows.length === 0 ? ok(`queue empty for ${repo}`) : ok(`queue for ${repo}: ${rows.length} row(s)`, [], rows)
    }

    const row = singleLine(args.row, 'row')
    return withQueueLock(file, async () => {
        const current = readText(file)
        const lines = (current ?? '').split('\n').filter((line) => line !== '')
        if (args.action === 'add') {
            if (lines.some((line) => line.startsWith(`${row}\t`))) return ok(`already queued: ${row}`)
            const note = (args.note ?? '').replace(/[\t\n]/g, ' ')
            writeAtomic(file, [...lines, `${row}\t${note}`].map((line) => `${line}\n`).join(''))
            return ok(`queued ${row} for ${repo}`)
        }
        if (current === null) return ok(`queue empty for ${repo}`)
        writeAtomic(file, lines.filter((line) => !line.startsWith(`${row}\t`)).map((line) => `${line}\n`).join(''))
        return ok(`done ${row} for ${repo}`)
    })
}

// ---------------------------------------------------------------- shards (shards.sh)

// "ci" is a whole word here: as a substring it matches almost any row text (the script's *ci* glob did that).
const hasNeedle = (lower, needle) => needle === 'ci' ? /(^|[^a-z0-9])ci([^a-z0-9]|$)/.test(lower) : lower.includes(needle)

function ownerOf(text) {
    const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase())
    for (const [owner, needles] of SHARD_OWNER_RULES) if (needles.some((needle) => hasNeedle(lower, needle))) return owner
    return 'other'
}

async function shardsVerb(args) {
    const root = rootOf(args)
    const outDir = typeof args.out_dir === 'string' && args.out_dir !== '' ? path.resolve(root, args.out_dir) : path.join(root, '.gm', 'drain-shards', utcStamp())
    if (fs.existsSync(outDir)) return refused('out_exists', `exists: ${outDir} (choose a new directory)`)

    const prd = path.join(root, '.gm', 'prd')
    let names = []
    try {
        names = fs.readdirSync(prd).filter((name) => name.endsWith('.yml') && !name.startsWith('.'))
    } catch {
        names = []
    }
    const byOwner = new Map(SHARD_OWNERS.map((owner) => [owner, []]))
    for (const name of names) {
        const file = path.join(prd, name)
        if (!isFile(file)) continue
        const text = fs.readFileSync(file, 'utf8')
        const idLine = text.split('\n').find((line) => line.startsWith('id: '))
        const id = idLine === undefined ? '' : idLine.slice('id: '.length)
        if (id === '') continue
        byOwner.get(ownerOf(text)).push(id)
    }

    // Checked before anything is written: split's two-digit suffixes end at 99, so an owner needing more shards is refused whole.
    const plan = []
    for (const owner of SHARD_OWNERS) {
        const ids = byOwner.get(owner)
        if (ids.length === 0) continue
        const sorted = [...ids].sort(byBytes)
        const chunks = []
        for (let i = 0; i < sorted.length; i += SHARD_ROWS) chunks.push(sorted.slice(i, i + SHARD_ROWS))
        if (chunks.length > SHARD_LIMIT) return refused('too_many_shards', `${owner} needs ${chunks.length} shards; names run to ${owner}-99 only; nothing written`)
        plan.push({ owner, sorted, chunks })
    }

    fs.mkdirSync(outDir, { recursive: true })
    const lines = []
    let total = 0
    for (const { owner, sorted, chunks } of plan) {
        writeAtomic(path.join(outDir, `${owner}.all`), sorted.map((id) => `${id}\n`).join(''))
        chunks.forEach((chunk, index) => {
            const name = `${owner}-${String(index).padStart(2, '0')}`
            writeAtomic(path.join(outDir, name), chunk.map((id) => `${id}\n`).join(''))
            total += chunk.length
            lines.push(`${name} ${chunk.length}`)
        })
    }
    return ok(`total ${total} into ${outDir}`, [['out_dir', outDir]], lines)
}

// ---------------------------------------------------------------- publish_on_origin (publish-on-origin.sh)

function publishPath(value) {
    const bad = typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)
        || value.split('/').some((part) => part === '' || part === '.' || part === '..')
    if (bad) throw usage(`path ${JSON.stringify(value)} must be relative to the repository, with forward slashes and no empty, "." or ".." parts`)
    return value
}

function commitMessage(value) {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) throw usage('message must be a non-empty commit message')
    return value
}

// A closing witness must be a dispatch the spool ledger recorded (one JSON object per line, keyed dispatch_id).
function isLedgerWitness(root, id) {
    const ledger = readText(path.join(root, '.gm', 'exec-spool', '.dispatch-ledger.json'))
    return ledger !== null && ledger.includes(`"dispatch_id":"${id}"`)
}

function isExecutable(file) {
    if (process.platform === 'win32') return false
    try {
        fs.accessSync(file, fs.constants.X_OK)
        return true
    } catch {
        return false
    }
}

async function hashBlob(repo, file) {
    const hashed = await run('git', ['hash-object', '-w', file], { cwd: repo })
    const blob = utf8(hashed.stdout).trim()
    return hashed.status === 0 && blob !== '' ? blob : null
}

// The first conflict block of a merge-file result: its 1-based line span in the merged text and up to 30 of its lines.
function firstConflict(merged) {
    const lines = merged.split('\n')
    const start = lines.findIndex((line) => line.startsWith('<<<<<<<'))
    const end = lines.findIndex((line, index) => index > start && line.startsWith('>>>>>>>'))
    const last = end < 0 ? lines.length - 1 : end
    return { from: start + 1, to: last + 1, lines: lines.slice(start, last + 1).slice(0, 30).map((line) => `| ${line}`) }
}

async function publishOnOrigin(args) {
    const root = rootOf(args)
    const repo = path.resolve(root, singleLine(args.repo_dir, 'repo_dir'))
    if (!isDirectory(repo)) return refused('repo_missing', `${repo} is not a directory; nothing pushed`)
    const row = singleLine(args.row, 'row')
    const message = commitMessage(args.message)
    const paths = args.paths.map(publishPath)
    // The checker lives in the gm checkout's scripts/; a submodule checkout publishes with that root as cwd, or with its own scripts/.
    const checkerIn = (base) => path.join(base, 'scripts', 'check-staged-secrets.mjs')
    const checker = [root, repo].map(checkerIn).find(isFile) ?? checkerIn(root)
    if (!isFile(checker)) return refused('checker_missing', `secrets checker not found at ${checkerIn(root)} or ${checkerIn(repo)}; nothing pushed`)
    const removedRowFile = paths.some((p) => p.startsWith('.gm/prd/') && p.includes(row) && !isFile(path.join(repo, p)))
    const closing = args.witness !== undefined || args.status !== undefined || removedRowFile
    if (closing && (!CLOSE_STATUSES.includes(args.status) || !WITNESS_ID.test(String(args.witness ?? '')) || !isLedgerWitness(root, args.witness))) {
        return refused('witness_required', `closing row ${row} needs witness (a dispatch id in .gm/exec-spool/.dispatch-ledger.json) and status resolved or stale; nothing pushed`)
    }
    if (closing) await ensureReferenceGate(root)
    const unreferenced = closing ? referenceGateRefusal(root, row, 'publish_on_origin closing commit') : null
    if (unreferenced !== null) return refused('references_required', unreferenced)
    const trailers = closing ? ['-m', `Witness: ${args.witness}`, '-m', `Status: ${args.status}`] : []
    const fetched = await run('git', ['fetch', '-q', 'origin', 'main'], { cwd: repo, env: NO_PROMPT, timeout: NETWORK_TIMEOUT_MS })
    if (fetched.status !== 0) return refused('fetch_failed', 'fetch failed; nothing pushed')
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-publish-'))
    try {
        const givenBase = typeof args.publish_base === 'string' && args.publish_base !== '' ? args.publish_base : null
        return await publishLane({ repo, row, message, paths, givenBase, dryRun: args.dry_run === true, checker, work, trailers })
    } finally {
        fs.rmSync(work, { recursive: true, force: true })
    }
}

function gitlinkOf(result) {
    const found = /^160000 (?:commit )?([0-9a-f]{40,64})\b/m.exec(utf8(result.stdout))
    return found === null ? null : found[1]
}

// Replays the one commit built on the old origin/main onto the current tip with git's three-way merge (merge-tree --write-tree).
// Only that commit's change moves; the lane's edits are not re-run. A conflict is refused with its paths and nothing is pushed.
async function rebaseCommitOntoTip({ repo, commit, row, message, paths, checker, work, trailers }) {
    const plain = (gitArgs, extra = {}) => run('git', gitArgs, { cwd: repo, ...extra })
    const indexEnv = { GIT_INDEX_FILE: path.join(work, 'rebase-index') }
    const indexed = (gitArgs) => run('git', gitArgs, { cwd: repo, env: indexEnv })
    const tip = utf8((await plain(['rev-parse', '--verify', 'origin/main^{commit}'])).stdout).trim()
    const merged = await plain(['merge-tree', '--write-tree', '--name-only', tip, commit])
    if (merged.status !== 0 && merged.status !== 1) {
        return { refusal: refused('rebase_failed', `git merge-tree --write-tree could not replay ${commit} onto ${tip} (git 2.38 or newer is required); nothing pushed`, [['commit', commit]]) }
    }
    const lines = utf8(merged.stdout).split('\n')
    if (merged.status === 1) {
        const conflicted = []
        for (const line of lines.slice(1)) {
            if (line === '') break
            conflicted.push(line)
        }
        return { refusal: refused('rebase_conflict', `replaying ${commit} onto ${tip} conflicts; nothing pushed`, [['commit', commit], ['onto', tip]], conflicted) }
    }
    const tree = lines[0].trim()
    if ((await indexed(['read-tree', tree])).status !== 0) return { refusal: refused('read_tree_failed', 'read-tree failed on the rebased tree; nothing pushed') }
    const committed = await plain(['commit-tree', tree, '-p', tip, '-m', message, '-m', `Row: ${row}`, ...trailers], { env: PUBLISH_IDENTITY })
    const sha = utf8(committed.stdout).trim()
    if (committed.status !== 0 || sha === '') return { refusal: refused('commit_failed', 'commit-tree failed for the rebased commit; nothing pushed') }
    const changed = utf8((await plain(['diff', '--name-only', '--no-renames', '-z', tip, sha])).stdout).split('\0').filter((name) => name !== '')
    const unintended = changed.filter((name) => !paths.includes(name) && name !== 'skills/manifest.sha256')
    if (unintended.length > 0) return { refusal: refused('unintended_paths', 'rebased commit changes paths outside the list; nothing pushed', [['commit', sha]], unintended) }
    const scan = await run(process.execPath, [checker], { cwd: repo, env: indexEnv })
    if (scan.status !== 0) return { refusal: refused('secrets_check_failed', 'secrets check failed on the rebased commit; nothing pushed', [['commit', sha]]) }
    const stat = utf8((await plain(['diff', '--stat', tip, sha])).stdout).split('\n').filter((line) => line !== '').slice(-3)
    return { sha, stat }
}

async function publishLane({ repo, row, message, paths, givenBase, dryRun, checker, work, trailers = [] }) {
    const plain = (gitArgs, extra = {}) => run('git', gitArgs, { cwd: repo, ...extra })
    const indexEnv = { GIT_INDEX_FILE: path.join(work, 'index') }
    const indexed = (gitArgs) => run('git', gitArgs, { cwd: repo, env: indexEnv })

    // The fork point is merge-base(HEAD, publish_base), default origin/main. A publish_base that moved past the lane's copy
    // resolves back to that copy here, so origin text newer than the copy is never the three-way base (that base is origin/main
    // itself, which takes the lane's whole file and reverts origin's newer hunks).
    const forkRef = givenBase ?? 'origin/main'
    const found = await plain(['merge-base', 'HEAD', forkRef])
    if (found.status !== 0) return refused('no_merge_base', `no merge base between HEAD and ${forkRef}; nothing pushed`)
    const base = utf8(found.stdout).trim()
    if ((await indexed(['read-tree', 'origin/main'])).status !== 0) return refused('read_tree_failed', 'read-tree failed; nothing pushed')

    for (const [index, p] of paths.entries()) {
        const full = path.join(repo, p)
        const lanePin = gitlinkOf(await plain(['ls-files', '-s', '--', p])) ?? gitlinkOf(await plain(['ls-tree', 'HEAD', '--', p]))
        const basePin = gitlinkOf(await plain(['ls-tree', base, '--', p]))
        const originPin = gitlinkOf(await indexed(['ls-files', '-s', '--', p]))
        if (lanePin !== null) {
            if (lanePin === basePin || lanePin === originPin) continue
            if (originPin !== null && originPin !== basePin) return refused('merge_conflict', `submodule ${p} moved on origin/main to ${originPin}; the lane pins ${lanePin}; nothing pushed`)
            if ((await indexed(['update-index', '--add', '--cacheinfo', `160000,${lanePin},${p}`])).status !== 0) return refused('index_failed', `update-index failed for ${p}; nothing pushed`)
            continue
        }
        if (isFile(full)) {
            // The lane's change (its working-tree file against the fork point) is three-way merged onto origin/main, so origin's hunks outside it survive.
            const from = await plain(['show', `${base}:${p}`])
            const theirs = await plain(['show', `origin/main:${p}`])
            const scratch = (suffix) => path.join(work, `${index}.${suffix}`)
            fs.writeFileSync(scratch('base'), from.status === 0 ? from.stdout : EMPTY)
            fs.writeFileSync(scratch('theirs'), theirs.status === 0 ? theirs.stdout : EMPTY)
            fs.writeFileSync(scratch('ours'), fs.readFileSync(full))
            const merge = await plain(['merge-file', '-p', scratch('ours'), scratch('base'), scratch('theirs')])
            const merged = utf8(merge.stdout)
            if (merged.split('\n').some((line) => line.startsWith('<<<<<<<'))) {
                const hunk = firstConflict(merged)
                return refused('merge_conflict', `${p} conflicts with origin/main at lines ${hunk.from}-${hunk.to} (fork ${base}); nothing pushed`, [['path', p], ['fork', base]], hunk.lines)
            }
            if (merge.status !== 0) return refused('merge_failed', `merge-file failed on ${p}; nothing pushed`, [['path', p], ['fork', base]])
            fs.writeFileSync(scratch('merged'), merge.stdout)
            const blob = await hashBlob(repo, scratch('merged'))
            if (blob === null) return refused('hash_failed', `empty blob sha for ${p}; nothing pushed`)
            const mode = isExecutable(full) ? '100755' : '100644'
            if ((await indexed(['update-index', '--add', '--cacheinfo', `${mode},${blob},${p}`])).status !== 0) return refused('index_failed', `update-index failed for ${p}; nothing pushed`)
        } else if (originPin === null && !isDirectory(full)) {
            if ((await indexed(['update-index', '--force-remove', p])).status !== 0) return refused('index_failed', `update-index failed for ${p}; nothing pushed`)
        }
    }

    if (paths.some((p) => p.startsWith('skills/'))) {
        const listed = await indexed(['ls-files', '-z', 'skills/'])
        const names = utf8(listed.stdout).split('\0').filter((name) => name !== '').map((name) => name.slice('skills/'.length)).sort(byBytes)
        let manifest = ''
        for (const name of names) {
            if (name === 'manifest.sha256') continue
            const content = await indexed(['cat-file', '-p', `:skills/${name}`])
            manifest += `${createHash('sha256').update(content.stdout).digest('hex')}  ${name}\n`
        }
        fs.writeFileSync(path.join(work, 'manifest'), manifest)
        const blob = await hashBlob(repo, path.join(work, 'manifest'))
        if (blob === null) return refused('hash_failed', 'empty blob sha for skills/manifest.sha256; nothing pushed')
        if ((await indexed(['update-index', '--add', '--cacheinfo', `100644,${blob},skills/manifest.sha256`])).status !== 0) return refused('index_failed', 'update-index failed for skills/manifest.sha256; nothing pushed')
    }

    const tree = await indexed(['write-tree'])
    if (tree.status !== 0) return refused('write_tree_failed', 'write-tree failed; nothing pushed')
    const committed = await plain(['commit-tree', utf8(tree.stdout).trim(), '-p', 'origin/main', '-m', message, '-m', `Row: ${row}`, ...trailers], { env: PUBLISH_IDENTITY })
    const sha = utf8(committed.stdout).trim()
    if (committed.status !== 0 || sha === '') return refused('commit_failed', 'commit-tree failed; nothing pushed')

    let stat = utf8((await plain(['diff', '--stat', 'origin/main', sha])).stdout).split('\n').filter((line) => line !== '').slice(-3)
    const changed = utf8((await plain(['diff', '--name-only', '--no-renames', '-z', 'origin/main', sha])).stdout).split('\0').filter((name) => name !== '')
    const unintended = changed.filter((name) => !paths.includes(name) && name !== 'skills/manifest.sha256')
    if (unintended.length > 0) return refused('unintended_paths', 'commit changes paths outside the list; nothing pushed', [['commit', sha]], unintended)

    const scan = await run(process.execPath, [checker], { cwd: repo, env: indexEnv })
    if (scan.status !== 0) {
        const output = `${utf8(scan.stdout)}\n${utf8(scan.stderr)}`.split('\n').filter((line) => line.trim() !== '')
        return refused('secrets_check_failed', 'secrets check failed; nothing pushed', [['commit', sha], ['secrets', output.at(-1) ?? '']])
    }

    if (dryRun) return ok(`dry run: built ${sha} on origin/main, secrets check passed, not pushed`, [['commit', sha], ['fork', base]], stat)

    let landedSha = sha
    const pushed = await plain(['push', '-q', 'origin', `${sha}:refs/heads/main`], { env: NO_PROMPT, timeout: NETWORK_TIMEOUT_MS })
    if (pushed.status !== 0) {
        // origin moved between the build and the push: replay this one commit onto the new tip and push it once more; the lane's edits are not re-run.
        const refetched = await plain(['fetch', '-q', 'origin', 'main'], { env: NO_PROMPT, timeout: NETWORK_TIMEOUT_MS })
        if (refetched.status !== 0) return refused('push_refused', 'push refused and refetch failed; nothing landed', [['commit', sha]])
        const rebased = await rebaseCommitOntoTip({ repo, commit: sha, row, message, paths, checker, work, trailers })
        if (rebased.refusal) return rebased.refusal
        landedSha = rebased.sha
        stat = rebased.stat
        const retry = await plain(['push', '-q', 'origin', `${landedSha}:refs/heads/main`], { env: NO_PROMPT, timeout: NETWORK_TIMEOUT_MS })
        if (retry.status !== 0) return refused('push_refused', 'push refused again after one rebase; nothing landed', [['commit', landedSha]])
    }
    await plain(['fetch', '-q', 'origin', 'main'], { env: NO_PROMPT, timeout: NETWORK_TIMEOUT_MS })
    const landed = await plain(['merge-base', '--is-ancestor', landedSha, 'origin/main'])
    if (landed.status === 0) return ok(`published ${landedSha} on origin/main`, [['commit', landedSha], ['fork', base]], stat)
    return refused('not_on_origin', `push reported success but ${landedSha} is not on origin/main`, [['commit', landedSha]])
}

// ---------------------------------------------------------------- spool_orphans (spool-orphans.sh)

function rootFrom(value, cwd) {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) throw usage('each root must be a non-empty path')
    if (path.isAbsolute(value)) return path.normalize(value)
    if (typeof cwd !== 'string' || cwd === '') throw new VerbFault('cwd_required', `relative root ${value} needs cwd to resolve against`)
    return path.resolve(cwd, value)
}

// Every regular file under dir (symlinks are not followed, as find -type f does), with its depth below dir (dir's children are depth 1).
function listFiles(dir) {
    const found = []
    const walk = (current, depth) => {
        let entries = []
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full, depth + 1)
            } else if (entry.isFile()) {
                const stat = statOf(full)
                if (stat !== null) found.push({ full, name: entry.name, depth, mtimeMs: stat.mtimeMs })
            }
        }
    }
    walk(dir, 1)
    return found.sort((a, b) => byBytes(a.full, b.full))
}

function moveAside(file, spool, quarantine) {
    const rel = path.relative(spool, file.full).split(path.sep).join('/')
    const dest = path.join(quarantine, rel)
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.renameSync(file.full, dest)
        return { moved: true, line: `moved    ${file.full} to ${dest}` }
    } catch (error) {
        return { moved: false, line: `failed   ${file.full}: ${error.message}` }
    }
}

async function spoolOrphans(args) {
    const dry = args.dry_run === true
    const roots = args.roots.map((root) => rootFrom(root, args.cwd))
    // A process table that cannot be read leaves liveness unmeasured: nothing is moved on an unmeasured answer.
    const table = await measuredTable()
    if (table.error !== null) return refused('process_table_unreadable', `process table unreadable (${table.error}); nothing moved`)
    const live = (id) => table.rows.some((row) => row.pid !== process.pid && row.command.includes(id))
    const now = Date.now()
    const lines = []
    const counts = { live: 0, orphan: 0, moved: 0, unserved: 0, failed: 0 }
    const record = (entry) => {
        counts[entry.moved ? 'moved' : 'failed'] += 1
        lines.push(entry.line)
    }

    for (const root of roots) {
        const spool = path.join(root, '.gm', 'exec-spool', 'in')
        if (!isDirectory(spool)) {
            lines.push(`skipped  ${root} (no .gm/exec-spool/in)`)
            continue
        }
        const files = listFiles(spool)
        const quarantine = path.join(root, '.gm', 'exec-spool', `in-quarantine-orphan-${utcStamp()}`)
        for (const file of files.filter((entry) => entry.name.endsWith('.inflight'))) {
            const id = file.name.endsWith('.txt.inflight') ? file.name.slice(0, -'.txt.inflight'.length) : file.name
            if (live(id)) {
                counts.live += 1
                lines.push(`live     ${file.full}`)
            } else if (dry) {
                counts.orphan += 1
                lines.push(`orphan   ${file.full}`)
            } else {
                record(moveAside(file, spool, quarantine))
            }
        }
        if (args.unserved !== undefined) {
            const stale = files.filter((entry) => entry.depth >= 2 && entry.name.endsWith('.txt') && Math.floor((now - entry.mtimeMs) / 60_000) > args.unserved)
            for (const file of stale) {
                if (dry) {
                    counts.unserved += 1
                    lines.push(`unserved ${file.full}`)
                } else {
                    record(moveAside(file, spool, quarantine))
                }
            }
        }
    }
    // Exit 0 as the script always did; a file that could not move is reported as a failed line and counted.
    return ok(`live ${counts.live}, orphan ${counts.orphan}, moved ${counts.moved}, unserved ${counts.unserved}, failed ${counts.failed}`, [], lines)
}

// ---------------------------------------------------------------- resources (resources.sh)

function readMeminfo() {
    const text = readText(`${PROC}/meminfo`)
    if (text === null) return null
    const values = {}
    for (const line of text.split('\n')) {
        const match = /^(\w+):\s+(\d+)/.exec(line)
        if (match !== null) values[match[1]] = Number(match[2])
    }
    return values
}

function memoryLines() {
    const mem = readMeminfo()
    if (mem === null) return ['ram  unavailable (no /proc/meminfo on this platform)']
    const total = mem.MemTotal
    const avail = mem.MemAvailable ?? (mem.MemFree + (mem.Buffers ?? 0) + (mem.Cached ?? 0))
    const swapTotal = mem.SwapTotal ?? 0
    const swapFree = mem.SwapFree ?? 0
    return [
        `ram  used ${mb(total - avail)}M avail ${mb(avail)}M total ${mb(total)}M`,
        `swap used ${mb(swapTotal - swapFree)}M of ${mb(swapTotal)}M`,
    ]
}

function cpuTotals() {
    const totals = { user: 0, sys: 0, idle: 0, all: 0 }
    for (const cpu of os.cpus()) {
        const times = cpu.times
        totals.user += times.user
        totals.sys += times.sys
        totals.idle += times.idle
        totals.all += times.user + times.nice + times.sys + times.idle + times.irq
    }
    return totals
}

async function cpuLine() {
    const before = cpuTotals()
    await sleep(CPU_SAMPLE_MS)
    const after = cpuTotals()
    const span = after.all - before.all
    const share = (key) => (span > 0 ? (((after[key] - before[key]) * 100) / span).toFixed(1) : '0.0')
    return `cpu  user ${share('user')} sys ${share('sys')} idle ${share('idle')}`
}

function diskLine(target) {
    if (typeof fs.statfsSync !== 'function') return null
    let stats = null
    try {
        stats = fs.statfsSync(target)
    } catch {
        return null
    }
    const used = (stats.blocks - stats.bfree) * stats.bsize
    const avail = stats.bavail * stats.bsize
    const size = stats.blocks * stats.bsize
    const pct = used + avail > 0 ? Math.ceil((used * 100) / (used + avail)) : 0
    // statfs reports bytes; mb() takes kilobytes (meminfo's unit), so divide by 1 MiB here.
    return `disk ${target} used ${Math.trunc(used / 1048576)}M of ${Math.trunc(size / 1048576)}M (${pct}%)`
}

// Process groups as the script's awk counted them: the executable is the first word's basename; the last matching rule names the group.
async function processLines() {
    const ps = await run('ps', ['-eo', 'rss=,args='])
    if (ps.status !== 0) return null
    const groups = new Map()
    for (const line of utf8(ps.stdout).split('\n')) {
        const match = /^\s*(\d+)\s+(\S.*)$/.exec(line)
        if (match === null) continue
        const rss = Number(match[1])
        const args = match[2]
        const exe = args.split(/\s+/)[0].replace(/^.*\//, '')
        let group = null
        if (exe === 'node' && /gm-mcp-server\.mjs/.test(args)) group = 'gm-mcp'
        if (exe === 'node' && /dispatch-verb\.mjs/.test(args)) group = 'dispatch-verb'
        if (exe === 'node' && /batch-characters\.mjs/.test(args)) group = 'other-batch'
        if (/^agentplug-runner/.test(exe)) group = 'runner'
        if (group === null) continue
        const entry = groups.get(group) ?? { count: 0, rss: 0 }
        entry.count += 1
        entry.rss += rss
        groups.set(group, entry)
    }
    return [...groups.keys()].sort().map((name) => {
        const entry = groups.get(name)
        return `proc ${name.padEnd(14)} count ${entry.count} rss ${mb(entry.rss)}M`
    })
}

// /proc/net/tcp and tcp6: one row per socket. State 01 is ESTABLISHED and 0A is LISTEN; field 9 is the socket inode.
function tcpSockets() {
    const rows = []
    for (const [file, family] of [[`${PROC}/net/tcp`, 4], [`${PROC}/net/tcp6`, 6]]) {
        const text = readText(file)
        if (text === null) continue
        for (const line of text.split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/)
            if (fields.length < 10) continue
            rows.push({ family, local: fields[1], state: fields[3], inode: fields[9] })
        }
    }
    return rows
}

// Addresses are printed as 32-bit little-endian words: the bytes of each word are its hex pairs in reverse order.
function decodeLocal(hex, family) {
    const [ipHex, portHex] = hex.split(':')
    const port = Number.parseInt(portHex, 16)
    const bytes = []
    for (let word = 0; word < ipHex.length; word += 8) {
        for (let k = 3; k >= 0; k -= 1) bytes.push(Number.parseInt(ipHex.slice(word + k * 2, word + k * 2 + 2), 16))
    }
    if (family === 4) return { address: `${bytes.join('.')}:${port}`, loopback: bytes[0] === 127 }
    const zeros = (from, to) => bytes.slice(from, to).every((b) => b === 0)
    const loopback = (zeros(0, 15) && bytes[15] === 1) || (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff && bytes[12] === 127)
    const groups = []
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
    return { address: `[${groups.join(':')}]:${port}`, loopback }
}

// Maps listening inodes to their owning process by reading each process's fd links, as ss -p does. Unreadable processes are skipped.
function socketOwners(inodes) {
    const owners = new Map()
    if (inodes.size === 0) return owners
    let pids = []
    try {
        pids = fs.readdirSync(PROC).filter((name) => /^\d+$/.test(name))
    } catch {
        return owners
    }
    for (const pid of pids) {
        let fds = []
        try {
            fds = fs.readdirSync(`${PROC}/${pid}/fd`)
        } catch {
            continue
        }
        for (const fd of fds) {
            let target = ''
            try {
                target = fs.readlinkSync(`${PROC}/${pid}/fd/${fd}`)
            } catch {
                continue
            }
            const match = /^socket:\[(\d+)\]$/.exec(target)
            if (match === null || !inodes.has(match[1]) || owners.has(match[1])) continue
            const comm = readText(`${PROC}/${pid}/comm`)?.trim() ?? ''
            owners.set(match[1], { pid: Number(pid), comm })
        }
    }
    return owners
}

function networkLines() {
    if (process.platform !== 'linux') return { lines: ['net  unavailable (no /proc/net on this platform)'], flagged: false }
    const rows = tcpSockets()
    const established = rows.filter((row) => row.state === '01').length
    const listening = rows.filter((row) => row.state === '0A').map((row) => ({ ...row, ...decodeLocal(row.local, row.family) }))
    const owners = socketOwners(new Set(listening.map((row) => row.inode)))
    const lines = [`net  ${established} established tcp`, `listen ${listening.length} tcp listener(s)`]
    let bad = 0
    for (const row of listening) {
        const owner = owners.get(row.inode) ?? null
        lines.push(`  ${row.address}  ${owner === null ? 'owner not readable' : `${owner.comm} pid=${owner.pid}`}`)
        if (owner !== null && /agentplug|gm-mcp/.test(owner.comm) && !row.loopback) bad += 1
    }
    if (bad > 0) lines.push(`FLAG gm listener on a non-loopback address: ${bad}`)
    return { lines, flagged: bad > 0 }
}

async function snapshot(diskPaths) {
    const load = process.platform === 'linux' ? os.loadavg().slice(0, 3).map((n) => n.toFixed(2)).join(' ') : 'unavailable'
    const lines = [`== ${new Date().toISOString().slice(11, 19)}Z load ${load}`, ...memoryLines(), await cpuLine()]
    for (const target of diskPaths) {
        const line = diskLine(target)
        if (line !== null) lines.push(line)
    }
    const procLines = await processLines()
    lines.push(...(procLines ?? ['proc unavailable (ps did not answer)']))
    const network = networkLines()
    lines.push(...network.lines)
    return { lines, flagged: network.flagged }
}

async function resourcesVerb(args) {
    const samples = args.samples ?? 1
    const interval = args.interval_seconds ?? 5
    if ((samples - 1) * interval > 300) throw usage('samples and interval_seconds together may span at most 300 seconds')
    const diskPaths = args.disk_paths ?? ['/', '/workspace']
    const lines = []
    let flagged = 0
    for (let i = 0; i < samples; i += 1) {
        if (i > 0) await sleep(interval * 1000)
        const snap = await snapshot(diskPaths)
        lines.push(...snap.lines)
        if (snap.flagged) flagged += 1
    }
    const result = `snapshots ${samples}, flagged ${flagged}`
    return flagged > 0 ? refused('gm_listener_non_loopback', result, [], lines) : ok(result, [], lines)
}

// Called by gm-mcp after it respawns a project's runner. The runner that owned those requests is gone, so each request it
// left in flight has no live owner. spoolOrphans still checks liveness and never moves a live request.
export function sweepOrphansAfterRespawn(root) {
    return spoolOrphans({ roots: [root], dry_run: false })
}

// ---------------------------------------------------------------- housekeep (runtime data under .gm)


const DAY_MS = 24 * 60 * 60 * 1000

const HOUSEKEEP_START_DELAY_MS = 1_500

const HOUSEKEEP_LOCK_STALE_MS = 2 * 60 * 60 * 1000

const HOUSEKEEP_STAMP = 'housekeep.json'

const HOUSEKEEP_LOCK = 'housekeep.lock'

const ARCHIVE_TIMEOUT_MS = 600_000

const HOUSEKEEP_LIST = 20

const HOUSEKEEP_TOP = 5

const TARGET_AGE_MS = 7 * DAY_MS

const WATCHER_ROTATED = ['.watcher.log.1', '.child-pids.jsonl.1']

// Comm names of build processes that keep a target/ directory in use (cargo, rustc and their prefixed variants).
const BUILD_COMM = /^(cargo|rustc)/

const HOUSEKEEP_AREAS = ['lane-build', 'exec-spool', 'shelved', 'browser-lease', 'gm.db', 'prd', 'unknowns', 'receipts', 'other']

// Top-level directories whose children are the entries the report ranks.
const EXPANDED = new Set(['lane-build', 'exec-spool', 'shelved', 'browser-lease'])

// Directories the migration-copy scan never enters: their contents are durable or already archived.
const BAK_SKIP_DIRS = new Set(['prd', 'unknowns', 'receipts', 'browser-lease', 'shelved'])

const BAK_NAME = /\.bak$/

// Run-once migration markers that rs-plugkit's row store reads (dir_migration_marker, log_dir_marker). Moving one re-runs its migration, so they are kept.
const MIGRATION_MARKER = /-migrated\.json$/

// Ledgers and logs are never moved, even when a copy of one is named .bak: the copy is reported and kept.
const DURABLE_NAME = /dispatch-ledger|prd-log|unknowns-log|witness-log/


function housekeepArea(top) {
    if (top === 'prd' || top.startsWith('prd-log') || top.startsWith('prd.log')) return 'prd'
    if (top.startsWith('unknowns')) return 'unknowns'
    if (top.startsWith('gm.db')) return 'gm.db'
    return HOUSEKEEP_AREAS.includes(top) ? top : 'other'
}


function sizeText(bytes) {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}M`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`
    return `${bytes}B`
}


const lstatOrNull = (file) => fs.promises.lstat(file).catch(() => null)

const readdirOrEmpty = (dir) => fs.promises.readdir(dir).catch(() => [])

const isLiveCwd = (processes, dir) => processes.cwds.some((cwd) => cwd === dir || cwd.startsWith(dir + path.sep))


// Bytes and newest mtime under target, never following symlinks. Awaits each entry, so the event loop serves dispatches meanwhile.
async function measure(target) {
    const info = await lstatOrNull(target)
    if (info === null) return { bytes: 0, newest: 0, isDir: false }
    if (!info.isDirectory()) return { bytes: info.size, newest: info.mtimeMs, isDir: false }
    let bytes = 0
    let newest = info.mtimeMs
    for (const name of await readdirOrEmpty(target)) {
        const sub = await measure(path.join(target, name))
        bytes += sub.bytes
        newest = Math.max(newest, sub.newest)
    }
    return { bytes, newest, isDir: true }
}


async function measureGm(gmDir) {
    const entries = []
    const areas = new Map(HOUSEKEEP_AREAS.map((area) => [area, 0]))
    const add = (rel, full, top, stat) => {
        entries.push({ rel, full, top, isDir: stat.isDir, bytes: stat.bytes, newest: stat.newest })
        const area = housekeepArea(top)
        areas.set(area, areas.get(area) + stat.bytes)
    }
    for (const top of await readdirOrEmpty(gmDir)) {
        const full = path.join(gmDir, top)
        const info = await lstatOrNull(full)
        if (info === null) continue
        if (EXPANDED.has(top) && info.isDirectory()) {
            for (const child of await readdirOrEmpty(full)) {
                const childFull = path.join(full, child)
                add(`${top}/${child}`, childFull, top, await measure(childFull))
            }
        } else {
            add(top, full, top, await measure(full))
        }
    }
    const total = [...areas.values()].reduce((sum, bytes) => sum + bytes, 0)
    return { entries, areas, total }
}


async function treeFiles(dir, rel = '') {
    const found = []
    for (const name of await readdirOrEmpty(dir)) {
        const full = path.join(dir, name)
        const info = await lstatOrNull(full)
        if (info === null) continue
        const relName = rel === '' ? name : `${rel}/${name}`
        if (info.isDirectory()) {
            for (const file of await treeFiles(full, relName)) found.push(file)
        } else if (info.isFile()) {
            found.push({ full, rel: relName, bytes: info.size, mtimeMs: info.mtimeMs })
        }
    }
    return found
}


// Live process cwds on Linux. Other platforms have no /proc scan here: the check is skipped and the report says so.
function processCheck() {
    if (process.platform !== 'linux') return { status: 'skipped', cwds: [], note: `process check skipped on ${process.platform}` }
    let pids = []
    try {
        pids = fs.readdirSync(PROC).filter((name) => /^\d+$/.test(name))
    } catch {
        return { status: 'unmeasured', cwds: [], note: '/proc unreadable; lane-build kept' }
    }
    const cwds = []
    let unreadable = 0
    for (const pid of pids) {
        try {
            cwds.push(fs.readlinkSync(`${PROC}/${pid}/cwd`))
        } catch (error) {
            if (error.code === 'EACCES' || error.code === 'EPERM') unreadable += 1
        }
    }
    return { status: 'checked', cwds, note: unreadable > 0 ? `${unreadable} process cwd unreadable (other user), not counted live` : null }
}


async function findBackups(gmDir, now, plan) {
    const walk = async (dir, rel) => {
        for (const name of await readdirOrEmpty(dir)) {
            if (rel === '' && BAK_SKIP_DIRS.has(name)) continue
            const full = path.join(dir, name)
            const relName = rel === '' ? name : `${rel}/${name}`
            const info = await lstatOrNull(full)
            if (info === null) continue
            if (info.isDirectory()) {
                await walk(full, relName)
            } else if (info.isFile() && (BAK_NAME.test(name) || MIGRATION_MARKER.test(name)) && now - info.mtimeMs > DAY_MS) {
                if (DURABLE_NAME.test(name)) plan.bakKept.push({ rel: relName, reason: 'durable log or ledger copy' })
                else if (MIGRATION_MARKER.test(name)) plan.bakKept.push({ rel: relName, reason: 'run-once migration marker read by rs-plugkit' })
                else plan.baks.push({ full, rel: relName, bytes: info.size })
            }
        }
    }
    await walk(gmDir, '')
}


async function planHousekeep(gmDir, entries, processes, now) {
    const old = (ms) => now - ms > DAY_MS
    const lanesChecked = processes.status === 'checked'
    const plan = { processes, lanesChecked, lanes: [], laneKept: [], outFiles: [], baks: [], bakKept: [], shelved: [], shelvedKept: [] }
    // lane-build needs the live-process check. Where that check cannot run (non-Linux, /proc unreadable), no lane is pruned.
    for (const entry of entries) {
        if (!lanesChecked || !entry.rel.startsWith('lane-build/') || !entry.isDir || path.basename(entry.full).startsWith('cargo-home') || !old(entry.newest)) continue
        if (isLiveCwd(processes, entry.full)) plan.laneKept.push({ rel: entry.rel, reason: 'live process cwd' })
        else plan.lanes.push(entry)
    }
    for (const file of await treeFiles(path.join(gmDir, 'exec-spool', 'out'))) {
        if (old(file.mtimeMs)) plan.outFiles.push(file)
    }
    await findBackups(gmDir, now, plan)
    const shelvedDir = path.join(gmDir, 'shelved')
    for (const entry of entries) {
        if (!entry.rel.startsWith('shelved/') || !entry.isDir) continue
        const name = path.basename(entry.full)
        if (fs.existsSync(path.join(shelvedDir, `${name}.tar.xz`))) plan.shelvedKept.push({ rel: entry.rel, reason: 'archive exists' })
        else if (!old(entry.newest)) plan.shelvedKept.push({ rel: entry.rel, reason: 'written within 24h' })
        else plan.shelved.push(entry)
    }
    return plan
}


// First free name under dir: <base>.tar.xz, then <base>-<stamp>[-n].tar.xz. An existing archive is never overwritten.
async function freeArchiveName(dir, base) {
    const stamp = utcStamp()
    for (let n = 0; ; n += 1) {
        const candidate = path.join(dir, n === 0 ? `${base}.tar.xz` : `${base}-${stamp}-${n}.tar.xz`)
        if (!fs.existsSync(candidate)) return candidate
    }
}


// Archives parent/name as an xz tar written beside the target, then lists it and checks every expected entry before the atomic rename.
async function archiveEntry(parent, name, archive) {
    const full = path.join(parent, name)
    const info = await lstatOrNull(full)
    if (info === null) return { ok: false, reason: 'missing' }
    const expected = [name]
    if (info.isDirectory()) {
        for (const file of await treeFiles(full)) expected.push(`${name}/${file.rel}`)
    }
    const tmp = tempBeside(archive)
    const made = await run('tar', ['-cJf', tmp, '-C', parent, name], { timeout: ARCHIVE_TIMEOUT_MS })
    if (made.status !== 0) {
        fs.rmSync(tmp, { force: true })
        return { ok: false, reason: `tar: ${utf8(made.stderr).trim().slice(0, 160) || `exit ${made.status}`}` }
    }
    const listed = await run('tar', ['-tJf', tmp], { timeout: ARCHIVE_TIMEOUT_MS })
    const listing = new Set(utf8(listed.stdout).split('\n').map((line) => line.replace(/\/$/, '')))
    const missing = expected.find((entry) => !listing.has(entry))
    if (listed.status !== 0 || missing !== undefined) {
        fs.rmSync(tmp, { force: true })
        return { ok: false, reason: listed.status !== 0 ? 'listing failed' : `archive lacks ${missing}` }
    }
    if (fs.existsSync(archive)) {
        fs.rmSync(tmp, { force: true })
        return { ok: false, reason: 'archive exists' }
    }
    fs.renameSync(tmp, archive)
    return { ok: true, archive }
}


async function executeHousekeep(gmDir, plan) {
    const done = []
    const fresh = processCheck()
    for (const lane of plan.lanes) {
        if (fresh.status !== 'checked' || isLiveCwd(fresh, lane.full)) {
            const detail = fresh.status === 'checked' ? 'live process cwd' : 'no live-process check'
            done.push({ cls: 'a', rel: lane.rel, outcome: 'kept', detail })
            continue
        }
        try {
            fs.rmSync(lane.full, { recursive: true, force: true })
            done.push({ cls: 'a', rel: lane.rel, outcome: 'pruned', bytes: lane.bytes })
        } catch (error) {
            done.push({ cls: 'a', rel: lane.rel, outcome: 'failed', detail: error.message })
        }
    }

    let removed = 0
    let removedBytes = 0
    for (const file of plan.outFiles) {
        try {
            await fs.promises.rm(file.full, { force: true })
            removed += 1
            removedBytes += file.bytes
        } catch (error) {
            done.push({ cls: 'b', rel: file.rel, outcome: 'failed', detail: error.message })
        }
    }
    if (removed > 0) done.push({ cls: 'b', rel: 'exec-spool/out', outcome: 'pruned', count: removed, bytes: removedBytes })

    const shelved = path.join(gmDir, 'shelved')
    if (plan.baks.length > 0 || plan.shelved.length > 0) fs.mkdirSync(shelved, { recursive: true })
    for (const file of plan.baks) {
        const base = path.basename(file.full)
        const made = await archiveEntry(path.dirname(file.full), base, await freeArchiveName(shelved, base))
        if (!made.ok) {
            done.push({ cls: 'c', rel: file.rel, outcome: 'kept', detail: made.reason })
            continue
        }
        try {
            fs.rmSync(file.full, { force: true })
            done.push({ cls: 'c', rel: file.rel, outcome: 'archived', detail: path.relative(gmDir, made.archive), bytes: file.bytes })
        } catch (error) {
            done.push({ cls: 'c', rel: file.rel, outcome: 'failed', detail: `archived to ${path.relative(gmDir, made.archive)} but not deleted: ${error.message}` })
        }
    }
    for (const entry of plan.shelved) {
        const name = path.basename(entry.full)
        const made = await archiveEntry(shelved, name, path.join(shelved, `${name}.tar.xz`))
        if (!made.ok) {
            done.push({ cls: 'd', rel: entry.rel, outcome: 'kept', detail: made.reason })
            continue
        }
        try {
            fs.rmSync(entry.full, { recursive: true, force: true })
            done.push({ cls: 'd', rel: entry.rel, outcome: 'archived', detail: path.relative(gmDir, made.archive), bytes: entry.bytes })
        } catch (error) {
            done.push({ cls: 'd', rel: entry.rel, outcome: 'failed', detail: error.message })
        }
    }

    const target = plan.target
    if (target?.state === 'candidate') {
        const build = buildProcessCheck()
        const stillIdle = build.status === 'checked' && build.running.length === 0 && !(await hasRecentFile(target.full, Date.now() - TARGET_AGE_MS))
        if (!stillIdle) {
            done.push({ cls: 'e', rel: 'target', outcome: 'kept', detail: 'became busy or recent before pruning' })
        } else {
            try {
                await fs.promises.rm(target.full, { recursive: true, force: true })
                done.push({ cls: 'e', rel: 'target', outcome: 'pruned', bytes: target.bytes })
            } catch (error) {
                done.push({ cls: 'e', rel: 'target', outcome: 'failed', detail: error.message })
            }
        }
    }
    for (const file of plan.watcherLogs) {
        try {
            await fs.promises.rm(file.full, { force: true })
            done.push({ cls: 'f', rel: file.rel, outcome: 'pruned', bytes: file.bytes })
        } catch (error) {
            done.push({ cls: 'f', rel: file.rel, outcome: 'failed', detail: error.message })
        }
    }
    return done
}


function writeStamp(gmDir, fields) {
    try {
        writeAtomic(path.join(gmDir, HOUSEKEEP_STAMP), `${JSON.stringify({ last_run_ms: Date.now(), last_run: new Date().toISOString(), ...fields }, null, 2)}\n`)
        return true
    } catch {
        return false
    }
}


// Build processes by comm name, read from /proc. Off Linux, or where /proc cannot be read, the target class is skipped.
function buildProcessCheck() {
    if (process.platform !== 'linux') return { status: 'skipped', running: [] }
    let pids = []
    try {
        pids = fs.readdirSync(PROC).filter((name) => /^\d+$/.test(name))
    } catch {
        return { status: 'unmeasured', running: [] }
    }
    const running = pids.filter((pid) => BUILD_COMM.test(readText(`${PROC}/${pid}/comm`)?.trim() ?? ''))
    return { status: 'checked', running }
}


// True when some file under dir is modified at or after cutoff. Stops at the first such file.
async function hasRecentFile(dir, cutoff) {
    for (const name of await readdirOrEmpty(dir)) {
        const full = path.join(dir, name)
        const info = await lstatOrNull(full)
        if (info === null) continue
        if (info.isDirectory() ? await hasRecentFile(full, cutoff) : info.mtimeMs >= cutoff) return true
    }
    return false
}


// The repo's own target/ directory (Cargo output). Never any other directory. State: absent, skipped, kept or candidate.
async function planTarget(root, now, build, sized) {
    const full = path.join(root, 'target')
    const info = await lstatOrNull(full)
    if (info === null || !info.isDirectory()) return { state: 'absent' }
    if (build.status !== 'checked') return { state: 'skipped', full }
    let reason = null
    if (build.running.length > 0) reason = `cargo or rustc running (${build.running.length} process(es))`
    else if (await hasRecentFile(full, now - TARGET_AGE_MS)) reason = 'newest file within 7 days'
    if (reason === null) return { state: 'candidate', full, rel: 'target', bytes: (await measure(full)).bytes }
    return { state: 'kept', full, reason, bytes: sized ? (await measure(full)).bytes : null }
}


// Rotated watcher logs older than a day. The live .watcher.log and .child-pids.jsonl are never named here.
async function planWatcherLogs(gmDir, now) {
    const found = []
    for (const name of WATCHER_ROTATED) {
        const full = path.join(gmDir, 'exec-spool', name)
        const info = await lstatOrNull(full)
        if (info !== null && info.isFile() && now - info.mtimeMs > DAY_MS) found.push({ rel: `exec-spool/${name}`, full, bytes: info.size })
    }
    return found
}


// sized: measure a kept target/ for the report. The automatic gate scans unsized, so an idle project costs no target walk.
async function scanHousekeep(root, sized = true) {
    const gmDir = path.join(root, '.gm')
    const before = await measureGm(gmDir)
    const processes = processCheck()
    const now = Date.now()
    const plan = await planHousekeep(gmDir, before.entries, processes, now)
    plan.target = await planTarget(root, now, buildProcessCheck(), sized)
    plan.watcherLogs = await planWatcherLogs(gmDir, now)
    return { before, processes, plan }
}


// An apply pass with nothing to prune writes nothing: no stamp, no lock, no archive.
const hasWork = (plan) => plan.lanes.length + plan.outFiles.length + plan.baks.length + plan.shelved.length + plan.watcherLogs.length + (plan.target?.state === 'candidate' ? 1 : 0) > 0


async function housekeepRun(root, apply, scan = null) {
    const gmDir = path.join(root, '.gm')
    const { before, processes, plan } = scan ?? (await scanHousekeep(root))
    const writes = apply && hasWork(plan)
    if (writes) writeStamp(gmDir, { state: 'running' })
    const done = writes ? await executeHousekeep(gmDir, plan) : []
    const after = writes ? await measureGm(gmDir) : before

    const counts = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, failed: 0 }
    for (const item of done) {
        if (item.outcome === 'failed') counts.failed += 1
        else if (item.outcome === 'pruned' || item.outcome === 'archived') counts[item.cls] += item.count ?? 1
    }
    const prunable = new Map(HOUSEKEEP_AREAS.map((area) => [area, 0]))
    const bump = (area, bytes) => prunable.set(area, prunable.get(area) + bytes)
    for (const lane of plan.lanes) bump('lane-build', lane.bytes)
    for (const file of plan.outFiles) bump('exec-spool', file.bytes)
    for (const file of plan.baks) bump(housekeepArea(file.rel.split('/')[0]), file.bytes)
    for (const entry of plan.shelved) bump('shelved', entry.bytes)
    for (const file of plan.watcherLogs) bump('exec-spool', file.bytes)
    const targetBytes = plan.target?.state === 'candidate' ? plan.target.bytes : 0
    const plannedTotal = [...prunable.values()].reduce((sum, bytes) => sum + bytes, 0) + targetBytes

    const lines = [`process ${processes.status}${processes.note ? `: ${processes.note}` : ''}`]
    if (!plan.lanesChecked) lines.push('lane-build: skipped, no live-process check')
    const target = plan.target
    if (target.state === 'absent') lines.push('target: no target directory')
    else if (target.state === 'skipped') lines.push('target: skipped, no live-process check')
    else if (target.state === 'kept') lines.push(`target: kept, ${target.reason}${target.bytes === null ? '' : ` (${sizeText(target.bytes)})`}`)
    for (const area of HOUSEKEEP_AREAS) {
        const tail = apply ? '' : `, prunable ${sizeText(prunable.get(area))}`
        lines.push(`area ${area} before ${sizeText(before.areas.get(area))} after ${sizeText(after.areas.get(area))}${tail}`)
    }
    for (const entry of [...after.entries].sort((x, y) => y.bytes - x.bytes).slice(0, HOUSEKEEP_TOP)) {
        lines.push(`top ${entry.rel} ${sizeText(entry.bytes)}`)
    }
    const actions = []
    for (const item of [...plan.laneKept, ...plan.bakKept, ...plan.shelvedKept]) actions.push(`kept ${item.rel}: ${item.reason}`)
    if (apply) {
        for (const item of done) {
            if (item.cls === 'b') actions.push(`${item.outcome} b exec-spool/out ${item.count} file(s) ${sizeText(item.bytes)}`)
            else actions.push(`${item.outcome} ${item.cls} ${item.rel}${item.detail ? ` (${item.detail})` : ''}${item.bytes !== undefined ? ` ${sizeText(item.bytes)}` : ''}`)
        }
    } else {
        for (const lane of plan.lanes) actions.push(`would a ${lane.rel} ${sizeText(lane.bytes)}`)
        if (plan.outFiles.length > 0) actions.push(`would b exec-spool/out ${plan.outFiles.length} file(s) ${sizeText(plan.outFiles.reduce((sum, file) => sum + file.bytes, 0))}`)
        for (const file of plan.baks) actions.push(`would c ${file.rel} ${sizeText(file.bytes)}`)
        for (const entry of plan.shelved) actions.push(`would d ${entry.rel} ${sizeText(entry.bytes)}`)
        if (target.state === 'candidate') actions.push(`would e target ${sizeText(target.bytes)}`)
        for (const file of plan.watcherLogs) actions.push(`would f ${file.rel} ${sizeText(file.bytes)}`)
    }
    const shown = actions.length > HOUSEKEEP_LIST ? [...actions.slice(0, HOUSEKEEP_LIST), `... ${actions.length - HOUSEKEEP_LIST} more`] : actions
    lines.push(...shown)
    lines.push(`counts a=${counts.a} b=${counts.b} c=${counts.c} d=${counts.d} e=${counts.e} f=${counts.f} failed=${counts.failed}`)

    const summary = { before_bytes: before.total, after_bytes: after.total, pruned: counts }
    if (writes) writeStamp(gmDir, { state: 'done', ...summary })
    const result = apply
        ? `housekeep applied: ${sizeText(before.total)} to ${sizeText(after.total)}, freed ${sizeText(before.total - after.total)}`
        : `housekeep dry-run: ${sizeText(before.total)}, prunable ${sizeText(plannedTotal)}`
    return { result, lines, summary }
}


async function housekeepVerb(args) {
    const base = rootOf(args)
    const root = typeof args.root === 'string' && args.root.trim() !== '' ? path.resolve(base, args.root.trim()) : base
    if (!isDirectory(path.join(root, '.gm'))) return refused('no_gm_state', `no .gm directory under ${root}`)
    const pass = await housekeepRun(root, args.apply === true)
    return ok(pass.result, [['root', root]], pass.lines)
}


function housekeepDue(gmDir) {
    const text = readText(path.join(gmDir, HOUSEKEEP_STAMP))
    if (text === null) return true
    try {
        const age = Date.now() - Number(JSON.parse(text).last_run_ms)
        return !(age >= 0 && age < DAY_MS)
    } catch {
        return true
    }
}


// Lock by atomic create (wx). A lock older than the stale bound is a dead run's and is reclaimed once.
function acquireHousekeepLock(gmDir) {
    const file = path.join(gmDir, HOUSEKEEP_LOCK)
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(file, 'wx')
            try {
                fs.writeSync(fd, `${process.pid}\n`)
            } finally {
                fs.closeSync(fd)
            }
            return file
        } catch (error) {
            if (error.code !== 'EEXIST') return null
            const found = statOf(file)
            if (found === null || Date.now() - found.mtimeMs < HOUSEKEEP_LOCK_STALE_MS) return null
            fs.rmSync(file, { force: true })
        }
    }
    return null
}


async function housekeepAutomatic(root) {
    const gmDir = path.join(root, '.gm')
    if (!isDirectory(gmDir) || !housekeepDue(gmDir)) return
    // Read-only scan first: a project with nothing to prune gets no lock file and no stamp.
    const scan = await scanHousekeep(root, false)
    if (!hasWork(scan.plan)) return
    const lock = acquireHousekeepLock(gmDir)
    if (lock === null) return
    try {
        if (!housekeepDue(gmDir)) return
        const pass = await housekeepRun(root, true)
        appendDiagnostic('housekeep-run', { root, ...pass.summary })
    } finally {
        fs.rmSync(lock, { force: true })
    }
}


// Server-start entry: at most one apply pass per 24 hours per project. Runs after a short delay, detached, and never throws into the caller.
export function housekeepInBackground(root) {
    if (typeof root !== 'string' || root.trim() === '') return
    const timer = setTimeout(() => {
        housekeepAutomatic(path.resolve(root.trim())).catch((error) => appendDiagnostic('housekeep-failed', { root, error: String(error?.message ?? error) }))
    }, HOUSEKEEP_START_DELAY_MS)
    timer.unref?.()
}


// ---------------------------------------------------------------- github-search, prd-references (public-search.js)

async function githubSearchVerb(args) {
    const plan = searchPlan(args)
    if (plan.error !== undefined) throw usage(plan.error)
    const found = await runGhSearch(plan.argv)
    if (!found.ok) return refused(found.code, found.message, [['query', plan.query]])
    const lines = found.hits.map((hit) => `${hit.rank}. ${hit.repo} ${hit.path} sha=${hit.sha} url=${hit.url} raw_url=${hit.raw_url}`)
    return ok(`${found.hits.length} hits`, [['query', plan.query], ['transport', 'gh search code'], ['count', found.hits.length]], lines)
}

async function prdReferencesVerb(args) {
    const root = rootOf(args)
    const id = singleLine(args.id, 'id')
    if (!validRowId(id)) throw usage('id must be a row id: letters, digits, dot, dash or underscore')
    const checked = checkReferences(args.references)
    if (checked.error !== undefined) return refused('bad_reference', checked.error)
    const read = readRow(root, id)
    if (read.error_code !== undefined) return refused(read.error_code, read.error)
    const known = new Set(recordedUrls(read.doc))
    const fresh = checked.references.filter((ref) => !known.has(ref.url))
    if (known.size + fresh.length > REFERENCE_CAP) return refused('references_full', `a row keeps at most ${REFERENCE_CAP} references; ${id} has ${known.size}`)
    for (const [index, ref] of fresh.entries()) {
        const failure = await appendRowNote(root, id, 'references', JSON.stringify(ref), args.session_id)
        if (failure !== null) return refused('prd_note_refused', failure, [['row', id], ['recorded', index]])
    }
    return ok(`${fresh.length} references recorded on ${id}`, [['row', id], ['recorded', fresh.length], ['skipped_existing', checked.references.length - fresh.length], ['references', known.size + fresh.length], ['status', String(read.doc.status ?? 'unknown')]])
}

// ---------------------------------------------------------------- registry

export const TRIAGE_VERBS = [
    {
        name: 'writer_lock',
        description: 'Writer lock for one checkout (replaces scripts/triage/writer-lock.sh). action take takes <cwd>/.gm/locks/<repo>.writer for session; release drops it only for its holder; status prints the holder or free; check fetches origin/main and reports "<repo>: dirty=N ahead=M" (dirty counts porcelain paths except unstaged .gm/dream-rsi deletions; exit 1 when not clean); quarantine_stale moves a lock whose holder has no live process, with no git write running, into a dated quarantine directory and never deletes. Reply: ok, exit_code, result (the script line), fields, and error_code on a refusal: held, not_holder, not_clean, git_write_live, holder_live, holder_changed, process_table_unreadable. A refusal returns as data with ok: false; a usage error throws.',
        inputSchema: {
            action: z.enum(['take', 'release', 'status', 'check', 'quarantine_stale', 'quarantine-stale']).describe('take, release, status, check or quarantine_stale.'),
            repo: z.string().describe('Checkout to lock: "gm" for the gm checkout itself, or a submodule directory name under cwd.'),
            session: z.string().optional().describe('Session id that takes or releases the lock. Required by take and release.'),
            cwd: z.string().optional().describe('gm checkout root that holds .gm/. Required: the verb never guesses a root.'),
        },
        handler: toolReply('writer_lock', writerLock),
    },
    {
        name: 'write_queue',
        description: 'Per-repository queue of rows whose edit a lane could not write (replaces scripts/triage/write-queue.sh). action add queues row with note (a row already queued is left as it is); list returns one tab-separated "<row><TAB><note>" line per row; done removes row. Stored in <cwd>/.gm/queues/<repo>.rows, rewritten by temp file and rename under a lock file. Reply: ok, exit_code, result (the script line); list puts each row on its own line after the header. error_code queue_busy when the lock stays held for 5 seconds.',
        inputSchema: {
            action: z.enum(['add', 'list', 'done']).describe('add, list or done.'),
            repo: z.string().describe('Repository the queue belongs to: "gm" or a submodule directory name.'),
            row: z.string().optional().describe('Row id. Required by add and done; a single line with no tab.'),
            note: z.string().optional().describe('What the edit is (add only). Tabs and newlines become spaces.'),
            cwd: z.string().optional().describe('gm checkout root that holds .gm/. Required.'),
        },
        handler: toolReply('write_queue', writeQueue),
    },
    {
        name: 'shards',
        description: 'Drain shard files from the pending PRD store (replaces scripts/triage/shards.sh). Reads <cwd>/.gm/prd/*.yml, assigns each row an owner by keywords in its text, and writes 20-id shard files <owner>-NN and <owner>.all into out_dir (default <cwd>/.gm/drain-shards/<UTC stamp>). out_dir must not exist. Reply: ok, exit_code, result "total N into <dir>", out_dir, then one "<owner>-NN <count>" line per shard. error_code out_exists or too_many_shards is a refusal that writes nothing.',
        inputSchema: {
            out_dir: z.string().optional().describe('New directory for the shard files. Relative paths resolve against cwd. Default: a dated directory under .gm/drain-shards.'),
            cwd: z.string().optional().describe('gm checkout root that holds .gm/. Required.'),
        },
        handler: toolReply('shards', shardsVerb),
    },
    {
        name: 'publish_on_origin',
        description: 'Publishes the listed paths of repo_dir onto origin/main as one commit, without touching its working tree, index or local main (replaces scripts/triage/publish-on-origin.sh). Steps: fetch origin main; build a temporary index from origin/main; three-way merge each listed file (base = fork point merge-base(HEAD, publish_base), default origin/main; theirs = origin/main; ours = the lane file; a conflict refuses with its path and line span); regenerate skills/manifest.sha256 when a skills/ path is listed; commit-tree with "Row: <row>"; refuse a commit that changes any path outside the list; run <cwd>/scripts/check-staged-secrets.mjs on that index; push sha:refs/heads/main; confirm the sha is on origin/main. dry_run stops before the push. Reply: ok, exit_code, result, commit, then the last three diff stat lines. Refusals return as data with error_code: fetch_failed, merge_conflict, unintended_paths, secrets_check_failed, push_refused, not_on_origin and others; nothing is pushed on a refusal.',
        inputSchema: {
            repo_dir: z.string().describe('Checkout whose files are published: an absolute path, or relative to cwd.'),
            row: z.string().describe('Row id, written into the commit as "Row: <row>".'),
            message: z.string().describe('Commit subject and body.'),
            paths: z.array(z.string()).min(1).describe('Repository-relative paths the lane edited. Each must exist as a file (published), be a submodule pin in the index or HEAD of the lane (published as that commit sha at mode 160000), or be absent (removed from the index unless origin/main pins it as a submodule, which is then left alone).'),
            publish_base: z.string().optional().describe('The commit the lane\'s copy was made from (a sha or ref). The three-way base is merge-base(HEAD, publish_base), so a ref that moved past the copy resolves back to it. Default origin/main.'),
            dry_run: z.boolean().optional().describe('Build and check the commit, then stop before the push.'),
            witness: z.string().optional().describe('Dispatch id of the live witness that closes the row: must appear in .gm/exec-spool/.dispatch-ledger.json. Required when this publish closes a row (a status is given, or the row file under .gm/prd/ is removed).'),
            status: z.enum(['resolved', 'stale']).optional().describe('Status the closing commit records. Required with witness.'),
            cwd: z.string().optional().describe('gm checkout root: the secrets checker is read from <cwd>/scripts, and the witness ledger from <cwd>/.gm. Required.'),
        },
        handler: toolReply('publish_on_origin', publishOnOrigin),
    },
    {
        name: 'spool_orphans',
        description: 'Moves orphaned .inflight spool requests under <root>/.gm/exec-spool/in into a dated sibling quarantine directory (replaces scripts/triage/spool-orphans.sh). A request is live when a process command line contains its id; live requests stay where they are. dry_run only reports. unserved (minutes) also moves plain .txt requests in subdirectories that are older than that. Nothing is deleted. A process table that cannot be read refuses the whole call. Reply: ok, exit_code, result with the counts, then one line per request: live, orphan (dry run), moved, unserved (dry run) or failed.',
        inputSchema: {
            roots: z.array(z.string()).min(1).describe('Repository roots whose .gm/exec-spool/in is scanned. Absolute, or relative to cwd.'),
            dry_run: z.boolean().optional().describe('Report orphans without moving them.'),
            unserved: z.number().min(0).optional().describe('Also move .txt requests in spool subdirectories older than this many minutes.'),
            cwd: z.string().optional().describe('Base for relative roots. Required when a root is relative.'),
        },
        handler: toolReply('spool_orphans', spoolOrphans),
    },
    {
        name: 'resources',
        description: 'Resource snapshot for gm (replaces scripts/triage/resources.sh): load, RAM, swap, CPU share over a 0.5 second sample, disk for disk_paths, gm process groups by command line (gm-mcp, dispatch-verb, other-batch, runner) with count and RSS, the established TCP count, and each listening TCP socket with its owner. A gm-owned listener (owner named agentplug or gm-mcp) on a non-loopback address answers error_code gm_listener_non_loopback with exit_code 1. samples takes several snapshots, interval_seconds apart, in place of the script --watch loop, which never returns. Reply: ok, exit_code, result, then the snapshot lines.',
        inputSchema: {
            samples: z.number().int().min(1).max(12).optional().describe('Snapshots to take (default 1).'),
            interval_seconds: z.number().min(1).max(300).optional().describe('Seconds between snapshots (default 5).'),
            disk_paths: z.array(z.string()).optional().describe('Paths whose filesystem is reported (default ["/", "/workspace"]); a missing path is skipped.'),
        },
        handler: toolReply('resources', resourcesVerb),
    },
    {
        name: 'housekeep',
        description: 'Reports and prunes runtime data under <root>/.gm. Reply: ok, exit_code, result, root, then one "area <name> before <size> after <size>" line per area, the five largest entries ("top <rel> <size>"), kept and would or pruned action lines, and counts. apply false (default) changes nothing. apply true prunes only: (a) lane-build/<lane> directories whose newest entry is older than 24 hours, with no live process cwd (checked through /proc on Linux only; where that check cannot run, lane-build is skipped and the reply says "lane-build: skipped, no live-process check"); cargo-home* is never pruned; (b) exec-spool/out files older than 24 hours; (c) *.bak files older than 24 hours, each moved into shelved/ as a .tar.xz archive (listing verified) and then deleted; durable ledger and log copies and *-migrated.json run-once markers are kept; (d) shelved/<dir> directories with no <dir>.tar.xz yet and nothing written in 24 hours, compressed to <dir>.tar.xz (listing verified) and then deleted; (e) target/ at the repo root (Cargo output) when no cargo or rustc process runs and no file in it is newer than 7 days (checked through /proc on Linux only; elsewhere the reply says "target: skipped, no live-process check"); (f) exec-spool/.watcher.log.1 and exec-spool/.child-pids.jsonl.1 older than 24 hours (the live .watcher.log and .child-pids.jsonl are never touched). gm.db, browser-lease, prd logs, unknowns, receipts and witness logs are never pruned. error_code no_gm_state when <root>/.gm is absent.',
        inputSchema: {
            apply: z.boolean().optional().describe('Prune the classes listed above. Default false: report only.'),
            root: z.string().optional().describe('Project root holding .gm/. A relative path resolves against cwd. Default: cwd.'),
            cwd: z.string().optional().describe('Project root when root is omitted. Required.'),
        },
        handler: toolReply('housekeep', housekeepVerb),
    },
    {
        name: 'github-search',
        description: 'Searches public GitHub code through the gh CLI (gh search code, the GitHub code search API). Returns ranked hits: rank, repo, path, sha (the git blob id), url (html) and raw_url (plain text, for fetch). Filters map to gh flags: owner (a list is allowed), repo (owner/name), language, extension, filename, size (kilobytes: >N, <N or A..B), match (file contents or path), limit (1 to 100, default 30). path is sent as the path: qualifier. query is free text, a quoted phrase, or raw qualifiers (repo:, language:, path:, filename:, extension:) sent unchanged; an empty query is valid when filters alone select the code. mode symbol sends one identifier as the symbol: qualifier. Regex search is not available: the API runs the legacy code search engine, so match literal terms, phrases and qualifiers. Typed refusals (ok false, exit 1): gh_missing, auth_required, rate_limited, bad_qualifier (the query parser refused it), search_timeout, search_failed. Bad input throws (exit 2). With cwd, the call is recorded in the project dispatch ledger.',
        inputSchema: {
            query: z.string().optional().describe('Free text, a quoted phrase, or raw qualifiers, sent unchanged. Leave empty when the filters alone are the query.'),
            mode: z.enum(['text', 'symbol']).optional().describe('text (default), or symbol: the query, one identifier, is sent as the symbol: qualifier.'),
            owner: z.union([z.string(), z.array(z.string())]).optional().describe('Owner or organisation filter, or a list of them.'),
            repo: z.string().optional().describe('One repository, owner/name.'),
            language: z.string().optional().describe('Language name, e.g. Rust, JavaScript, Python.'),
            extension: z.string().optional().describe('File extension without the dot, e.g. rs.'),
            filename: z.string().optional().describe('Bare file name, e.g. package.json.'),
            path: z.string().optional().describe('Repository-relative path prefix, sent as the path: qualifier.'),
            match: z.enum(['file', 'path']).optional().describe('Match file contents (file) or file paths (path).'),
            size: z.string().optional().describe('Kilobyte range: >100, <50 or 10..200.'),
            limit: z.number().int().min(1).max(100).optional().describe('Hits to return, 1 to 100 (default 30).'),
            cwd: z.string().optional().describe('Project root for the dispatch ledger. Optional: the search does not depend on it.'),
        },
        handler: toolReply('github-search', githubSearchVerb),
    },
    {
        name: 'prd-references',
        description: 'Records public references on an open PRD row. Each entry {url, why, repo, path, sha, license} becomes one note on the row list references, written through the runner prd-note path (the compare-and-swap write that prd-resolve and prd-note share), holding the entry as JSON. A url already on the row is not recorded again. url is https; why is one line; repo is owner/name; path is repository-relative; sha is the git object id from github-search; license defaults to unknown. Only the references list grows: the status is kept, so the call neither reopens nor closes the row, and prd-list {id} shows the list. Typed refusals (ok false, exit 1): row_missing (no open row file), row_unparseable, bad_reference (the reply names the field), references_full (more than 60 per row), prd_note_refused (the runner reason; recorded counts the notes written before it). Input errors throw (exit 2). prd-resolve, prd-close and the closing commit of publish_on_origin refuse a row with no references and no body line "No public references: <reason>"; rows that predate the gate carry a references_gate note and pass.',
        inputSchema: {
            id: z.string().describe('Open row id: the name of its file under .gm/prd/.'),
            references: z.array(z.object({
                url: z.string().describe('https URL of the reference (required).'),
                why: z.string().describe('One line: why this reference answers the row (required).'),
                repo: z.string().optional().describe('owner/name of the repository.'),
                path: z.string().optional().describe('Repository-relative path, with the line the citation names.'),
                sha: z.string().optional().describe('Git object id of the file, from github-search.'),
                license: z.string().optional().describe('License identifier; defaults to unknown.'),
            })).min(1).max(20).describe('References to record, at most 20 per call.'),
            cwd: z.string().describe('Project root that holds .gm/prd. Required.'),
        },
        handler: toolReply('prd-references', prdReferencesVerb),
    },
]

// Every triage schema takes the session_id that a gm call supplies (codemode fills it in when the schema declares it),
// so the ledger line names the caller's session.
const SESSION_ID_FIELD = z.string().optional().describe('Caller session recorded in the dispatch ledger. A gm call supplies its own session when this is omitted.')
for (const triage of TRIAGE_VERBS) triage.inputSchema.session_id = SESSION_ID_FIELD
