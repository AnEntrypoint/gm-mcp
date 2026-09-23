#!/usr/bin/env node
// Points this checkout's git hooks at the tracked .githooks/ dir so
// pre-push (which runs verify-build) is active without a manual step --
// core.hooksPath is a local, per-checkout git config value, never committed.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const res = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot, stdio: 'inherit' })
if (res.status !== 0) {
    console.error('gm-mcp: could not set core.hooksPath (not a git checkout, or git unavailable) -- pre-push drift check will not run automatically')
}
