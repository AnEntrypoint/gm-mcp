const NODE_NAMES = new Set(['node', 'node.exe'])
const SERVER_ENTRY_PATTERN = /(^|[\\/])gm-mcp-server\.(mjs|cjs|js)$/i
const SUPERVISOR_ENTRY_PATTERN = /(^|[\\/])gm-supervise\.(mjs|cjs|js)$/i
// The project .mcp.json launcher is `node -e <script>`: the script imports the bundle, so no argv token names it.
const LAUNCHER_PATTERN = /^\s*"?(?:[^\s"]*[\\/])?node(?:\.exe)?"?\s+(?:-e|--eval)\s/i

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

// A `node -e` launcher that imports the bundle. Its script names the bundle and calls import(); it carries no --http flag,
// so the server it starts is a stdio server with no port.
function launcherOf(command) {
    if (typeof command !== 'string' || !LAUNCHER_PATTERN.test(command) || !/\bimport\s*\(/.test(command)) return null
    const bundle = /gm-mcp-server\.(?:mjs|cjs|js)/i.exec(command)
    if (bundle === null || /\s--http(\s|$)/.test(command)) return null
    return { entry: bundle[0], transport: 'stdio', port: null }
}

export function classifyGmServerCommand(command, { entryPath = null } = {}) {
    const launcher = launcherOf(command)
    if (launcher !== null) return launcher
    const tokens = commandTokens(command)
    if (tokens.length < 2) return null
    const program = basenameOf(tokens[0])
    if (!NODE_NAMES.has(program) && program !== basenameOf(process.execPath)) return null
    let entryIndex = -1
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (SERVER_ENTRY_PATTERN.test(token) || SUPERVISOR_ENTRY_PATTERN.test(token)) {
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
    if (SUPERVISOR_ENTRY_PATTERN.test(entry) || args.includes('http-supervise')) return { entry, transport: 'supervisor', port: flagPortOf(args) }
    if (args.includes('--http')) return { entry, transport: 'http', port: flagPortOf(args) }
    return { entry, transport: 'stdio', port: null }
}

const RUNNER_NAMES = new Set(['agentplug-runner', 'agentplug-runner.exe'])

// The agentplug runner binary. The argument daemon-guard makes it the guard. A node -e stand-in that sets its process title
// to agentplug-runner classifies the same way.
export function classifyRunnerCommand(command) {
    const tokens = commandTokens(command)
    if (tokens.length === 0 || !RUNNER_NAMES.has(basenameOf(tokens[0]))) return null
    return { kind: tokens.slice(1).includes('daemon-guard') ? 'guard' : 'runner' }
}
