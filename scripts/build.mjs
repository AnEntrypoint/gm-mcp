#!/usr/bin/env node
import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.dirname(path.dirname(scriptPath))

export function headBundleVersion(root) {
    const src = execFileSync('git', ['show', 'HEAD:src/bundle-version.js'], { cwd: root, encoding: 'utf8' })
    const m = src.match(/BUNDLE_VERSION\s*=\s*'([^']+)'/)
    if (!m) throw new Error('HEAD:src/bundle-version.js has no BUNDLE_VERSION literal')
    return m[1]
}

function committedOrNamed(root, rel, keep) {
    if (keep.has(rel)) return readFileSync(path.join(root, rel), 'utf8')
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' })
}

export function bundleDepManifest(root, keep = new Set()) {
    const pkg = JSON.parse(committedOrNamed(root, 'package.json', keep))
    const lock = JSON.parse(committedOrNamed(root, 'package-lock.json', keep))
    const out = {}
    for (const name of Object.keys(pkg.devDependencies || {}).filter(n => n !== 'esbuild').sort())
        out[name] = lock.packages?.[`node_modules/${name}`]?.version ?? null
    return out
}

export function uncommittedSrcPaths(root) {
    return execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
}

function headOrWorktree(root, rel) {
    try {
        return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
        return readFileSync(path.join(root, rel), 'utf8')
    }
}

export function headSrcPlugin(root, keep) {
    const dirty = new Set(uncommittedSrcPaths(root).map(line => line.slice(3)))
    return {
        name: 'head-src',
        setup(build) {
            build.onLoad({ filter: /[\\/]src[\\/].*\.js$/ }, args => {
                const rel = path.relative(root, args.path).split(path.sep).join('/')
                if (!dirty.has(rel) || keep.has(rel)) return undefined
                return { contents: headOrWorktree(root, rel), loader: 'js' }
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
        banner: { js: `#!/usr/bin/env node\nvar BUNDLE_VERSION = ${JSON.stringify(headBundleVersion(repoRoot))};\nvar BUNDLE_DEPS = ${JSON.stringify(bundleDepManifest(repoRoot, keep))};` },
        preserveSymlinks: true,
        outfile: path.join(repoRoot, 'bin', 'gm-mcp-server.js'),
        plugins: [headSrcPlugin(repoRoot, keep)],
        write,
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const keep = new Set((process.env.GM_MCP_BUILD_INCLUDE || '').split(',').map(s => s.trim()).filter(Boolean))
    const dirty = uncommittedSrcPaths(repoRoot).map(line => line.slice(3))
    const foreign = dirty.filter(p => !keep.has(p))
    if (foreign.length) console.error(`bundling committed HEAD for uncommitted src/ paths (name them in GM_MCP_BUILD_INCLUDE to ship them):\n${foreign.join('\n')}`)
    await buildBundle(true, keep)
}
