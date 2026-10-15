const NODE_NAMES = new Set(['node', 'node.exe'])
const SERVER_ENTRY_PATTERN = /(^|[\\/])gm-mcp-server\.(mjs|cjs|js)$/i

function basenameOf(token) {
    return token.replace(/^.*[\\/]/, '').toLowerCase()
}

export function commandTokens(command) {
    if (typeof command !== 'string' || command === '') return []
    const tokens = []
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
    let match
    while ((match = pattern.exec(command)) !== null) tokens.push(match[1] ?? match[2] ?? match[3])
    return tokens
}

export function flagPortOf(args) {
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index]
        if (token === '--port') {
            const port = Number.parseInt(args[index + 1] ?? '', 10)
            return Number.isInteger(port) && port > 0 ? port : null
        }
        const inline = /^--port=(\d+)$/.exec(token)
        if (inline !== null) {
            const port = Number.parseInt(inline[1], 10)
            return Number.isInteger(port) && port > 0 ? port : null
        }
    }
    return null
}

export function classifyGmServerCommand(command, { entryPath = null } = {}) {
    const tokens = commandTokens(command)
    if (tokens.length < 2) return null
    const program = basenameOf(tokens[0])
    if (!NODE_NAMES.has(program) && program !== basenameOf(process.execPath)) return null
    let entryIndex = -1
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (SERVER_ENTRY_PATTERN.test(token)) {
            entryIndex = index
            break
        }
        if (entryPath !== null && token === entryPath) {
            entryIndex = index
            break
        }
    }
    if (entryIndex === -1) return null
    const entry = tokens[entryIndex]
    const args = tokens.slice(entryIndex + 1)
    if (args.includes('http-supervise')) return { entry, transport: 'supervisor', port: flagPortOf(args) }
    if (args.includes('--http')) return { entry, transport: 'http', port: flagPortOf(args) }
    return { entry, transport: 'stdio', port: null }
}
