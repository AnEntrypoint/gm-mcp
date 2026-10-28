// Bundle entry. The full CLI is embedded as text (gm:full-bundle, see scripts/build.mjs) and imported
// as a data: module only when the cold stdio path has answered, or a subcommand or relay mode needs it.
// The embedded bundle reads its own location from globalThis.__gmBundleUrl, set here from this file.
import { startFastStdio } from './fast-stdio.js'
import FULL_BUNDLE from 'gm:full-bundle'

globalThis.__gmBundleUrl = import.meta.url
const loadFull = () => import('data:text/javascript;base64,' + Buffer.from(FULL_BUNDLE, 'utf8').toString('base64'))

if (startFastStdio({ onNeedFull: () => setImmediate(loadFull) })) {
    // the cold path arms its own idle load in fast-stdio.js
} else {
    await loadFull()
}
