// Process state for liveness verdicts. kill(pid, 0) only says something still owns the pid, and a
// zombie (exited, never reaped by its parent) answers it forever, so a daemon that died under a
// guard that never reaped it reads as alive and nothing replaces it. `ps -o stat=` tells the two
// apart; the `ps` answer is kept 1.5 s so the per-poll liveness reads do not spawn it each tick.
import { spawnSync } from './process-port.js'

const PS_ANSWER_TTL_MS = 1500
const PS_CACHE_MAX_ENTRIES = 64
const psAnswers = new Map()

function psState(pid, now) {
    const cached = psAnswers.get(pid)
    if (cached && now - cached.at < PS_ANSWER_TTL_MS) return cached.state
    const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, windowsHide: true })
    let state = 'running'
    if (!ps.error && ps.status !== null) {
        const stat = String(ps.stdout ?? '').trim()
        state = stat === '' ? 'gone' : stat[0] === 'Z' ? 'zombie' : 'running'
    }
    if (psAnswers.size >= PS_CACHE_MAX_ENTRIES) psAnswers.delete(psAnswers.keys().next().value)
    psAnswers.set(pid, { at: now, state })
    return state
}

// 'running' | 'zombie' | 'gone' | 'invalid'. Where `ps` is unavailable the answer is 'running':
// kill(pid, 0) already said the pid exists, and nothing here proves it is a zombie.
export function pidState(pid, now = Date.now()) {
    const value = Number(pid)
    if (!Number.isInteger(value) || value <= 0) return 'invalid'
    try {
        process.kill(value, 0)
    } catch (error) {
        if (error?.code !== 'EPERM') return 'gone'
    }
    if (process.platform === 'win32') return 'running'
    return psState(value, now)
}
