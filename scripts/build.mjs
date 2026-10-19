#!/usr/bin/env node
import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.dirname(path.dirname(scriptPath))

export function bundleVersion(root) {
    const src = readFileSync(path.join(root, 'src', 'bundle-version.js'), 'utf8')
    const m = src.match(/BUNDLE_VERSION\s*=\s*'([^']+)'/)
    if (!m) throw new Error('src/bundle-version.js has no BUNDLE_VERSION literal')
    return m[1]
}

export function srcSha256(root) {
    const hash = createHash('sha256')
    for (const name of readdirSync(path.join(root, 'src')).filter(n => n.endsWith('.js')).sort()) {
        hash.update(name).update('\0').update(readFileSync(path.join(root, 'src', name), 'utf8').replace(/\r\n?/g, '\n')).update('\0')
    }
    return hash.digest('hex')
}

export function bundleDepManifest(root) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
    const out = {}
    for (const name of Object.keys(pkg.devDependencies || {}).filter(n => n !== 'esbuild').sort())
        out[name] = lock.packages?.[`node_modules/${name}`]?.version ?? null
    return out
}

export async function buildBundle(write = false, root = repoRoot) {
    return esbuild.build({
        entryPoints: [path.join(root, 'src', 'cli.js')],
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'esm',
        external: ['node:*'],
        banner: { js: `#!/usr/bin/env node\nvar BUNDLE_VERSION = ${JSON.stringify(bundleVersion(root))};\nvar BUNDLE_SRC_SHA256 = ${JSON.stringify(srcSha256(root))};\nvar BUNDLE_DEPS = ${JSON.stringify(bundleDepManifest(root))};` },
        preserveSymlinks: true,
        outfile: path.join(root, 'bin', 'gm-mcp-server.js'),
        write,
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    await buildBundle(true)
}
