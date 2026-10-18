#!/usr/bin/env node
import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { BUNDLE_VERSION } from '../src/bundle-version.js'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.dirname(path.dirname(scriptPath))

export function uncommittedSrcPaths(root) {
    return execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
}

export async function buildBundle(write = false) {
    return esbuild.build({
        entryPoints: [path.join(repoRoot, 'src', 'cli.js')],
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'esm',
        external: ['node:*'],
        banner: { js: `#!/usr/bin/env node\nvar BUNDLE_VERSION = ${JSON.stringify(BUNDLE_VERSION)};` },
        preserveSymlinks: true,
        outfile: path.join(repoRoot, 'bin', 'gm-mcp-server.js'),
        write,
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const dirty = process.env.GM_MCP_BUILD_ALLOW_DIRTY ? [] : uncommittedSrcPaths(repoRoot)
    if (dirty.length) {
        console.error(`refusing to write bin/gm-mcp-server.js: uncommitted src/ paths would ship in the bundle:\n${dirty.join('\n')}\ncommit them first, or set GM_MCP_BUILD_ALLOW_DIRTY=1 to bundle the working tree on purpose`)
        process.exit(1)
    }
    await buildBundle(true)
}
