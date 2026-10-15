// The host-process boundary for the release-bridge, self-update, singleton and dev-sync modules.
// Git does not come through here: it goes through git-adapter.js (runGit).
export { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
