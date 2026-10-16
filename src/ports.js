import { execFileSync } from 'node:child_process'
import net from 'node:net'


export function portListenerState(port) {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted <= 0) return { measured: false, hasListener: null, ownerPid: null }
    try {
        if (process.platform === 'win32') {
            const text = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
            for (const line of text.split('\n')) {
                const fields = line.trim().split(/\s+/)
                if (fields.length < 4 || !/^tcp/i.test(fields[0])) continue
                if (!/LISTENING/i.test(fields[3])) continue
                const localPort = /[:.](\d+)$/.exec(fields[1] ?? '')
                if (localPort === null || Number(localPort[1]) !== wanted) continue
                const pid = Number.parseInt(fields[fields.length - 1] ?? '', 10)
                return { measured: true, hasListener: true, ownerPid: Number.isInteger(pid) && pid > 0 ? pid : null }
            }
            return { measured: true, hasListener: false, ownerPid: null }
        }
        const text = execFileSync('lsof', ['-nP', `-iTCP:${wanted}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
        const pid = Number.parseInt(text.trim().split('\n')[0] ?? '', 10)
        if (Number.isInteger(pid) && pid > 0) return { measured: true, hasListener: true, ownerPid: pid }
        return { measured: true, hasListener: false, ownerPid: null }
    } catch (error) {
        if (error?.code === 'ENOENT') return ssListenerState(wanted)
        return { measured: true, hasListener: false, ownerPid: null }
    }
}

function ssListenerState(wanted) {
    try {
        const text = execFileSync('ss', ['-H', '-ltnp', `sport = :${wanted}`], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
        if (text.trim() === '') return { measured: true, hasListener: false, ownerPid: null }
        const pid = Number.parseInt(/pid=(\d+)/.exec(text)?.[1] ?? '', 10)
        return { measured: true, hasListener: true, ownerPid: Number.isInteger(pid) && pid > 0 ? pid : null }
    } catch (error) {
        return error?.code === 'ENOENT' ? { measured: false, hasListener: null, ownerPid: null } : { measured: true, hasListener: false, ownerPid: null }
    }
}

export function listeningPidOf(port) {
    return portListenerState(port).ownerPid
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
