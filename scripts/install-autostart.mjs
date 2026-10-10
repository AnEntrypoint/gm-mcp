#!/usr/bin/env node
// Installs (or refreshes) the boot-time start and the periodic guard of the
// shared gm-mcp HTTP server, then makes sure one is listening right now.
//
// Idempotent: every artifact it writes sits inside a marker block, and the
// block is replaced wholesale on each run. Nothing here starts a second server
// when one is already up -- "node <entry> ensure-http" probes /health first and
// the probe is the authority.
//
// The hook and the crontab live outside this repo ($HOME/beforestart and
// $HOME/crontab), which is why they are written by this installer rather than
// edited by hand: run it again to reproduce them.
//
// usage:
//   node scripts/install-autostart.mjs [--entry <bundle>] [--hook <file>]
//        [--cron-file <file>] [--log <file>] [--no-hook] [--no-cron] [--check] [--uninstall]

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = 'gm-mcp http singleton autostart'
const BEGIN = `# >>> ${MARKER} (managed by gm-mcp/scripts/install-autostart.mjs; edits here are replaced on the next install) >>>`
const END = `# <<< ${MARKER} <<<`

function flagValue(name) {
    const args = process.argv.slice(2)
    const index = args.indexOf(`--${name}`)
    if (index === -1) return undefined
    const next = args[index + 1]
    return next && !next.startsWith('--') ? next : undefined
}

const hasFlag = (name) => process.argv.slice(2).includes(`--${name}`)

const home = process.env.HOME || homedir()
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoBundle = path.join(path.dirname(scriptDir), 'bin', 'gm-mcp-server.js')

function resolveEntry() {
    const explicit = flagValue('entry')
    if (explicit) {
        if (!existsSync(explicit)) throw new Error(`--entry ${explicit} does not exist`)
        return path.resolve(explicit)
    }
    const deployed = path.join(home, '.gm-tools', 'gm-mcp-server.mjs')
    if (existsSync(deployed)) return deployed
    if (existsSync(repoBundle)) return repoBundle
    throw new Error(`no gm-mcp bundle found: neither ${deployed} nor ${repoBundle} exists`)
}

const entry = resolveEntry()
const nodeBin = process.execPath
const logFile = path.resolve(flagValue('log') || path.join(home, 'logs', 'gm-mcp-autostart.log'))
const hookFile = path.resolve(flagValue('hook') || path.join(home, 'beforestart'))
const cronFile = path.resolve(flagValue('cron-file') || path.join(home, 'crontab'))

function replaceManagedBlock(text, block) {
    const begin = text.indexOf(BEGIN)
    const end = begin === -1 ? -1 : text.indexOf(END, begin)
    const kept = begin === -1 || end === -1
        ? text.replace(/\s+$/, '')
        : `${text.slice(0, begin).replace(/\s+$/, '')}\n${text.slice(end + END.length).replace(/\s+$/, '')}`
    const trimmed = kept.replace(/\s+$/, '')
    return trimmed === '' ? `${block}\n` : `${trimmed}\n\n${block}\n`
}

function hookBlock() {
    return [
        BEGIN,
        `# The gm MCP server the agent host is configured against (http://127.0.0.1:8787/mcp).`,
        `# ensure-http probes /health and exits when one is already listening.`,
        `if [ -z "\${GM_MCP_NO_HTTP_SINGLETON:-}" ]; then`,
        `  ( nohup '${nodeBin}' '${entry}' ensure-http >> '${logFile}' 2>&1 < /dev/null & ) > /dev/null 2>&1 || true`,
        `fi`,
        END,
    ].join('\n')
}

const jobManaged = (line) => line.includes('gm-mcp-server') && line.includes('ensure-http')

function cronBlock() {
    return [
        BEGIN,
        `@reboot '${nodeBin}' '${entry}' ensure-http >> '${logFile}' 2>&1`,
        // Minutely, not every five: a shell client (gmc.py) that POSTs straight
        // to the port has no dispatch to seed one, so a killed server is simply
        // gone until a guard runs. One probe of a healthy server is a fetch.
        `*/1 * * * * '${nodeBin}' '${entry}' ensure-http >> '${logFile}' 2>&1`,
        END,
    ].join('\n')
}

function installHook() {
    const existed = existsSync(hookFile)
    const original = existed ? readFileSync(hookFile, 'utf8') : '#!/bin/bash\n'
    const next = replaceManagedBlock(original, hookBlock())
    const changed = next !== original
    if (changed && !hasFlag('check')) {
        mkdirSync(path.dirname(hookFile), { recursive: true })
        writeFileSync(hookFile, next, 'utf8')
        spawnSync('chmod', ['+x', hookFile], { windowsHide: true })
    }
    const hadBlock = original.includes(BEGIN)
    return {
        file: hookFile,
        managed: hadBlock,
        changed,
        action: !existed ? 'created' : changed ? (hadBlock ? 'refreshed' : 'added') : 'unchanged',
    }
}

function installCron() {
    const original = existsSync(cronFile) ? readFileSync(cronFile, 'utf8') : ''
    const kept = original
        .split('\n')
        .filter((line) => !line.includes(MARKER) && !jobManaged(line))
        .join('\n')
    const next = replaceManagedBlock(kept, cronBlock())
    const changed = next !== original
    if (changed && !hasFlag('check')) {
        mkdirSync(path.dirname(cronFile), { recursive: true })
        writeFileSync(cronFile, next, 'utf8')
        const loaded = spawnSync('crontab', [cronFile], { encoding: 'utf8', windowsHide: true })
        if (loaded.status !== 0) spawnSync('sudo', ['crontab', '-u', process.env.USER || 'abc', cronFile], { encoding: 'utf8', windowsHide: true })
    }
    return { file: cronFile, managed: original.includes(MARKER), changed, action: changed ? (original.includes(MARKER) ? 'refreshed' : 'added') : 'unchanged' }
}

function uninstall() {
    const report = []
    for (const file of [hookFile, cronFile]) {
        if (!existsSync(file)) {
            report.push({ file, action: 'absent' })
            continue
        }
        const original = readFileSync(file, 'utf8')
        const kept = original
            .split('\n')
            .filter((line) => !line.includes(MARKER) && !jobManaged(line))
            .join('\n')
            .replace(/\s+$/, '')
        const begin = kept.indexOf(BEGIN)
        const next = begin === -1 ? kept : kept.slice(0, begin).replace(/\s+$/, '')
        if (next === original) {
            report.push({ file, action: 'unchanged' })
            continue
        }
        if (!hasFlag('check')) writeFileSync(file, `${next}\n`, 'utf8')
        report.push({ file, action: 'removed' })
    }
    return report
}

function ensureNow() {
    mkdirSync(path.dirname(logFile), { recursive: true })
    if (hasFlag('check')) return { ran: false }
    const started = spawnSync(nodeBin, [entry, 'ensure-http'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    return { ran: true, status: started.status, stdout: (started.stdout || '').trim(), stderr: (started.stderr || '').trim() }
}

async function health() {
    const port = Number((process.env.GM_MCP_HTTP_PORT || '').trim()) || 8787
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) })
        return { port, ok: response.ok, body: await response.text() }
    } catch (error) {
        return { port, ok: false, body: `no answer: ${error.message}` }
    }
}

const report = {
    entry,
    node: nodeBin,
    log: logFile,
    entry_mtime: existsSync(entry) ? statSync(entry).mtime.toISOString() : null,
}

if (hasFlag('uninstall')) {
    report.uninstall = uninstall()
} else {
    if (!hasFlag('no-hook')) report.hook = installHook()
    if (!hasFlag('no-cron')) report.cron = installCron()
    report.ensure_http = ensureNow()
}

report.health = await health()
console.log(JSON.stringify(report, null, 2))
process.exit(report.health.ok ? 0 : 1)
