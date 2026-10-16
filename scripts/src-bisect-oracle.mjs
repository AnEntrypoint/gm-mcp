#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const USAGE = 'git bisect run node scripts/src-bisect-oracle.mjs'
const EXIT_GOOD = 0
const EXIT_BAD = 1
const EXIT_SKIP = 125

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const srcDir = path.join(repoRoot, 'src')

const bad = (cause) => {
    console.log(`RESULT: BAD (${cause})`)
    process.exit(EXIT_BAD)
}

try {
    await import('esbuild')
} catch (err) {
    console.log(`RESULT: SKIP esbuild not loadable from ${repoRoot} (${err.code || err.message}); run npm install there`)
    process.exit(EXIT_SKIP)
}

for (const name of readdirSync(srcDir).filter((file) => file.endsWith('.js'))) {
    try {
        execFileSync(process.execPath, ['--check', path.join(srcDir, name)], { stdio: 'pipe' })
    } catch (err) {
        bad(`syntax in src/${name}: ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' | ')}`)
    }
}

let buildBundle, BUNDLE_VERSION, parseBundleVersion
try {
    buildBundle = (await import('./build.mjs')).buildBundle
    BUNDLE_VERSION = (await import('../src/bundle-version.js')).BUNDLE_VERSION
    parseBundleVersion = (await import('../src/self-update.js')).parseBundleVersion
} catch (err) {
    bad(`src module failed to load: ${err.message.split('\n')[0]}`)
}

let fresh
try {
    fresh = (await buildBundle(false)).outputFiles[0].text
} catch (err) {
    bad(`src/cli.js does not bundle: ${err.message.split('\n')[0]}`)
}

if (parseBundleVersion(fresh) !== BUNDLE_VERSION) {
    bad(`bundle banner version is not the source BUNDLE_VERSION ${BUNDLE_VERSION}`)
}

console.log(`RESULT: GOOD (src/ parses and bundles at BUNDLE_VERSION ${BUNDLE_VERSION}, ${fresh.length} bytes)`)
process.exit(EXIT_GOOD)
