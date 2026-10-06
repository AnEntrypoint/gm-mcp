#!/usr/bin/env node
import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLE_VERSION } from '../src/bundle-version.js'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.dirname(path.dirname(scriptPath))

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

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await buildBundle(true)
