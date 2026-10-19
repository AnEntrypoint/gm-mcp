#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBundle, headBundleVersion, uncommittedSrcPaths } from './build.mjs'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUNDLE_VERSION = headBundleVersion(repoRoot)
const binRel = 'bin/gm-mcp-server.js'
const committedPath = path.join(repoRoot, binRel)
const includedSrc = (process.env.GM_MCP_BUILD_INCLUDE || '').split(',').map(s => s.trim()).filter(Boolean)

const foreignSrc = uncommittedSrcPaths(repoRoot).map(line => line.slice(3)).filter(p => !includedSrc.includes(p))
if (foreignSrc.length) {
    console.error(`refusing drift check: uncommitted src/ paths not named in GM_MCP_BUILD_INCLUDE (the working-tree build would mix them with HEAD's banner; a clean clone gives a different verdict):\n${foreignSrc.join('\n')}`)
    process.exit(1)
}

const result = await buildBundle(false, new Set(includedSrc))

const shipsWorkingBin = includedSrc.includes(binRel)
const headBin = spawnSync('git', ['show', `HEAD:${binRel}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const committed = shipsWorkingBin || headBin.status !== 0 ? readFileSync(committedPath, 'utf8') : headBin.stdout

const fresh = result.outputFiles[0].text

if (!fresh.includes(`var BUNDLE_VERSION = ${JSON.stringify(BUNDLE_VERSION)};`)) {
    console.error(`fresh bundle is missing the HEAD BUNDLE_VERSION ${BUNDLE_VERSION} banner`)
    process.exit(1)
}

if (committed === fresh) {
    console.log(`bin/gm-mcp-server.js matches a fresh build of src/ (${fresh.length} bytes) -- no drift`)
} else {
    console.error('bin/gm-mcp-server.js is STALE: it does not match a fresh build of src/cli.js.')
    console.error(`committed: ${committed.length} bytes -- fresh build: ${fresh.length} bytes`)
    console.error('Run: npm run build   (then commit bin/gm-mcp-server.js in the same commit as the src/ change)')
    process.exit(1)
}

const REQUIRED_REPLY_KEYS = ['timed_out', 'task', 'poll_timeout_ms', 'in_path', 'out_path', 'resume_task_supported', 'dispatch_state', 'dispatch_wait', 'daemon']

const selfCheckDir = mkdtempSync(path.join(tmpdir(), 'gm-mcp-drift-'))
const selfCheckPath = path.join(selfCheckDir, 'gm-mcp-server.mjs')
writeFileSync(selfCheckPath, committed)
const selfCheck = spawnSync(process.execPath, [selfCheckPath, 'self-check'], { encoding: 'utf8' })
rmSync(selfCheckDir, { recursive: true, force: true })
if (selfCheck.error) {
    console.error(`bin/gm-mcp-server.js self-check did not run: ${selfCheck.error.message}`)
    process.exit(1)
}
if (selfCheck.status !== 0) {
    console.error(`bin/gm-mcp-server.js self-check exited ${selfCheck.status}: ${(selfCheck.stderr || '').trim()}`)
    process.exit(1)
}
let envelopes
try {
    envelopes = JSON.parse(selfCheck.stdout)
} catch (error) {
    console.error(`bin/gm-mcp-server.js self-check printed no JSON: ${error.message}`)
    process.exit(1)
}
if (!envelopes || typeof envelopes !== 'object' || Object.keys(envelopes).length === 0) {
    console.error('bin/gm-mcp-server.js self-check printed no reply envelope, so the gate checked nothing')
    process.exit(1)
}
const problems = []
for (const [name, reply] of Object.entries(envelopes)) {
    if (!reply || typeof reply !== 'object') {
        problems.push(`${name} is not a reply object`)
        continue
    }
    for (const key of REQUIRED_REPLY_KEYS) if (!(key in reply)) problems.push(`${name} carries no ${key}`)
    if (reply.timed_out !== true) problems.push(`${name} does not report timed_out: true`)
    if (reply.diagnostics_failed !== undefined) problems.push(`${name} fell back to its minimal reply: ${reply.diagnostics_failed}`)
    if (reply.requested_poll_timeout_ms === undefined) problems.push(`${name} never reached its own diagnostics`)
}
if (problems.length > 0) {
    for (const problem of problems) console.error(`bin/gm-mcp-server.js self-check: ${problem}`)
    process.exit(1)
}
console.log(`bin/gm-mcp-server.js self-check built every reply a dispatch can end on (${Object.keys(envelopes).join(', ')})`)
process.exit(0)
