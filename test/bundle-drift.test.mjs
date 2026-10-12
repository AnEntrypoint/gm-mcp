import assert from 'node:assert/strict'
// The staleness this pins is a mismatch between two version numbers, so the assertions run on the
// pure reporters with a state object: nothing here touches the file this test launched from.
import { bundleDrift, bundleDriftIntervalMs, bundleHealthBlock, bundleStalenessLine, reloadDisabled } from '../src/bundle-drift.js'

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

const state = (over = {}) => ({
    path: 'C:/tools/gm-mcp-server.mjs',
    running_version: '0.2.31',
    running_sha256: 'a'.repeat(24),
    installed_version: '0.2.32',
    installed_sha256: 'c'.repeat(24),
    stale: true,
    reloadable: true,
    refusal_code: null,
    refusal_reason: null,
    ...over,
})

await test('a bundle that matches the installed one is never reported', () => {
    assert.equal(bundleStalenessLine(state({ stale: false, reloadable: false })), null)
    assert.equal(bundleStalenessLine(null), null)
})

await test('a stale reloadable bundle is named on both sides with the action taken', () => {
    const line = bundleStalenessLine(state())
    assert.match(line, /serving bundle 0\.2\.31 \(sha aaaaaaaaaaaa\)/)
    assert.match(line, /0\.2\.32 \(sha c{12}\) is installed/)
    assert.match(line, /reloading between dispatches now/)
})

await test('a stale bundle that cannot be reloaded says why instead of promising a reload', () => {
    const line = bundleStalenessLine(state({
        reloadable: false,
        refusal_code: 'transport-stdio',
        refusal_reason: 'a stdio server cannot replace itself without detaching its client',
    }))
    assert.match(line, /not reloading -- a stdio server cannot replace itself/)
    assert.doesNotMatch(line, /reloading between dispatches/)
})

await test('the health block reports short hashes and keeps the refusal code', () => {
    const block = bundleHealthBlock(state({ refusal_code: 'no-downgrade' }))
    assert.equal(block.running_sha256.length, 12)
    assert.equal(block.installed_sha256.length, 12)
    assert.equal(block.stale, true)
    assert.equal(block.reloadable, true)
    assert.equal(block.refusal, 'no-downgrade')
})

await test('an unknown installed version still names the mismatch', () => {
    const line = bundleStalenessLine(state({ installed_version: null, installed_sha256: null, reloadable: false, refusal_reason: 'x' }))
    assert.match(line, /unknown version \(sha null\)/)
})

await test('a dev checkout is never reloadable, whatever the installed file is', () => {
    // This test runs from src/, so the file it launched from is not a bundle: drift detection must
    // report that and refuse, rather than replacing a node process on every edit.
    const drift = bundleDrift({ transport: 'http' })
    assert.equal(drift.stale, false)
    assert.equal(drift.reloadable, false)
})

await test('the watch interval and the reload switch read their env as numbers and off-values', () => {
    const savedInterval = process.env.GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS
    const savedReload = process.env.GM_MCP_BUNDLE_DRIFT_RELOAD
    try {
        process.env.GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS = '3'
        assert.equal(bundleDriftIntervalMs(), 3000)
        process.env.GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS = 'not-a-number'
        assert.equal(bundleDriftIntervalMs(), 30_000)
        delete process.env.GM_MCP_BUNDLE_DRIFT_RELOAD
        assert.equal(reloadDisabled(), false)
        process.env.GM_MCP_BUNDLE_DRIFT_RELOAD = '0'
        assert.equal(reloadDisabled(), false)
        process.env.GM_MCP_BUNDLE_DRIFT_RELOAD = '1'
        assert.equal(reloadDisabled(), true)
    } finally {
        if (savedInterval === undefined) delete process.env.GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS
        else process.env.GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS = savedInterval
        if (savedReload === undefined) delete process.env.GM_MCP_BUNDLE_DRIFT_RELOAD
        else process.env.GM_MCP_BUNDLE_DRIFT_RELOAD = savedReload
    }
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
