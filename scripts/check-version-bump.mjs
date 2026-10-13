#!/usr/bin/env node
// A src/ change that ships without a BUNDLE_VERSION bump never reaches a running server: the
// deployed bundle self-updates only when the candidate version is strictly newer, so a new verb
// added to src/verb-table.js and committed under the same version stays absent from every
// installed copy until some later commit happens to bump it. This check makes that impossible.
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

// The pushed range is the whole change, but a checkout that only fetched the head cannot resolve
// it; the single-commit range still catches a src/ edit pushed on its own, which is the common
// case, and a checkout with no history at all is skipped rather than failed.
function changedPaths(base, head) {
    const ranges = [`${base}..${head}`, `${head}^..${head}`]
    for (const range of ranges) {
        const diff = spawnSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
        if (diff.status === 0) {
            return diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
        }
    }
    console.log(`check-version-bump: neither ${ranges.join(' nor ')} resolves in this checkout -- skipping`)
    return null
}

const paths = changedPaths(base, head)
if (paths === null) process.exit(0)
const srcPaths = paths.filter((path) => path.startsWith('src/') && path !== 'src/bundle-version.js')

if (srcPaths.length === 0) {
    console.log('check-version-bump: no src/ change in this range -- nothing to bump')
    process.exit(0)
}

const problems = []
if (!paths.includes('src/bundle-version.js')) {
    problems.push(`src/ changed (${srcPaths.join(', ')}) but src/bundle-version.js did not, so the deployed bundle self-update guard reads the candidate as not newer and never installs it`)
}
if (!paths.includes('bin/gm-mcp-server.js')) {
    problems.push(`src/ changed (${srcPaths.join(', ')}) but bin/gm-mcp-server.js did not; run npm run build and commit the bundle in the same commit`)
}

if (problems.length > 0) {
    for (const problem of problems) console.error(`check-version-bump: ${problem}`)
    process.exit(1)
}

console.log(`check-version-bump: src/ change ships with a BUNDLE_VERSION bump and a rebuilt bundle (${srcPaths.length} path(s))`)
