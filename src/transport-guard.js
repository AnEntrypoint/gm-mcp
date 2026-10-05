import process from 'node:process'

const JSON_RPC_FRAME = /^\s*\{[\s\S]*\}\s*$/

function isJsonRpcFrame(chunk) {
    if (typeof chunk === 'string') {
        if (!JSON_RPC_FRAME.test(chunk)) return false
        try {
            JSON.parse(chunk)
            return true
        } catch {
            return false
        }
    }
    if (Buffer.isBuffer(chunk)) return isJsonRpcFrame(chunk.toString('utf8'))
    return false
}

function descriptionOf(error) {
    if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
    return String(error)
}

export function reserveStdoutForJsonRpc() {
    const stdout = process.stdout
    const write = stdout.write.bind(stdout)
    stdout.write = (chunk, encoding, callback) => {
        if (!isJsonRpcFrame(chunk)) {
            const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
            process.stderr.write(`gm-mcp: diverted a non-JSON-RPC stdout write to stderr -- ${text.slice(0, 400)}\n`)
            if (typeof encoding === 'function') encoding()
            else if (typeof callback === 'function') callback()
            return true
        }
        return write(chunk, encoding, callback)
    }
    console.log = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`)
    console.info = console.log
    return stdout
}

export function keepServingOnAsyncFailure() {
    const report = (label) => (error) => {
        process.stderr.write(`gm-mcp: ${label} absorbed, stdio transport stays up -- ${descriptionOf(error)}\n`)
    }
    process.on('uncaughtException', report('uncaught exception'))
    process.on('unhandledRejection', report('unhandled rejection'))
    process.stdin.on('error', report('stdin error'))
    process.stderr.on('error', report('stderr error'))
}

export function exitWhenClientGone() {
    process.stdout.on('error', (error) => {
        process.stderr.write(`gm-mcp: stdout pipe to the client is gone (${descriptionOf(error)}) -- exiting 0 so the next connect spawns a fresh server\n`)
        process.exit(0)
    })
    process.stdin.on('end', () => {
        process.stderr.write('gm-mcp: stdin ended (client disconnected or platform pipe quirk) -- server stays up\n')
    })
}

export function installStdioGuards() {
    keepServingOnAsyncFailure()
    reserveStdoutForJsonRpc()
    exitWhenClientGone()
}
