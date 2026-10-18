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

export function headSrcPlugin(root, keep) {
    const dirty = new Set(uncommittedSrcPaths(root).map(line => line.slice(3)))
    return {
        name: 'head-src',
        setup(build) {
            build.onLoad({ filter: /[\\/]src[\\/].*\.js$/ }, args => {
                const rel = path.relative(root, args.path).split(path.sep).join('/')
                if (!dirty.has(rel) || keep.has(rel)) return undefined
                return { contents: execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }), loader: 'js' }
            })
        },
    }
}

export async function buildBundle(write = false, keep = new Set()) {
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
        plugins: [headSrcPlugin(repoRoot, keep)],
        write,
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const keep = new Set((process.env.GM_MCP_BUILD_INCLUDE || '').split(',').map(s => s.trim()).filter(Boolean))
    const dirty = uncommittedSrcPaths(repoRoot).map(line => line.slice(3))
    if (process.env.GM_MCP_BUILD_ALLOW_DIRTY) dirty.forEach(p => keep.add(p))
    const foreign = dirty.filter(p => !keep.has(p))
    if (foreign.length) console.error(`bundling committed HEAD for uncommitted src/ paths (name them in GM_MCP_BUILD_INCLUDE to ship them):\n${foreign.join('\n')}`)
    await buildBundle(true, keep)
}
