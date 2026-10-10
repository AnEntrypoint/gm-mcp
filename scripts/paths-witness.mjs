import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENV_NAMES = ['GM_TOOLS_DIR', 'AGENTPLUG_HOME']

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const sourceModule = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'paths.js')
const modulePath = path.resolve(flags.module ?? sourceModule)
const scratchParent = path.resolve(flags.scratch ?? os.tmpdir())

const results = []
const expect = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    results.push(ok)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const withEnv = (vars, read) => {
    const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]))
    for (const name of ENV_NAMES) {
        if (name in vars) process.env[name] = vars[name]
        else delete process.env[name]
    }
    try {
        return read()
    } finally {
        for (const name of ENV_NAMES) {
            if (saved[name] === undefined) delete process.env[name]
            else process.env[name] = saved[name]
        }
    }
}

let scratch
try {
    scratch = fs.mkdtempSync(path.join(scratchParent, 'paths-witness-'))
    const home = path.join(scratch, 'home')
    const absTools = path.join(scratch, 'tools')
    const absAgentplug = path.join(scratch, 'agentplug')
    const absProject = path.join(scratch, 'project')
    const defaultTools = path.join(home, '.gm-tools')
    const defaultAgentplug = path.join(home, '.agentplug')
    fs.mkdirSync(home)
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.GM_TOOLS_DIR
    delete process.env.AGENTPLUG_HOME

    expect('os.homedir() is the fixture home, so the real home is never read', os.homedir(), home)

    const paths = await import(pathToFileURL(modulePath).href)
    const { toolsDir, agentplugDir, spoolDirOf } = paths
    expect('module exports toolsDir, agentplugDir and spoolDirOf as functions',
        [typeof toolsDir, typeof agentplugDir, typeof spoolDirOf], ['function', 'function', 'function'])

    expect('toolsDir defaults to <home>/.gm-tools when GM_TOOLS_DIR is unset',
        withEnv({}, () => toolsDir()), defaultTools)
    expect('agentplugDir defaults to <home>/.agentplug when AGENTPLUG_HOME is unset',
        withEnv({}, () => agentplugDir()), defaultAgentplug)
    expect('toolsDir treats an empty GM_TOOLS_DIR as unset',
        withEnv({ GM_TOOLS_DIR: '' }, () => toolsDir()), defaultTools)
    expect('toolsDir treats a whitespace-only GM_TOOLS_DIR as unset',
        withEnv({ GM_TOOLS_DIR: ' \t ' }, () => toolsDir()), defaultTools)
    expect('agentplugDir treats a whitespace-only AGENTPLUG_HOME as unset',
        withEnv({ AGENTPLUG_HOME: ' \t ' }, () => agentplugDir()), defaultAgentplug)
    expect('toolsDir trims surrounding whitespace from GM_TOOLS_DIR',
        withEnv({ GM_TOOLS_DIR: `  ${absTools}  ` }, () => toolsDir()), absTools)
    expect('agentplugDir trims surrounding whitespace from AGENTPLUG_HOME',
        withEnv({ AGENTPLUG_HOME: ` ${absAgentplug}\n` }, () => agentplugDir()), absAgentplug)
    expect('toolsDir resolves a relative GM_TOOLS_DIR against the working directory',
        withEnv({ GM_TOOLS_DIR: 'relative-tools' }, () => toolsDir()), path.resolve('relative-tools'))
    expect('toolsDir result is absolute for a relative GM_TOOLS_DIR',
        withEnv({ GM_TOOLS_DIR: 'relative-tools' }, () => path.isAbsolute(toolsDir())), true)
    expect('agentplugDir resolves a relative AGENTPLUG_HOME against the working directory',
        withEnv({ AGENTPLUG_HOME: 'relative-agentplug' }, () => agentplugDir()), path.resolve('relative-agentplug'))
    expect('toolsDir ignores AGENTPLUG_HOME',
        withEnv({ AGENTPLUG_HOME: absAgentplug }, () => toolsDir()), defaultTools)
    expect('agentplugDir ignores GM_TOOLS_DIR',
        withEnv({ GM_TOOLS_DIR: absTools }, () => agentplugDir()), defaultAgentplug)
    expect('spoolDirOf joins .gm/exec-spool under an absolute root',
        spoolDirOf(absProject), path.join(absProject, '.gm', 'exec-spool'))
    expect('spoolDirOf normalises a trailing separator on the root',
        spoolDirOf(absProject + path.sep), path.join(absProject, '.gm', 'exec-spool'))
    expect('spoolDirOf keeps a relative root relative (join, not resolve)',
        spoolDirOf('relative-project'), path.join('relative-project', '.gm', 'exec-spool'))
    expect('spoolDirOf output for a relative root is not absolute',
        path.isAbsolute(spoolDirOf('relative-project')), false)
    expect('the module creates no directories',
        [absTools, absAgentplug, absProject, defaultTools, defaultAgentplug].filter(p => fs.existsSync(p)), [])
} catch (error) {
    results.push(false)
    console.log(`FAIL witness ran to completion -- ${String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')}`)
} finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
}
const exitCode = results.length > 0 && results.every(Boolean) ? 0 : 1
console.log(`checks ${results.filter(Boolean).length}/${results.length}`)
console.log(exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = exitCode
