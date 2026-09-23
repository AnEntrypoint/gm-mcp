#!/usr/bin/env node
// Rebuilds src/cli.js the same way `npm run build` does, then fails if the
// result differs from the committed bin/gm-mcp-server.js -- the MCP SDK
// silently strips any tool argument missing from the bundle's inputSchema,
// so a stale bundle is a silent API regression (see README "Development").
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const committedPath = path.join(repoRoot, 'bin', 'gm-mcp-server.js')

const result = await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'cli.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['node:*'],
    banner: { js: '#!/usr/bin/env node' },
    write: false,
})

const committed = readFileSync(committedPath, 'utf8')
const fresh = result.outputFiles[0].text

if (committed === fresh) {
    console.log(`bin/gm-mcp-server.js matches a fresh build of src/ (${fresh.length} bytes) -- no drift`)
    process.exit(0)
}

console.error('bin/gm-mcp-server.js is STALE: it does not match a fresh build of src/cli.js.')
console.error(`committed: ${committed.length} bytes -- fresh build: ${fresh.length} bytes`)
console.error('Run: npm run build   (then commit bin/gm-mcp-server.js in the same commit as the src/ change)')
process.exit(1)
