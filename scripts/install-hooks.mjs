#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const gitConfigResult = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot, stdio: 'inherit', windowsHide: true })
if (gitConfigResult.status !== 0) {
    console.error('gm-mcp: could not set core.hooksPath (not a git checkout, or git unavailable) -- pre-push drift check will not run automatically')
}
