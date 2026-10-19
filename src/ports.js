import { execFile } from 'node:child_process'
import net from 'node:net'

const LISTENER_CACHE_TTL_MS = 1_000
const listenerCache = new Map()

function runProbe(file, args, options) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], ...options }, (error, stdout) => {
            if (error) reject(error)
            else resolve(stdout)
        })
    })
}

export async function portListenerState(port) {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted <= 0) return { measured: false, hasListener: null, ownerPid: null }
    const now = Date.now()
    const cached = listenerCache.get(wanted)
    if (cached !== undefined && now - cached.at < LISTENER_CACHE_TTL_MS) return cached.state
    const state = await measurePortListener(wanted)
    listenerCache.set(wanted, { at: Date.now(), state })
    return state
}

async function measurePortListener(wanted) {
    try {
        if (process.platform === 'win32') {
            const text = await runProbe('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true })
            return parseWindowsNetstatListener(text, wanted)
        }
        const text = await runProbe('lsof', ['-nP', `-iTCP:${wanted}`, '-sTCP:LISTEN', '-t'], {})
        const pid = Number.parseInt(text.trim().split('\n')[0] ?? '', 10)
        if (Number.isInteger(pid) && pid > 0) return { measured: true, hasListener: true, ownerPid: pid }
        return { measured: true, hasListener: false, ownerPid: null }
    } catch (error) {
        if (error?.code === 'ENOENT') return ssListenerState(wanted)
        return { measured: true, hasListener: false, ownerPid: null }
    }
}

export function parseWindowsNetstatListener(text, wanted) {
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 5 || !/^tcp/i.test(fields[0])) continue
        const localPort = /[:.](\d+)$/.exec(fields[1])
        if (localPort === null || Number(localPort[1]) !== wanted) continue
        if (!/[:.]0$/.test(fields[2])) continue
        const pid = Number.parseInt(fields[fields.length - 1], 10)
        return { measured: true, hasListener: true, ownerPid: Number.isInteger(pid) && pid > 0 ? pid : null }
    }
    return { measured: true, hasListener: false, ownerPid: null }
}

async function ssListenerState(wanted) {
    try {
        const text = await runProbe('ss', ['-H', '-ltnp', `sport = :${wanted}`], {})
        if (text.trim() === '') return { measured: true, hasListener: false, ownerPid: null }
        const pid = Number.parseInt(/pid=(\d+)/.exec(text)?.[1] ?? '', 10)
        return { measured: true, hasListener: true, ownerPid: Number.isInteger(pid) && pid > 0 ? pid : null }
    } catch (error) {
        return error?.code === 'ENOENT' ? { measured: false, hasListener: null, ownerPid: null } : { measured: true, hasListener: false, ownerPid: null }
    }
}

export async function listeningPidOf(port) {
    return (await portListenerState(port)).ownerPid
}

export function portAcceptsConnection(port, timeoutMs = 1_500) {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted <= 0) return Promise.resolve(null)
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: wanted })
        const timer = setTimeout(() => {
            socket.destroy()
            resolve(false)
        }, timeoutMs)
        socket.once('connect', () => {
            clearTimeout(timer)
            socket.destroy()
            resolve(true)
        })
        socket.once('error', () => {
            clearTimeout(timer)
            resolve(false)
        })
    })
}
