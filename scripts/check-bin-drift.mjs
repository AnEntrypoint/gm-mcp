#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBundle, bundleVersion, srcSha256 } from './build.mjs'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (!existsSync(path.join(repoRoot, 'node_modules', 'esbuild', 'package.json'))) {
    console.error(`esbuild is not installed under ${path.join(repoRoot, 'node_modules')} (a gm-mcp devDependency, absent from a clean clone), so the drift gate cannot build the bundle: install the locked devDependencies and rerun`)
    process.exit(1)
}
const binRel = 'bin/gm-mcp-server.js'
const committedPath = path.join(repoRoot, binRel)
const includedSrc = (process.env.GM_MCP_BUILD_INCLUDE || '').split(',').map(s => s.trim()).filter(Boolean)
const git = args => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const binStaged = git(['diff', '--cached', '--name-only']).stdout.split('\n').map(line => line.trim()).includes(binRel)
const shipsWorkingBin = includedSrc.includes(binRel)
let buildRoot = repoRoot
let stagedDir = null
if (binStaged || !shipsWorkingBin) {
    stagedDir = mkdtempSync(path.join(tmpdir(), 'gm-mcp-staged-'))
    const treeDir = path.join(stagedDir, 'tree')
    mkdirSync(treeDir)
    const env = binStaged ? process.env : { ...process.env, GIT_INDEX_FILE: path.join(stagedDir, 'index') }
    const gitIn = args => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
    if (!binStaged) {
        const loaded = gitIn(['read-tree', 'HEAD'])
        if (loaded.status !== 0) {
            console.error(`cannot load HEAD into a scratch index: ${(loaded.stderr || '').trim()}`)
            process.exit(1)
        }
    }
    const exported = gitIn(['checkout-index', '-a', `--prefix=${treeDir}${path.sep}`])
    if (exported.status !== 0) {
        console.error(`cannot export the ${binStaged ? 'staged index' : 'HEAD tree'}: ${(exported.stderr || '').trim()}`)
        process.exit(1)
    }
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(treeDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    buildRoot = treeDir
}

const BUNDLE_VERSION = bundleVersion(buildRoot)
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(buildRoot, 'package.json'), 'utf8')).version
if (PACKAGE_VERSION !== BUNDLE_VERSION) {
    console.error(`package.json version ${PACKAGE_VERSION} differs from src/bundle-version.js BUNDLE_VERSION ${BUNDLE_VERSION}: set both to the same release version in one commit`)
    process.exit(1)
}

const headBin = git(['show', `HEAD:${binRel}`])
const committed = binStaged
    ? git(['show', `:${binRel}`]).stdout
    : shipsWorkingBin || headBin.status !== 0 ? readFileSync(committedPath, 'utf8') : headBin.stdout

const result = await buildBundle(false, buildRoot)
const fresh = result.outputFiles[0].text
const currentSrcSha = srcSha256(buildRoot)
if (stagedDir) rmSync(stagedDir, { recursive: true, force: true })

if (!fresh.includes(`var BUNDLE_VERSION = ${JSON.stringify(BUNDLE_VERSION)};`)) {
    console.error(`fresh bundle is missing the working-tree BUNDLE_VERSION ${BUNDLE_VERSION} banner`)
    process.exit(1)
}

const recordedSrcSha = /var BUNDLE_SRC_SHA256 = "([0-9a-f]{64})";/.exec(committed)?.[1] ?? null
if (recordedSrcSha !== currentSrcSha) {
    console.error(`bin/gm-mcp-server.js records src sha256 ${recordedSrcSha ?? 'none'} but src/ hashes to ${currentSrcSha}: a src/ file changed after the bundle was built, so the bundle is stale. Run npm run build and commit the bundle with the src/ change.`)
    process.exit(1)
}

const headChanged = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'])
const headFiles = headChanged.status === 0 ? headChanged.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
const srcFiles = headFiles.filter(p => p.startsWith('src/'))
const regenSet = [binRel, ...srcFiles].join(' ')

if (committed === fresh) {
    console.log(`bin/gm-mcp-server.js matches a fresh build of ${binStaged ? 'the staged' : shipsWorkingBin ? 'the working-tree' : "HEAD's"} src/ (${fresh.length} bytes) -- no drift`)
} else {
    console.error(`bin/gm-mcp-server.js is STALE: it does not match a fresh build of ${binStaged ? 'the staged' : "HEAD's"} src/ (committed ${committed.length} bytes, fresh ${fresh.length} bytes).`)
    console.error(srcFiles.length
        ? `HEAD changed src/ without rebuilding the bin: ${srcFiles.join(', ')}`
        : 'HEAD changed no src/ file, so the bin was edited by hand or built from other sources.')
    console.error(`Regenerate and commit in ONE commit with the src/ change. File set: ${regenSet}`)
    console.error(`  npm run build && git add ${regenSet} && git commit -m "<subject>"`)
    console.error('  (if the src/ change is already HEAD, use: git commit --amend --no-edit)')
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
