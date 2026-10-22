// Windows reap witness: runs the real reapReport pass (src/leak-reaper.js) over three real gm-mcp stdio servers and counts
// every powershell.exe spawn made during that pass. The execFile observer is installed only around the pass and the
// original descriptor is restored in finally, then checked.
// Usage: node scripts/witness-reap-spawns.mjs [--enforce]
// Prints one JSON line. Exit 1 when fewer than 3 of the started servers are seen as unattributed candidates, or, with
// --enforce, when the pass spawns powershell.exe more than once. Other platforms print skipped and exit 0.
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import util from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUILT_BUNDLE = path.join(repoRoot, 'bin', 'gm-mcp-server.js')
const CANDIDATES = 3
const enforce = process.argv.includes('--enforce')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (process.platform !== 'win32') {
    console.log(JSON.stringify({ skipped: true, platform: process.platform, reason: 'the powershell spawn path is win32-only' }))
    process.exit(0)
}

const originalDescriptor = Object.getOwnPropertyDescriptor(cp, 'execFile')
if (!originalDescriptor || originalDescriptor.writable !== true || originalDescriptor.configurable !== true) {
    console.error('witness: child_process.execFile is not a writable, configurable own property; refusing to observe it')
    process.exit(1)
}
const originalExecFile = cp.execFile
let powershellSpawns = 0
function observedExecFile(file, args, options, callback) {
    if (String(file).toLowerCase() === 'powershell.exe') powershellSpawns += 1
    return originalExecFile.apply(cp, arguments)
}
observedExecFile[util.promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
    observedExecFile(file, args, options, (error, stdout, stderr) => {
        if (error) {
            error.stdout = stdout
            error.stderr = stderr
            reject(error)
            return
        }
        resolve({ stdout, stderr })
    })
})

const children = []
let exitCode = 1
let report = null
let elapsedMs = null
try {
    for (let index = 0; index < CANDIDATES; index += 1) {
        children.push(cp.spawn(process.execPath, [BUILT_BUNDLE], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }))
    }
    await sleep(8000)
    const ourPids = new Set(children.map((child) => child.pid))

    Object.defineProperty(cp, 'execFile', { ...originalDescriptor, value: observedExecFile })
    syncBuiltinESMExports()
    let reapReport
    try {
        ({ reapReport } = await import(pathToFileURL(path.join(repoRoot, 'src', 'leak-reaper.js')).href))
        const started = Date.now()
        report = await reapReport({ apply: false })
        elapsedMs = Date.now() - started
    } finally {
        Object.defineProperty(cp, 'execFile', originalDescriptor)
        syncBuiltinESMExports()
    }
    if (cp.execFile !== originalExecFile) throw new Error('execFile was not restored to its original value')

    const seen = report.findings.filter((finding) => finding.source === 'unattributed-server' && ourPids.has(finding.pid))
    const verdicts = {}
    for (const finding of seen) verdicts[finding.verdict] = (verdicts[finding.verdict] ?? 0) + 1
    const withinBudget = powershellSpawns <= 1
    const ok = seen.length >= CANDIDATES && (!enforce || withinBudget)
    console.log(JSON.stringify({
        platform: process.platform,
        candidates_started: CANDIDATES,
        candidates_seen: seen.length,
        candidate_verdicts: verdicts,
        powershell_spawns: powershellSpawns,
        reply_table_spawns: report.windows_table_spawns ?? null,
        elapsed_ms: elapsedMs,
        enforce,
        ok,
    }))
    exitCode = ok ? 0 : 1
} catch (error) {
    console.error(`witness: ${error?.stack ?? error}`)
    exitCode = 1
} finally {
    for (const child of children) {
        try {
            child.kill()
        } catch {
        }
    }
    await sleep(500)
    process.exit(exitCode)
}
