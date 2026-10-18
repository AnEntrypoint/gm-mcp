#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
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
} else {
    console.error('bin/gm-mcp-server.js is STALE: it does not match a fresh build of src/cli.js.')
    console.error(`committed: ${committed.length} bytes -- fresh build: ${fresh.length} bytes`)
    console.error('Run: npm run build   (then commit bin/gm-mcp-server.js in the same commit as the src/ change)')
    process.exit(1)
}

const REQUIRED_REPLY_KEYS = ['timed_out', 'task', 'poll_timeout_ms', 'in_path', 'out_path', 'resume_task_supported', 'dispatch_state', 'dispatch_wait', 'daemon']

const selfCheck = spawnSync(process.execPath, [committedPath, 'self-check'], { encoding: 'utf8' })
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
