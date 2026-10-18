#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'guest-bodies.js')
const SOURCES = [
    'crates/plugkit-core/src/wasm_dispatch/verbs/git.rs',
    'crates/plugkit-core/src/wasm_dispatch/verbs/search.rs',
    'crates/plugkit-core/src/wasm_dispatch/verbs.rs',
]
const ENVELOPE_CONST = 'GIT_BODY_ENVELOPE_FIELDS'

const repo = resolve(process.argv[2] ?? join(HERE, '..', '..', 'rs-plugkit'))
const ref = process.argv[3] ?? 'origin/main'

function git(...args) {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function sourceAt(path) {
    try {
        return git('show', `${ref}:${path}`)
    } catch {
        return ''
    }
}

function stringList(text) {
    return [...text.matchAll(/"([^"\\]*)"/g)].map((match) => match[1])
}

function constLists(text) {
    const lists = new Map()
    for (const match of text.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/g)) {
        lists.set(match[1], stringList(match[2]))
    }
    return lists
}

const sha = git('rev-parse', ref).trim()
const texts = SOURCES.map(sourceAt)
const consts = new Map(texts.flatMap((text) => [...constLists(text)]))
const envelope = consts.get(ENVELOPE_CONST)
if (!envelope) throw new Error(`${ENVELOPE_CONST} not found at ${ref}`)

const verbs = {}
const unresolved = []
for (const text of texts) {
    for (const match of text.matchAll(/refuse_unknown_fields\(\s*("([^"]+)"|[A-Z_]+)\s*,\s*body\s*,\s*(&\[[^\]]*\]|[A-Z][A-Z0-9_]*)\s*,?\s*\)/g)) {
        const verb = match[2]
        const expr = match[3]
        const fields = expr.startsWith('&[') ? stringList(expr) : consts.get(expr)
        if (!verb || !fields) {
            unresolved.push(match[0].replace(/\s+/g, ' '))
            continue
        }
        verbs[verb] = [...new Set([...(verbs[verb] ?? []), ...fields])]
    }
}

const body = `export const GUEST_BODY_SOURCE = ${JSON.stringify({ repo: 'AnEntrypoint/rs-plugkit', sha })}

export const GUEST_ENVELOPE_FIELDS = ${JSON.stringify(envelope)}

export const GUEST_ACCEPTED_FIELDS = ${JSON.stringify(verbs, null, 4)}
`
writeFileSync(OUT, body)
console.log(`wrote ${OUT} from rs-plugkit ${sha}: ${Object.keys(verbs).length} verbs`)
for (const line of unresolved) console.log(`unresolved (kept on the hand table): ${line}`)
