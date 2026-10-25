// A stale stdio session cannot load the installed bundle in place, and it must not exit: the host
// treats its process exiting as a disconnect. It relays its stdio pipes to a child started from the
// installed bundle instead. The host keeps this process and its pipes; the child answers the requests.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendDiagnostic } from './server-log.js'

const SETTLE_MS = 1000

// Stdin bytes this process has read but the server has not taken. A relay started over them would drop them.
export function undeliveredStdinBytes(transport) {
    const fast = (transport?.buffer?.length ?? 0) + (transport?.pending?.length ?? 0)
    const sdk = transport?._readBuffer?._buffer?.length ?? 0
    return fast + sdk + (process.stdin.readableLength ?? 0)
}

// Starts bundlePath with the given args, keeps it only if it is still up after SETTLE_MS, then pipes stdin
// into it and its stdout back out. Stdin is untouched until the child is confirmed up, and a child that is
// not up is killed before any byte was forwarded, so a failed relay leaves this process serving as before.
export async function relayStdioToBundle({ bundlePath, args = [], transport, dispatchesInFlight = () => 0 }) {
    if (dispatchesInFlight() > 0) return { outcome: 'deferred', reason: 'dispatch-in-flight' }
    if (undeliveredStdinBytes(transport) > 0) return { outcome: 'deferred', reason: 'unread-input' }

    const child = spawn(process.execPath, [bundlePath, ...args], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    try {
        await once(child, 'spawn')
    } catch (error) {
        return { outcome: 'failed', reason: `relay child did not start: ${error.message}` }
    }
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
    const exited = child.exitCode !== null || child.signalCode !== null
    if (exited || dispatchesInFlight() > 0 || undeliveredStdinBytes(transport) > 0) {
        if (!exited) child.kill()
        return { outcome: exited ? 'failed' : 'deferred', reason: exited ? 'relay child exited before taking over' : 'input arrived while the relay child started' }
    }

    child.stdin.on('error', () => {})
    process.stdin.removeAllListeners('data')
    process.stdin.pipe(child.stdin)
    child.stdout.pipe(process.stdout)
    child.once('exit', (code, signal) => {
        appendDiagnostic('stdio-relay-child-exited', { child_pid: child.pid, code, signal, pid: process.pid })
        process.exit(code ?? 1)
    })
    return { outcome: 'relaying', child_pid: child.pid, bundlePath }
}
