// Probe the live gm HTTP MCP endpoint exactly the way a Claude Code client does:
// initialize -> notifications/initialized -> tools/list -> tools/call, then idle
// and call again. Run: node test/mcp-http-probe.mjs [port] [idleSeconds]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const port = Number(process.argv[2] || 8787)
const idleSeconds = Number(process.argv[3] || 0)
const url = `http://127.0.0.1:${port}/mcp`

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a) }

const client = new Client({ name: 'gm-http-probe', version: '1.0.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(new URL(url))
transport.onerror = (e) => log('TRANSPORT ERROR:', e && (e.stack || e.message || e))
transport.onclose = () => log('TRANSPORT CLOSED')

log('connecting', url)
const t0 = Date.now()
await client.connect(transport)
log('connected in', Date.now() - t0, 'ms; serverInfo=', JSON.stringify(client.getServerVersion()))
log('sessionId =', transport.sessionId)
log('protocolVersion =', client.getServerCapabilities() ? '(caps ok)' : '(no caps)')

const tools = await client.listTools()
log('tools/list ->', tools.tools.length, 'tools:', tools.tools.map((t) => t.name).join(', '))

const callArgs = { verb: 'health', cwd: 'C:/dev/gm' }
const toolName = tools.tools.some((t) => t.name === 'gm') ? 'gm' : tools.tools[0].name
log('tools/call', toolName, JSON.stringify(callArgs).slice(0, 120))
const r1 = await client.callTool({ name: toolName, arguments: callArgs })
log('call 1 ok; text len =', JSON.stringify(r1).length)

if (idleSeconds > 0) {
    log('idling', idleSeconds, 's ...')
    await new Promise((r) => setTimeout(r, idleSeconds * 1000))
    log('idle over; transport.sessionId still', transport.sessionId)
}

const r2 = await client.callTool({ name: toolName, arguments: callArgs })
log('call 2 ok; text len =', JSON.stringify(r2).length)
log('OK: initialize + tools/list + tools/call round trip complete')
await client.close()
process.exit(0)
