#!/usr/bin/env node
// Embeds the gm skills (every file under skills/ in the parent repo, main branch) into
// src/skills-snapshot.js. Fetches skills/manifest.sha256, then each file it lists, and checks each
// file's sha256 against its manifest line. A fetch failure, a sha256 mismatch, an unsafe path or
// invalid UTF-8 refuses the whole run: exit 1, and the snapshot file is left untouched.
// Files over MAX_BYTES are skipped and reported. Files directly under skills/ (not inside a skill
// directory, e.g. skill-assets.txt) are verified but not embedded.
// Also fetches gm-config fsm/graph.json and embeds FSM_SUCCESSORS (state key -> next state keys, every edge kind), which
// skill-gate.js uses for the one-step-ahead rule of exposed_when.
import { createHash } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RAW_BASE = 'https://raw.githubusercontent.com/AnEntrypoint/gm/main/skills/'
const MANIFEST_URL = `${RAW_BASE}manifest.sha256`
const GRAPH_URL = 'https://raw.githubusercontent.com/AnEntrypoint/gm-config/main/fsm/graph.json'
const MAX_BYTES = 512 * 1024
const CONCURRENCY = 8
const FETCH_TIMEOUT_MS = 30_000
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const OUT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'skills-snapshot.js')
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

class Refusal extends Error {}

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

// JSON.stringify output with every non-ASCII UTF-16 code unit written as a \uXXXX escape: the same
// string value on evaluation, and an ASCII source file.
const asciiJson = (value) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

function parseManifest(text) {
    const entries = []
    const seen = new Set()
    for (const [index, raw] of text.split('\n').entries()) {
        const line = raw.replace(/\r$/, '')
        if (line === '') continue
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
        if (!match) throw new Refusal(`manifest line ${index + 1} is not "<sha256>  <path>"`)
        const file = match[2]
        if (!SAFE_PATH.test(file) || file.split('/').some((seg) => seg === '.' || seg === '..')) throw new Refusal(`manifest line ${index + 1} names an unsafe path: ${file}`)
        if (seen.has(file)) throw new Refusal(`manifest lists ${file} twice`)
        seen.add(file)
        entries.push({ sha256: match[1], file })
    }
    if (entries.length === 0) throw new Refusal('manifest lists no files')
    return entries
}

async function fetchBytes(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return Buffer.from(await response.arrayBuffer())
}

// Next-state keys per state from the graph's edges (forward and backreference alike), sorted and de-duplicated.
function successorsOf(graphText) {
    let graph
    try {
        graph = JSON.parse(graphText)
    } catch (error) {
        throw new Refusal(`fsm graph is not JSON: ${error.message}`)
    }
    if (!Array.isArray(graph.states) || !Array.isArray(graph.edges)) throw new Refusal('fsm graph has no states or edges array')
    const successors = {}
    for (const edge of graph.edges) {
        if (typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Refusal('fsm graph edge without string from/to')
        ;(successors[edge.from] ??= []).push(edge.to)
    }
    for (const key of Object.keys(successors)) successors[key] = [...new Set(successors[key])].sort()
    return successors
}

async function loadEntry(entry) {
    const bytes = await fetchBytes(RAW_BASE + entry.file)
    const digest = sha256Hex(bytes)
    if (digest !== entry.sha256) throw new Error(`sha256 mismatch: manifest ${entry.sha256}, fetched ${digest}`)
    return { ...entry, bytes }
}

// Runs fn over items with at most `limit` in flight; results keep item order.
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++
            results[index] = await fn(items[index])
        }
    })
    await Promise.all(workers)
    return results
}

async function main() {
    const manifestBytes = await fetchBytes(MANIFEST_URL)
    const manifestSha = sha256Hex(manifestBytes)
    const entries = parseManifest(decoder.decode(manifestBytes))

    const successors = successorsOf(decoder.decode(await fetchBytes(GRAPH_URL)))

    const failures = []
    const loaded = await mapLimit(entries, CONCURRENCY, async (entry) => {
        try {
            return await loadEntry(entry)
        } catch (error) {
            failures.push(`${entry.file}: ${error.message}`)
            return null
        }
    })
    if (failures.length > 0) throw new Refusal(`${failures.length} file(s) refused:\n  ${failures.join('\n  ')}`)

    const embedded = []
    const skipped = []
    const outside = []
    let totalBytes = 0
    for (const item of loaded) {
        const slash = item.file.indexOf('/')
        if (slash < 0) {
            outside.push(item.file)
            continue
        }
        if (item.bytes.length > MAX_BYTES) {
            skipped.push(`${item.file} (${item.bytes.length} bytes)`)
            continue
        }
        let text
        try {
            text = decoder.decode(item.bytes)
        } catch {
            throw new Refusal(`${item.file} is not valid UTF-8`)
        }
        totalBytes += item.bytes.length
        embedded.push({ name: item.file.slice(0, slash), file: item.file.slice(slash + 1), sha256: item.sha256, text })
    }
    if (embedded.length === 0) throw new Refusal('no skill files to embed')

    const source = [
        '// Generated by scripts/embed-skills.mjs from skills/ in https://github.com/AnEntrypoint/gm (main).',
        `// Manifest sha256: ${manifestSha}. Do not edit by hand; rerun scripts/embed-skills.mjs.`,
        'export const SKILLS = [',
        ...embedded.map((record) => `    ${asciiJson(record)},`),
        ']',
        `export const FSM_SUCCESSORS = ${asciiJson(successors)}`,
        '',
    ].join('\n')
    const tmp = `${OUT_PATH}.tmp-${process.pid}`
    writeFileSync(tmp, source, 'utf8')
    renameSync(tmp, OUT_PATH)

    const skillCount = new Set(embedded.map((record) => record.name)).size
    console.log(`embedded ${skillCount} skills, ${embedded.length} files, ${totalBytes} bytes of skill content`)
    console.log(`wrote ${path.relative(process.cwd(), OUT_PATH) || OUT_PATH} (${Buffer.byteLength(source, 'utf8')} bytes)`)
    if (skipped.length > 0) console.log(`skipped ${skipped.length} file(s) over ${MAX_BYTES} bytes:\n  ${skipped.join('\n  ')}`)
    if (outside.length > 0) console.log(`verified but not embedded (not inside a skill directory): ${outside.join(', ')}`)
}

main().catch((error) => {
    const label = error instanceof Refusal ? 'refused' : 'failed'
    console.error(`embed-skills: ${label}, nothing written: ${error.message}`)
    process.exitCode = 1
})
