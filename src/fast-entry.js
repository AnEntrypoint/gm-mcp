// Bundle entry. The full CLI is embedded as text (gm:full-bundle, see scripts/build.mjs) and imported
// as a data: module only when the cold stdio path has answered, or a subcommand or relay mode needs it.
// The embedded bundle reads its own location from globalThis.__gmBundleUrl, set here from this file.
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFastStdio } from './fast-stdio.js'
import FULL_BUNDLE from 'gm:full-bundle'

globalThis.__gmBundleUrl = import.meta.url
const loadFull = () => import('data:text/javascript;base64,' + Buffer.from(FULL_BUNDLE, 'utf8').toString('base64'))

// A host enumerates its skill roots when it starts, so a machine with no gm skill yet has to get them as
// early as this process can manage. The cold path otherwise waits a second of idle before loading the full
// bundle, and the install rides in with it; when the gm skill is already installed the wait is harmless.
if (!existsSync(path.join(os.homedir(), '.claude', 'skills', 'gm', 'SKILL.md'))) setImmediate(loadFull)

if (startFastStdio({ onNeedFull: () => setImmediate(loadFull) })) {
    // the cold path arms its own idle load in fast-stdio.js
} else {
    await loadFull()
}
