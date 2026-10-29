import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UNEXPANDED = /\$HOME|\$\{HOME\}|%USERPROFILE%|%HOME%|^~[\\/]|[\\/]~[\\/]/

export function claudeConfigPath(env = process.env, home = os.homedir()) {
    return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json')
}

function brokenEntry(entry) {
    return Boolean(entry) && Array.isArray(entry.args) && entry.args.some((arg) => typeof arg === 'string' && UNEXPANDED.test(arg))
}

function sameEntry(entry, wanted) {
    return Boolean(entry) && entry.command === wanted.command && JSON.stringify(entry.args) === JSON.stringify(wanted.args)
}

function readConfig(file) {
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8'))
}

function writeConfigAtomic(file, value) {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
    renameSync(tmp, file)
}

// Points Claude Code's user-scope `gm` entry at this bundle by absolute path. The path is resolved in
// Node, so no shell has to expand $HOME or ~ (a literal "$HOME" in the config is what broke installs on
// Windows). Project-scope `gm` entries are rewritten only when they carry an unexpanded token.
export function registerClaudeCode({ bundlePath, env = process.env, home = os.homedir() }) {
    const bundle = path.resolve(bundlePath)
    if (!existsSync(bundle)) throw new Error(`bundle not found at ${bundle}`)
    const file = claudeConfigPath(env, home)
    const config = readConfig(file)
    const wanted = { type: 'stdio', command: 'node', args: [bundle], env: {} }
    const changed = []
    config.mcpServers ||= {}
    if (!sameEntry(config.mcpServers.gm, wanted) || brokenEntry(config.mcpServers.gm)) {
        config.mcpServers.gm = wanted
        changed.push('user')
    }
    for (const [name, project] of Object.entries(config.projects || {})) {
        if (brokenEntry(project?.mcpServers?.gm)) {
            project.mcpServers.gm = wanted
            changed.push(`project ${name}`)
        }
    }
    if (changed.length > 0) writeConfigAtomic(file, config)
    const verified = readConfig(file).mcpServers?.gm
    return { file, bundle, changed, ok: sameEntry(verified, wanted) }
}
