import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true']
}))
const sourceVerbs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'verbs.js')
const verbsFile = path.resolve(flags.module ?? sourceVerbs)

const REQUIRED_VERBS = [
    'instruction', 'phase-status', 'transition', 'prd-add', 'prd-list', 'prd-resolve',
    'codesearch', 'codeinsight', 'codeinsight_index', 'exec_js', 'fs_read', 'fs_readdir',
    'git_status', 'git_log', 'git_diff', 'git_show', 'git_push', 'git_finalize',
    'task-spawn', 'task-list', 'recall', 'memorize', 'wait', 'health', 'status',
]
const TOOL_NAME_CASES = [
    ['prd-add', 'prd_add'],
    ['task-output', 'task_output'],
    ['dream-replay-cycle', 'dream_replay_cycle'],
    ['a-b-c', 'a_b_c'],
    ['git_status', 'git_status'],
    ['codeinsight_index', 'codeinsight_index'],
]
const VERB_NAME = /^[a-z][a-z0-9_-]*$/
const TOOL_NAME = /^[a-z][a-z0-9_]*$/

const outcomes = []
const expect = (name, ok, detail = '') => {
    outcomes.push(ok === true)
    console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}

let exitCode = 1
try {
    const mod = await import(pathToFileURL(verbsFile).href)
    const registry = mod.RUNNER_REGISTRY_VERBS
    const verbToolName = mod.verbToolName
    const isArray = Array.isArray(registry)
    const list = isArray ? registry : []
    const toolName = verb => (typeof verbToolName === 'function' ? verbToolName(verb) : undefined)

    expect('RUNNER_REGISTRY_VERBS is a non-empty array', isArray && list.length > 0, `length=${list.length}`)

    const badVerbs = list.filter(verb => typeof verb !== 'string' || !VERB_NAME.test(verb))
    expect('every registry entry is a lowercase verb name', badVerbs.length === 0, `offenders=${JSON.stringify(badVerbs)}`)

    const duplicates = [...new Set(list.filter((verb, index) => list.indexOf(verb) !== index))]
    expect('no registry entry is duplicated', duplicates.length === 0, `duplicates=${JSON.stringify(duplicates)}`)

    const missing = REQUIRED_VERBS.filter(verb => !list.includes(verb))
    expect('registry names every required verb', missing.length === 0, `required=${REQUIRED_VERBS.length} missing=${JSON.stringify(missing)}`)

    expect('verbToolName is a function', typeof verbToolName === 'function', `type=${typeof verbToolName}`)

    for (const [verb, want] of TOOL_NAME_CASES) {
        const got = toolName(verb)
        expect(`verbToolName(${verb}) is ${want}`, got === want, `got=${JSON.stringify(got)}`)
    }

    const badToolNames = list
        .filter(verb => {
            const name = toolName(verb)
            return typeof name !== 'string' || !TOOL_NAME.test(name)
        })
        .map(verb => `${verb}->${JSON.stringify(toolName(verb))}`)
    expect('every registry entry maps to a valid tool identifier', badToolNames.length === 0, `offenders=${JSON.stringify(badToolNames)}`)

    const toolNames = list.map(toolName)
    const collisions = [...new Set(toolNames.filter((name, index) => toolNames.indexOf(name) !== index))]
    expect('every registry entry maps to a distinct tool name', collisions.length === 0, `collisions=${JSON.stringify(collisions)}`)

    exitCode = outcomes.every(Boolean) ? 0 : 1
} catch (error) {
    expect('verbs module imports and runs to completion', false, String(error?.stack || error).split('\n').slice(0, 3).join(' | '))
}
console.log(`expects ${outcomes.filter(Boolean).length}/${outcomes.length}`)
console.log(exitCode === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = exitCode
