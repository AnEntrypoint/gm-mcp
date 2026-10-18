#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (!existsSync(path.join(repoRoot, '.git'))) {
    console.error('gm-mcp: skipped core.hooksPath (package root is not its own git work tree, e.g. installed under node_modules; enclosing repository left unchanged)')
    process.exit(0)
}
const gitConfigResult = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot, stdio: 'inherit', windowsHide: true })
if (gitConfigResult.status !== 0) {
    console.error('gm-mcp: could not set core.hooksPath (not a git checkout, or git unavailable) -- pre-push drift check will not run automatically')
}
