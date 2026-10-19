import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CODEMODE_TIMEOUT_MS } from './codemode-budget.js'

const OWNER_DIR_MODE = 0o700
const OWNER_FILE_MODE = 0o600
const POLL_INTERVAL_MS = 50
const WATCH_SILENT_MS = 1000
const RENAME_BACKOFF_MS = [10, 20, 40, 80, 160, 320]
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY'])
const TIMEOUT_MARGIN_MS = 5000
const VERB_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/
const SESSION_PATTERN = /^[A-Za-z0-9_.-]{1,150}$/
const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const WINDOWS_MAX_PATH = 259

function spoolError(code, message, detail = {}) {
    return Object.assign(new Error(message), { code, ...detail })
}

export function spoolDirOf(root) {
    return path.join(root, '.gm', 'exec-spool')
}

export function defaultBudgetMs(env = process.env) {
    const configured = Number(env.GM_CODEMODE_TIMEOUT_MS)
    const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CODEMODE_TIMEOUT_MS
    return base + TIMEOUT_MARGIN_MS
}

export function spoolHealth(root) {
    const statusPath = path.join(spoolDirOf(root), '.status.json')
    let status
    try {
        status = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
    } catch (error) {
        return { alive: false, reason: error.code === 'ENOENT' ? 'no-status-file' : 'status-unreadable', status_path: statusPath }
    }
    const pid = Number(status?.pid)
    if (!Number.isInteger(pid) || pid <= 0) return { alive: false, reason: 'status-has-no-pid', status_path: statusPath }
    let alive = true
    try {
        process.kill(pid, 0)
    } catch (error) {
        alive = error.code === 'EPERM'
    }
    return { alive, pid, reason: alive ? 'pid-running' : 'pid-not-running', status_path: statusPath, status_ts: status.ts ?? null }
}

function requestName(sessionId, counter) {
    return `${sessionId}-${process.pid}-${Date.now()}-${counter}`
}

let counter = 0

async function renameIntoPlace(tempPath, finalPath) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(tempPath, finalPath)
            return
        } catch (error) {
            const delay = RENAME_BACKOFF_MS[attempt]
            if (!RETRYABLE_RENAME_CODES.has(error.code) || delay === undefined) throw error
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }
}

async function submitRequest(inDir, name, text) {
    fs.mkdirSync(inDir, { recursive: true, mode: OWNER_DIR_MODE })
    const tempPath = path.join(inDir, `.${name}.${process.pid}.tmp`)
    const finalPath = path.join(inDir, `${name}.txt`)
    fs.writeFileSync(tempPath, text, { encoding: 'utf8', flag: 'wx', mode: OWNER_FILE_MODE })
    try {
        await renameIntoPlace(tempPath, finalPath)
    } catch (error) {
        try {
            fs.rmSync(tempPath, { force: true })
        } catch {}
        throw error
    }
}

function readCompleteReply(replyPath) {
    let text
    try {
        text = fs.readFileSync(replyPath, 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
    }
    try {
        JSON.parse(text)
        return text
    } catch {
        return undefined
    }
}

function waitForReply({ outDir, replyPath, deadline, budgetMs, verb, name }) {
    let settle
    const promise = new Promise((resolve, reject) => {
        let done = false
        let watcher = null
        let lastEventAt = Date.now()
        let timer = null
        const finish = (fn, value) => {
            if (done) return
            done = true
            clearInterval(timer)
            try { watcher?.close() } catch {}
            fn(value)
        }
        const check = () => {
            if (done) return
            try {
                const text = readCompleteReply(replyPath)
                if (text !== undefined) finish(resolve, text)
            } catch (error) {
                finish(reject, error)
            }
        }
        settle = () => finish(() => {}, undefined)
        try {
            watcher = fs.watch(outDir, () => {
                lastEventAt = Date.now()
                check()
            })
            watcher.on('error', () => {
                try { watcher?.close() } catch {}
                watcher = null
            })
        } catch {
            watcher = null
        }
        timer = setInterval(() => {
            if (Date.now() >= deadline) {
                finish(reject, spoolError('spool-timeout', `no reply for ${verb} ${name} within ${budgetMs} ms; the request stays in the spool and may still land at ${replyPath}`, { verb, request: name, out_path: replyPath, budget_ms: budgetMs }))
                return
            }
            if (!watcher || Date.now() - lastEventAt > WATCH_SILENT_MS) check()
        }, POLL_INTERVAL_MS)
        check()
    })
    return { promise, cancel: () => settle() }
}

function isWindowsReservedName(component) {
    return WINDOWS_RESERVED_NAME.test(component.split('.')[0])
}

export async function dispatchSpool({ verb, body = {}, cwd, budgetMs = defaultBudgetMs(), sessionId = 'spool-transport' }) {
    if (typeof cwd !== 'string' || !cwd) throw spoolError('spool-no-cwd', 'dispatchSpool needs cwd, the project root that holds .gm/exec-spool')
    if (!VERB_PATTERN.test(verb)) throw spoolError('spool-bad-verb', `verb ${JSON.stringify(verb)} is not a spool verb name`)
    if (!SESSION_PATTERN.test(sessionId)) throw spoolError('spool-bad-session', `session_id ${JSON.stringify(sessionId)} is not a single spool name component`)
    if (isWindowsReservedName(verb) || isWindowsReservedName(sessionId)) throw spoolError('spool-reserved-name', `verb or session_id ${JSON.stringify(verb)}/${JSON.stringify(sessionId)} names a Windows device (CON, PRN, AUX, NUL, COMn, LPTn) and cannot be a spool path component`)
    const health = spoolHealth(cwd)
    if (!health.alive) throw spoolError('spool-daemon-not-running', `runner is not alive (${health.reason}); nothing was written`, { health })
    const spoolDir = spoolDirOf(cwd)
    const outDir = path.join(spoolDir, 'out')
    counter += 1
    const name = requestName(sessionId, counter)
    const replyPath = path.join(outDir, `${verb}-${name}.json`)
    const tempPath = path.join(spoolDir, 'in', verb, `.${name}.${process.pid}.tmp`)
    const longest = Math.max(replyPath.length, tempPath.length)
    if (process.platform === 'win32' && longest > WINDOWS_MAX_PATH) throw spoolError('spool-path-too-long', `spool path would be ${longest} characters, over the Windows MAX_PATH limit of ${WINDOWS_MAX_PATH}; move the project to a shorter root or use a shorter session_id`, { path_chars: longest, limit: WINDOWS_MAX_PATH })
    fs.mkdirSync(outDir, { recursive: true, mode: OWNER_DIR_MODE })
    const waiter = waitForReply({ outDir, replyPath, deadline: Date.now() + budgetMs, budgetMs, verb, name })
    try {
        await submitRequest(path.join(spoolDir, 'in', verb), name, JSON.stringify({ ...body, session_id: sessionId, _agentplug_lane_wait_ms: budgetMs }))
    } catch (error) {
        waiter.cancel()
        throw error
    }
    return waiter.promise
}
