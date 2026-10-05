#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { cleanResponse, compactWireResponse } from '../src/response-compact.js'

const files = process.argv.slice(2)
if (!files.length) {
    console.error('usage: node scripts/measure-wire-size.mjs <exec-spool out-file>...')
    process.exit(2)
}

function flatten(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed
    const { data, ...rest } = parsed
    if (!data || typeof data !== 'object' || Array.isArray(data)) return parsed
    const collides = Object.keys(data).some(k => k in rest)
    return collides ? parsed : { ...rest, ...data }
}

function render(out) {
    return yaml.dump(out, { lineWidth: 100 })
}

function bytes(s) {
    return Buffer.byteLength(s, 'utf8')
}

const rows = files.map(file => {
    const outPath = path.resolve(file)
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    const cleaned = flatten(cleanResponse(parsed, undefined, outPath))
    const full = render(cleaned)
    const compacted = render(compactWireResponse(cleaned, outPath))
    return { file: path.basename(file), full: bytes(full), compacted: bytes(compacted), unchanged: full === compacted }
})

const width = Math.max(...rows.map(r => r.file.length))
console.log(`${'out-file'.padEnd(width)}  ${'full'.padStart(8)}  ${'compacted'.padStart(9)}  ${'saved'.padStart(14)}`)
for (const r of rows) {
    const saved = r.full - r.compacted
    const pct = r.full ? ` (${(100 * saved / r.full).toFixed(1)}%)` : ''
    console.log(`${r.file.padEnd(width)}  ${String(r.full).padStart(8)}  ${String(r.compacted).padStart(9)}  ${(String(saved) + pct).padStart(14)}`)
}

const sumFull = rows.reduce((a, r) => a + r.full, 0)
const sumCompact = rows.reduce((a, r) => a + r.compacted, 0)
const savedTotal = sumFull - sumCompact
console.log(`${'TOTAL'.padEnd(width)}  ${String(sumFull).padStart(8)}  ${String(sumCompact).padStart(9)}  ${(String(savedTotal) + ` (${(100 * savedTotal / sumFull).toFixed(1)}%)`).padStart(14)}`)
console.log(`\n${rows.filter(r => r.unchanged).length}/${rows.length} payloads had nothing worth compacting and were returned byte-identical`)
