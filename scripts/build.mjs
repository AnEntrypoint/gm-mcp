#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
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

const BUNDLE_ENTRIES = ['src/cli.js', 'src/fast-entry.js']
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g

function resolveRelativeImport(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec)
    for (const candidate of [base, base + '.js', path.join(base, 'index.js')]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    return null
}

export function bundleSourcePaths(root) {
    const seen = new Set()
    const pending = BUNDLE_ENTRIES.map(rel => path.join(root, rel))
    while (pending.length) {
        const file = pending.pop()
        if (seen.has(file) || !existsSync(file)) continue
        seen.add(file)
        for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
            const next = resolveRelativeImport(file, match[1])
            if (next) pending.push(next)
        }
    }
    return [...seen].map(file => path.relative(root, file).split(path.sep).join('/')).sort()
}

export function srcSha256(root) {
    const hash = createHash('sha256')
    for (const rel of bundleSourcePaths(root)) {
        hash.update(rel).update('\0').update(readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/g, '\n')).update('\0')
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

// The served file is a small cold-start entry (src/fast-entry.js) that embeds the full CLI bundle as a
// string and imports it as a data: module only when a request needs the SDK. Parsing the full bundle
// as a script cost ~50 ms of every cold start; the string literal costs almost nothing to scan.
export async function buildBundle(write = false, root = repoRoot) {
    const esbuild = await import('esbuild')
    const versionVars = `var BUNDLE_VERSION = ${JSON.stringify(bundleVersion(root))};\nvar BUNDLE_SRC_SHA256 = ${JSON.stringify(srcSha256(root))};\nvar BUNDLE_DEPS = ${JSON.stringify(bundleDepManifest(root))};`
    const full = await esbuild.build({
        entryPoints: [path.join(root, 'src', 'cli.js')],
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'esm',
        external: ['node:*'],
        define: { 'import.meta.url': 'globalThis.__gmBundleUrl' },
        banner: { js: versionVars },
        write: false,
    })
    const fullSource = full.outputFiles[0].text
    const fullPlugin = {
        name: 'gm-full-bundle',
        setup(build) {
            build.onResolve({ filter: /^gm:full-bundle$/ }, () => ({ path: 'gm:full-bundle', namespace: 'gm-full' }))
            build.onLoad({ filter: /.*/, namespace: 'gm-full' }, () => ({ contents: `export default ${JSON.stringify(fullSource)}`, loader: 'js' }))
        },
    }
    return esbuild.build({
        entryPoints: [path.join(root, 'src', 'fast-entry.js')],
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'esm',
        external: ['node:*'],
        plugins: [fullPlugin],
        banner: { js: `#!/usr/bin/env node\n${versionVars}` },
        preserveSymlinks: true,
        outfile: path.join(root, 'bin', 'gm-mcp-server.js'),
        write,
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    await buildBundle(true)
}
