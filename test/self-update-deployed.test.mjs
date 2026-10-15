import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLE_VERSION } from '../src/bundle-version.js'
import { toolsDir } from '../src/paths.js'
import { compareVersions, deferRetryState, localBuildPinPath, pendingDeferRetry, refreshStaleDeployedBundle, refreshStaleDeployedBundleInBackground } from '../src/self-update.js'

let passed = 0
async function test(name, fn) {
    try {
        await fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

const FILLER = 'x'.repeat(120_000)
const bundleBytes = (version, which) => Buffer.from(`#!/usr/bin/env node\nconst BUNDLE_VERSION = ${JSON.stringify(version)}\n/* ${which} ${FILLER} */\n`, 'utf8')
const majorOf = (version) => Number.parseInt(String(version).split(/[.+-]/)[0], 10) || 0
const newerThanRunning = `${majorOf(BUNDLE_VERSION) + 1}.0.0`
const olderThanRunning = majorOf(BUNDLE_VERSION) > 0 ? `${majorOf(BUNDLE_VERSION) - 1}.999.999` : '0.0.0'

const SAVED_ENV = ['AGENTPLUG_HOME', 'GM_TOOLS_DIR', 'GM_MCP_BUNDLE_URL', 'GM_MCP_NO_SELF_UPDATE', 'GM_MCP_SELF_UPDATE', 'GM_MCP_SELF_UPDATE_DEPLOYED_ONLY', 'GM_MCP_SELF_UPDATE_INTERVAL_MS']

const REAL_DEPLOYED_PATH = path.join(toolsDir(), 'gm-mcp-server.mjs')

function scenario({ deployedVersion = olderThanRunning, candidateVersion = newerThanRunning } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'gm-mcp-self-update-'))
    const deployedPath = path.join(root, 'gm-mcp-server.mjs')
    const candidatePath = path.join(root, 'candidate.mjs')
    writeFileSync(deployedPath, bundleBytes(deployedVersion, 'deployed'))
    writeFileSync(candidatePath, bundleBytes(candidateVersion, 'candidate'))
    const saved = {}
    for (const name of SAVED_ENV) saved[name] = process.env[name]
    process.env.AGENTPLUG_HOME = root
    process.env.GM_TOOLS_DIR = root
    process.env.GM_MCP_BUNDLE_URL = pathToFileURL(candidatePath).href
    process.env.GM_MCP_NO_SELF_UPDATE = '0'
    delete process.env.GM_MCP_SELF_UPDATE
    delete process.env.GM_MCP_SELF_UPDATE_DEPLOYED_ONLY
    return {
        root,
        deployedPath,
        candidatePath,
        candidateText: readFileSync(candidatePath, 'utf8'),
        deployedText: readFileSync(deployedPath, 'utf8'),
        restore() {
            for (const name of SAVED_ENV) {
                if (saved[name] === undefined) delete process.env[name]
                else process.env[name] = saved[name]
            }
            rmSync(root, { recursive: true, force: true })
        },
    }
}

await test('the candidate versions used here really are newer and older than the running build', () => {
    assert.equal(compareVersions(newerThanRunning, BUNDLE_VERSION), 1)
    assert.equal(compareVersions(olderThanRunning, BUNDLE_VERSION), -1)
})

await test('a process that is not the deployed copy still refreshes it from the release channel', async () => {
    const s = scenario()
    try {
        const result = await refreshStaleDeployedBundle(s.deployedPath)
        assert.equal(result.outcome, 'refreshed')
        assert.equal(result.self, false)
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.candidateText)
        assert.ok(existsSync(`${s.deployedPath}.prev`))
    } finally {
        s.restore()
    }
})

await test('a foreign refresh never hands this process over to the bundle it installed', async () => {
    const s = scenario()
    let handovers = 0
    try {
        await refreshStaleDeployedBundleInBackground(() => { handovers += 1 })
        assert.equal(handovers, 0)
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.candidateText)
    } finally {
        s.restore()
    }
})

await test('a deployed copy pinned as a local build is still refused', async () => {
    const s = scenario()
    try {
        const pin = {
            sha256: createHash('sha256').update(readFileSync(s.deployedPath)).digest('hex'),
            path: path.resolve(s.deployedPath),
            version: olderThanRunning,
            ts: new Date().toISOString(),
        }
        writeFileSync(localBuildPinPath(), `${JSON.stringify(pin, null, 2)}\n`, 'utf8')
        const result = await refreshStaleDeployedBundle(s.deployedPath)
        assert.equal(result.outcome, 'refused')
        assert.equal(result.code, 'local-build-pinned')
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText)
    } finally {
        s.restore()
    }
})

await test('a frozen channel is still refused', async () => {
    const s = scenario()
    try {
        process.env.GM_MCP_NO_SELF_UPDATE = '1'
        const result = await refreshStaleDeployedBundle(s.deployedPath)
        assert.equal(result.outcome, 'refused')
        assert.equal(result.code, 'frozen')
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText)
    } finally {
        s.restore()
    }
})

await test('a candidate older than the running build is still refused', async () => {
    const s = scenario({ candidateVersion: olderThanRunning, deployedVersion: '0.0.1' })
    try {
        const result = await refreshStaleDeployedBundle(s.deployedPath)
        assert.equal(result.outcome, 'refused')
        assert.equal(result.code, 'no-downgrade')
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText)
    } finally {
        s.restore()
    }
})

await test('GM_MCP_SELF_UPDATE_DEPLOYED_ONLY restores the deployed-copy-only channel', async () => {
    const s = scenario()
    try {
        process.env.GM_MCP_SELF_UPDATE_DEPLOYED_ONLY = '1'
        const result = await refreshStaleDeployedBundle(s.deployedPath)
        assert.equal(result.outcome, 'not-deployed-copy')
        assert.equal(result.self, false)
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText)
    } finally {
        s.restore()
    }
})

await test('a missing deployed copy is reported and never created behind the operator', async () => {
    const s = scenario()
    try {
        rmSync(s.deployedPath, { force: true })
        const result = await refreshStaleDeployedBundle(s.deployedPath)
        assert.equal(result.outcome, 'no-deployed-copy')
        assert.equal(result.self, false)
        assert.equal(existsSync(s.deployedPath), false)
    } finally {
        s.restore()
    }
})

// A retry timer is unref'd, so it must never hold a process open -- which means a pending retry
// promise cannot hold this test open either. A ref'd keepalive stands in for the server's socket.
async function withEventLoopAlive(promise) {
    const keepAlive = setInterval(() => {}, 5)
    try {
        return await promise
    } finally {
        clearInterval(keepAlive)
    }
}

async function drainDeferRetries(limit = 25) {
    let rounds = 0
    while (pendingDeferRetry() !== null && rounds < limit) {
        await withEventLoopAlive(pendingDeferRetry())
        rounds += 1
    }
    return rounds
}

await test('a deferral arms a retry instead of falling silent until the next interval tick', async () => {
    const s = scenario()
    try {
        const before = deferRetryState()
        await refreshStaleDeployedBundleInBackground(null, { countInflightDispatches: () => 1, deferRetryDelayMs: 1 })
        assert.equal(deferRetryState().scheduled - before.scheduled, 1, 'the deferral armed no retry')
        assert.notEqual(pendingDeferRetry(), null, 'the armed retry is not awaitable')
        await withEventLoopAlive(pendingDeferRetry())
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText, 'the retry swapped the bundle with a dispatch still inflight')
        await drainDeferRetries()
    } finally {
        s.restore()
    }
})

await test('a deferral never swaps while a dispatch is inflight, and the retry is bounded', async () => {
    const s = scenario()
    try {
        const before = deferRetryState()
        await refreshStaleDeployedBundleInBackground(null, { countInflightDispatches: () => 1, deferRetryDelayMs: 1 })
        const rounds = await drainDeferRetries()
        const after = deferRetryState()
        assert.equal(after.scheduled - before.scheduled, after.max_retries_per_trigger, `the chain armed ${after.scheduled - before.scheduled} retries, not the bounded ${after.max_retries_per_trigger}`)
        assert.equal(rounds, after.max_retries_per_trigger)
        assert.equal(after.exhausted - before.exhausted, 1, 'the exhausted chain did not fall back to the interval')
        assert.equal(after.pending, false, 'the chain is still armed')
        assert.equal(after.retries_left, after.max_retries_per_trigger, 'the next trigger did not get a fresh budget')
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText, 'a dispatch was inflight and the bundle still moved')
    } finally {
        s.restore()
    }
})

await test('the retry is what finishes the refresh once the dispatch drains', async () => {
    const s = scenario()
    let inflight = 1
    try {
        await refreshStaleDeployedBundleInBackground(null, { countInflightDispatches: () => inflight, deferRetryDelayMs: 1 })
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText)
        inflight = 0
        await withEventLoopAlive(pendingDeferRetry())
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.candidateText, 'the retry did not complete the refresh')
    } finally {
        s.restore()
    }
})

await test('a check that never deferred arms no retry and refreshes exactly as before', async () => {
    const s = scenario()
    try {
        const before = deferRetryState().scheduled
        await refreshStaleDeployedBundleInBackground(null, { countInflightDispatches: () => 0 })
        assert.equal(deferRetryState().scheduled - before, 0, 'an undeferred check armed a retry anyway')
        assert.equal(pendingDeferRetry(), null)
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.candidateText)
        const second = await refreshStaleDeployedBundle(s.deployedPath, { countInflightDispatches: () => 0 })
        assert.equal(second.outcome, 'checked-recently', 'the stamp no longer gates the check')
    } finally {
        s.restore()
    }
})

await test('the retry delay honours GM_MCP_SELF_UPDATE_INTERVAL_MS', async () => {
    const s = scenario()
    try {
        process.env.GM_MCP_SELF_UPDATE_INTERVAL_MS = '4000'
        assert.equal(deferRetryState().delay_ms, 4000, 'the retry would fetch faster than the interval the operator asked for')
        delete process.env.GM_MCP_SELF_UPDATE_INTERVAL_MS
        const fallback = deferRetryState().delay_ms
        assert.ok(fallback > 4000 && fallback <= 60_000, `the default retry delay is not seconds-scale: ${fallback}`)
    } finally {
        s.restore()
    }
})

await test('an operator interval shorter than the default retry delay drives the whole chain', async () => {
    const s = scenario()
    try {
        process.env.GM_MCP_SELF_UPDATE_INTERVAL_MS = '2'
        const before = deferRetryState()
        await refreshStaleDeployedBundleInBackground(null, { countInflightDispatches: () => 1 })
        await drainDeferRetries()
        const after = deferRetryState()
        assert.equal(after.scheduled - before.scheduled, after.max_retries_per_trigger)
        assert.equal(after.pending, false)
        assert.equal(readFileSync(s.deployedPath, 'utf8'), s.deployedText)
    } finally {
        s.restore()
    }
})

await test('no test in this file wrote to the deployed bundle of this machine', () => {
    assert.equal(existsSync(`${REAL_DEPLOYED_PATH}.candidate.${process.pid}.mjs`), false, 'this run left a candidate bundle beside the real one')
    assert.equal(existsSync(`${REAL_DEPLOYED_PATH}.prev.candidate.${process.pid}.mjs`), false)
    if (!existsSync(REAL_DEPLOYED_PATH)) return
    const real = readFileSync(REAL_DEPLOYED_PATH, 'utf8')
    assert.ok(real.startsWith('#!/usr/bin/env node'), 'the real deployed bundle is no longer a node bundle')
    assert.ok(/BUNDLE_VERSION\s*=\s*["'][^"']+["']/.test(real), 'the real deployed bundle carries no version any more')
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
