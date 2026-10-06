#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBundle } from './build.mjs'
import { BUNDLE_VERSION } from '../src/bundle-version.js'
import { parseBundleVersion } from '../src/self-update.js'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const committedPath = path.join(repoRoot, 'bin', 'gm-mcp-server.js')

const result = await buildBundle(false)

const committed = readFileSync(committedPath, 'utf8')
const fresh = result.outputFiles[0].text

if (parseBundleVersion(fresh) !== BUNDLE_VERSION) {
    console.error(`fresh bundle is missing the source BUNDLE_VERSION ${BUNDLE_VERSION} recognized by the updater`)
    process.exit(1)
}

if (committed === fresh) {
    console.log(`bin/gm-mcp-server.js matches a fresh build of src/ (${fresh.length} bytes) -- no drift`)
    process.exit(0)
}

console.error('bin/gm-mcp-server.js is STALE: it does not match a fresh build of src/cli.js.')
console.error(`committed: ${committed.length} bytes -- fresh build: ${fresh.length} bytes`)
console.error('Run: npm run build   (then commit bin/gm-mcp-server.js in the same commit as the src/ change)')
process.exit(1)
