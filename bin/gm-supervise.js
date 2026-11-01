#!/usr/bin/env node
// Keeps one stdio connection to an MCP host and runs exactly one gm-mcp child behind it.
// Node built-ins only. Not part of the gm-mcp bundle and not registered with any host.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const POLL_MS = 2000
const DRAIN_MAX_MS = 120000
const RESTART_GAP_MS = 5000
const HANDSHAKE_TIMEOUT_MS = 30000
const STOP_GRACE_MS = 3000
const RELOAD_ERROR_CODE = -32001
const INIT_ID = '__gm_supervise_init__'

const argValue = (flag) => {
  const at = process.argv.indexOf(flag)
  return at > 0 ? process.argv[at + 1] : undefined
}
const defaultDir = path.join(homedir(), '.gm-tools')
const bundlePath = path.resolve(argValue('--bundle') ?? process.env.GM_SUPERVISE_BUNDLE ?? path.join(defaultDir, 'gm-mcp-server.mjs'))
const lockPath = path.resolve(argValue('--lock') ?? process.env.GM_SUPERVISE_LOCK ?? path.join(defaultDir, 'gm-supervise.lock'))

let active = null
let draining = null
let generation = 0
let runningSha = null
let candidateSha = null
let rejectedSha = null
let initRequest = null
let initResponse = null
let initializedLine = null
let paused = false
let stopping = false
let lockHeld = false
let lastRestartAt = 0
let restartTimer = null
let pollTimer = null
let polling = false
const children = new Set()
const inflight = new Map()
const hostQueue = []

const keyOf = (id) => typeof id + ':' + String(id)
const parse = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
const isMessage = (msg) => msg !== null && typeof msg === 'object' && !Array.isArray(msg)
const shortSha = (sha) => (sha ?? '').slice(0, 12)

function log(event, fields = {}) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), event, supervisor_pid: process.pid, ...fields }) + '\n')
}

function writeHost(line) {
  process.stdout.write(line + '\n')
}

function replyError(id, message) {
  writeHost(JSON.stringify({ jsonrpc: '2.0', id, error: { code: RELOAD_ERROR_CODE, message } }))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function acquireLock() {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      lockHeld = true
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let holder
      try {
        holder = Number.parseInt(readFileSync(lockPath, 'utf8'), 10)
      } catch (readError) {
        if (readError.code === 'ENOENT') continue
        throw readError
      }
      if (!Number.isInteger(holder) || holder <= 0 || alive(holder)) {
        log('refused', { lock: lockPath, holder: Number.isInteger(holder) ? holder : null, reason: 'another supervisor holds this lock' })
        process.exit(1)
      }
      log('stale_lock_removed', { lock: lockPath, holder })
      try {
        unlinkSync(lockPath)
      } catch {}
    }
  }
  log('refused', { lock: lockPath, reason: 'lock contended' })
  process.exit(1)
}

function releaseLock() {
  if (!lockHeld) return
  lockHeld = false
  try {
    if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath)
  } catch {}
}

async function bundleSha() {
  return createHash('sha256').update(await readFile(bundlePath)).digest('hex')
}

function countInflight(gen) {
  let count = 0
  for (const entry of inflight.values()) if (entry.gen === gen) count++
  return count
}

function failInflight(gen, message) {
  let failed = 0
  for (const [key, entry] of inflight) {
    if (entry.gen !== gen) continue
    inflight.delete(key)
    replyError(entry.id, message)
    log('inflight_failed', { gen, id: entry.id, method: entry.method, waited_ms: Date.now() - entry.startedAt })
    failed++
  }
  return failed
}

function spawnChild(reason) {
  const gen = ++generation
  const proc = spawn(process.execPath, [bundlePath], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: process.env })
  const rec = { gen, proc, pid: proc.pid, exited: false, exitInfo: null, handshake: null }
  children.add(rec)
  proc.stdin.on('error', () => {})
  readline.createInterface({ input: proc.stdout }).on('line', (line) => onChildLine(rec, line))
  proc.on('exit', (code, signal) => onChildExit(rec, code, signal))
  proc.on('error', (error) => {
    log('child_error', { gen, error: error.message })
    if (proc.pid === undefined) onChildExit(rec, null, 'spawn-error')
  })
  log('child_start', { gen, child_pid: proc.pid, reason })
  return rec
}

function stopChild(rec) {
  if (rec.exited) return Promise.resolve()
  return new Promise((resolve) => {
    const escalate = [
      setTimeout(() => rec.proc.kill('SIGTERM'), STOP_GRACE_MS),
      setTimeout(() => rec.proc.kill('SIGKILL'), STOP_GRACE_MS * 2),
    ]
    rec.proc.once('exit', () => {
      escalate.forEach(clearTimeout)
      resolve()
    })
    rec.proc.stdin.end()
  })
}

function onChildLine(rec, line) {
  if (line === '') return
  const msg = parse(line)
  if (isMessage(msg) && msg.method === undefined && msg.id !== undefined && msg.id !== null) {
    const key = keyOf(msg.id)
    if (key === keyOf(INIT_ID)) {
      rec.handshake?.(msg.error ? new Error('initialize failed: ' + msg.error.message) : null)
      return
    }
    const entry = inflight.get(key)
    if (!entry || entry.gen !== rec.gen) return
    inflight.delete(key)
    if (entry.method === 'initialize' && msg.result !== undefined && initResponse === null) initResponse = msg
  }
  if (rec === active || rec === draining) writeHost(line)
}

function onChildExit(rec, code, signal) {
  if (rec.exited) return
  rec.exited = true
  rec.exitInfo = { code, signal }
  children.delete(rec)
  rec.handshake?.(new Error('child exited during handshake, code ' + code + ', signal ' + signal))
  const failed = failInflight(rec.gen, 'gm-mcp child exited before answering (code ' + code + ', signal ' + signal + '); resend this request')
  if (rec === active && !paused && !stopping) {
    paused = true
    log('child_crash', { gen: rec.gen, child_pid: rec.pid, code, signal, failed_inflight: failed })
    scheduleRestart()
    return
  }
  log('child_exit', { gen: rec.gen, child_pid: rec.pid, code, signal, failed_inflight: failed, expected: stopping || rec === draining })
}

function replayHandshake(rec) {
  if (initRequest === null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      rec.handshake = null
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('no initialize response within ' + HANDSHAKE_TIMEOUT_MS + ' ms')), HANDSHAKE_TIMEOUT_MS)
    rec.handshake = finish
    rec.proc.stdin.write(JSON.stringify({ ...initRequest, id: INIT_ID }) + '\n')
    rec.proc.stdin.write((initializedLine ?? JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })) + '\n')
  })
}

function routeHost(line) {
  const msg = parse(line)
  if (isMessage(msg) && msg.method === 'initialize' && msg.id !== undefined && initResponse !== null) {
    writeHost(JSON.stringify({ ...initResponse, id: msg.id }))
    return
  }
  if (isMessage(msg) && msg.method !== undefined && msg.id !== undefined) {
    if (msg.method === 'initialize' && initRequest === null) initRequest = msg
    inflight.set(keyOf(msg.id), { id: msg.id, method: msg.method, gen: active.gen, startedAt: Date.now() })
  } else if (isMessage(msg) && msg.method === 'notifications/initialized' && initializedLine === null) {
    initializedLine = line
  }
  active.proc.stdin.write(line + '\n')
}

function flushHost() {
  while (!paused && !stopping && hostQueue.length > 0) routeHost(hostQueue.shift())
}

function onHostLine(line) {
  if (line === '') return
  if (paused) hostQueue.push(line)
  else routeHost(line)
}

function waitForDrain(gen) {
  const deadline = Date.now() + DRAIN_MAX_MS
  return new Promise((resolve) => {
    const check = () => {
      if (countInflight(gen) === 0 || Date.now() >= deadline) resolve()
      else setTimeout(check, 50)
    }
    check()
  })
}

async function swapTo(sha) {
  const startedAt = Date.now()
  const old = active
  paused = true
  log('swap_begin', { from_gen: old.gen, from_sha: shortSha(runningSha), to_sha: shortSha(sha), inflight: countInflight(old.gen) })
  let fresh = null
  try {
    fresh = spawnChild('bundle-changed')
    await replayHandshake(fresh)
  } catch (error) {
    rejectedSha = sha
    log('swap_failed', { stage: 'handshake', to_sha: shortSha(sha), kept_gen: old.gen, error: error.message })
    if (fresh) void stopChild(fresh)
    paused = false
    flushHost()
    return
  }
  const drainStartedAt = Date.now()
  await waitForDrain(old.gen)
  const drainMs = Date.now() - drainStartedAt
  const failed = failInflight(old.gen, 'gm-mcp reloaded to a new bundle (' + shortSha(sha) + ') while this request was in flight; resend it')
  draining = old
  active = fresh
  runningSha = sha
  if (fresh.exited) {
    scheduleRestart()
  } else {
    paused = false
    flushHost()
  }
  await stopChild(old)
  draining = null
  log('swap_end', { durationMs: Date.now() - startedAt, drain_ms: drainMs, failed_inflight: failed, from_gen: old.gen, from_pid: old.pid, from_exit: old.exitInfo, to_gen: fresh.gen, to_pid: fresh.pid })
}

function scheduleRestart() {
  if (restartTimer !== null || stopping) return
  const delay = Math.max(0, lastRestartAt + RESTART_GAP_MS - Date.now())
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restartChild()
  }, delay)
}

async function restartChild() {
  lastRestartAt = Date.now()
  const startedAt = Date.now()
  const fresh = spawnChild('crash-restart')
  try {
    await replayHandshake(fresh)
  } catch (error) {
    log('restart_failed', { gen: fresh.gen, error: error.message })
    void stopChild(fresh)
    scheduleRestart()
    return
  }
  active = fresh
  paused = false
  log('restart_end', { gen: fresh.gen, child_pid: fresh.pid, durationMs: Date.now() - startedAt })
  flushHost()
}

async function pollBundle() {
  if (polling || paused || stopping || initRequest === null) return
  polling = true
  try {
    const sha = await bundleSha()
    if (sha === runningSha || sha === rejectedSha) {
      candidateSha = null
      return
    }
    if (sha !== candidateSha) {
      candidateSha = sha
      return
    }
    candidateSha = null
    await swapTo(sha)
  } catch (error) {
    log('poll_error', { error: error.message })
  } finally {
    polling = false
  }
}

async function shutdown(reason) {
  if (stopping) return
  stopping = true
  clearInterval(pollTimer)
  clearTimeout(restartTimer)
  log('stop', { reason, children: [...children].map((rec) => rec.pid) })
  await Promise.all([...children].map(stopChild))
  log('stopped', { reason })
  releaseLock()
  process.exit(0)
}

async function main() {
  acquireLock()
  try {
    runningSha = await bundleSha()
  } catch (error) {
    log('fatal', { bundle: bundlePath, error: 'bundle unreadable: ' + error.message })
    process.exit(1)
  }
  active = spawnChild('start')
  readline.createInterface({ input: process.stdin }).on('line', onHostLine).on('close', () => void shutdown('host-stdin-end'))
  process.stdout.on('error', () => void shutdown('host-stdout-gone'))
  pollTimer = setInterval(() => void pollBundle(), POLL_MS)
  log('start', { bundle: bundlePath, lock: lockPath, sha: shortSha(runningSha), child_pid: active.pid, poll_ms: POLL_MS })
}

process.on('exit', () => {
  for (const rec of children) rec.proc.kill('SIGKILL')
  releaseLock()
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void shutdown('signal ' + signal))

main().catch((error) => {
  log('fatal', { error: error.message })
  process.exit(1)
})
