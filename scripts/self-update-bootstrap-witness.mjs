import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = path.resolve(flags.module ?? path.join(repoRoot, 'src', 'self-update.js'))
const { BUNDLE_VERSION } = await import(pathToFileURL(path.join(path.dirname(modulePath), 'bundle-version.js')).href)
const { refreshStaleDeployedBundle, describeSelfUpdateOutcome, noSelfUpdateFilePath } = await import(pathToFileURL(modulePath).href)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-bootstrap-witness-'))
const toolsDir = path.join(scratch, 'tools')
const agentplugHome = path.join(scratch, 'agentplug')
const deployedPath = path.join(toolsDir, 'gm-mcp-server.mjs')
const candidatePath = path.join(scratch, 'release-bundle.mjs')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const bundleBytes = marker => Buffer.from(`#!/usr/bin/env node\nvar BUNDLE_VERSION = ${JSON.stringify(BUNDLE_VERSION)};\nconst marker = ${JSON.stringify(marker)};\n${'\n'.repeat(120000)}`, 'utf8')
const candidateBytes = bundleBytes('release')
const staleBytes = bundleBytes('stale')
const check = { countInflightDispatches: () => 0, force: true }
const results = []
const expect = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    results.push(ok)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

try {
    fs.mkdirSync(agentplugHome, { recursive: true })
    fs.writeFileSync(candidatePath, candidateBytes)
    process.env.GM_TOOLS_DIR = toolsDir
    process.env.AGENTPLUG_HOME = agentplugHome
    process.env.GM_MCP_BUNDLE_URL = pathToFileURL(candidatePath).href
    process.env.GM_MCP_LOG_PATH = path.join(scratch, 'gm-mcp-server.log')
    for (const name of ['GM_MCP_SELF_UPDATE', 'GM_MCP_NO_SELF_UPDATE', 'GM_MCP_SELF_UPDATE_DEPLOYED_ONLY']) delete process.env[name]

    expect('no deployed bundle exists before the check', fs.existsSync(deployedPath), false)
    const bootstrapped = await refreshStaleDeployedBundle(deployedPath, check)
    expect('a missing deployed bundle bootstraps', bootstrapped.outcome, 'bootstrapped')
    expect('bootstrap installs the release-channel bytes', fs.existsSync(deployedPath) && fs.readFileSync(deployedPath).equals(candidateBytes), true)
    expect('bootstrap names the deployed path', bootstrapped.deployed_bundle, deployedPath)
    expect('bootstrap reports the installed hash', bootstrapped.hash, sha256(candidateBytes))
    expect('bootstrap leaves no .prev file', fs.existsSync(`${deployedPath}.prev`), false)
    expect('bootstrap has a describable outcome', describeSelfUpdateOutcome(bootstrapped).includes('installed'), true)

    const current = await refreshStaleDeployedBundle(deployedPath, check)
    expect('an identical deployed bundle stays current', current.outcome, 'current')

    fs.writeFileSync(deployedPath, staleBytes)
    const refreshed = await refreshStaleDeployedBundle(deployedPath, check)
    expect('a stale deployed bundle is still refreshed', refreshed.outcome, 'refreshed')
    expect('the refresh keeps the previous bytes', fs.readFileSync(`${deployedPath}.prev`).equals(staleBytes), true)
    expect('the refresh installs the release-channel bytes', fs.readFileSync(deployedPath).equals(candidateBytes), true)

    fs.rmSync(deployedPath, { force: true })
    fs.writeFileSync(noSelfUpdateFilePath(), '')
    const frozen = await refreshStaleDeployedBundle(deployedPath, check)
    expect('a freeze still refuses a bootstrap', [frozen.outcome, frozen.code], ['refused', 'frozen'])
    expect('a refused bootstrap creates no file', fs.existsSync(deployedPath), false)
} catch (error) {
    results.push(false)
    console.log(`FAIL witness ran to completion -- ${String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')}`)
} finally {
    fs.rmSync(scratch, { recursive: true, force: true })
}
const exitCode = results.length > 0 && results.every(Boolean) ? 0 : 1
console.log(`checks ${results.filter(Boolean).length}/${results.length}`)
console.log(exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = exitCode
