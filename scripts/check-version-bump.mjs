#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const NULL_SHA = /^0{40}$/
const [base, head] = process.argv.slice(2)

if (!base || !head) {
    console.log('check-version-bump: no base and head given -- skipping')
    process.exit(0)
}
if (NULL_SHA.test(base)) {
    console.log('check-version-bump: base is the null sha (new branch or force-push) -- skipping')
    process.exit(0)
}

function changedPaths(base, head) {
    const rangesWidestFirst = [[`${base}..${head}`, base], [`${head}^..${head}`, `${head}^`]]
    for (const [range, baseRev] of rangesWidestFirst) {
        const diff = spawnSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
        if (diff.status === 0) {
            return { paths: diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean), baseRev }
        }
    }
    console.log(`check-version-bump: neither ${rangesWidestFirst.map(([range]) => range).join(' nor ')} resolves in this checkout -- skipping`)
    return null
}

function bundleVersionAt(rev) {
    const shown = spawnSync('git', ['show', `${rev}:src/bundle-version.js`], { encoding: 'utf8' })
    const match = shown.status === 0 ? shown.stdout.match(/BUNDLE_VERSION\s*=\s*'([^']+)'/) : null
    return match ? match[1] : null
}

const range = changedPaths(base, head)
if (range === null) process.exit(0)
const { paths, baseRev } = range
const srcPaths = paths.filter((path) => path.startsWith('src/') && path !== 'src/bundle-version.js')

if (srcPaths.length === 0) {
    console.log('check-version-bump: no src/ change in this range -- nothing to bump')
    process.exit(0)
}

const problems = []
if (!paths.includes('src/bundle-version.js')) {
    problems.push(`src/ changed (${srcPaths.join(', ')}) but src/bundle-version.js did not, so the deployed bundle self-update guard reads the candidate as not newer and never installs it`)
} else {
    const before = bundleVersionAt(baseRev)
    const after = bundleVersionAt(head)
    if (after === null || after === before) {
        problems.push(`src/ changed (${srcPaths.join(', ')}) and src/bundle-version.js was touched, but BUNDLE_VERSION is ${after === null ? 'unreadable' : `still ${after}`} (base ${before ?? 'absent'}); bump it so the self-update guard sees a newer build`)
    }
}
if (!paths.includes('bin/gm-mcp-server.js')) {
    problems.push(`src/ changed (${srcPaths.join(', ')}) but bin/gm-mcp-server.js did not; run npm run build and commit the bundle in the same commit`)
}

if (problems.length > 0) {
    for (const problem of problems) {
        const line = `check-version-bump: ${problem}`
        console.log(line)
        console.error(line)
    }
    process.exit(1)
}

console.log(`check-version-bump: src/ change ships with a BUNDLE_VERSION bump and a rebuilt bundle (${srcPaths.length} path(s))`)
