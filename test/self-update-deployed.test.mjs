import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLE_VERSION } from '../src/bundle-version.js'
import { compareVersions, localBuildPinPath, refreshStaleDeployedBundle, refreshStaleDeployedBundleInBackground } from '../src/self-update.js'

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

const SAVED_ENV = ['AGENTPLUG_HOME', 'GM_TOOLS_DIR', 'GM_MCP_BUNDLE_URL', 'GM_MCP_NO_SELF_UPDATE', 'GM_MCP_SELF_UPDATE', 'GM_MCP_SELF_UPDATE_DEPLOYED_ONLY']

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

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
