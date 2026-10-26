// Writes the gm skill files this bundle carries (src/skills-snapshot.js) into the skill roots a host reads,
// so a fresh machine needs no installer. A missing file is written; a file this bundle already installed is
// rewritten when the bundled sha256 moved (a new bundle version ships new prose), so a copy tracks the bundle
// instead of freezing at its first install. A skill directory that is a link (a checkout linked by hand) is
// left alone, and so is a file no gm install ledger claims: a checkout copy is owned by the installer and by
// the runner refresh loop, not by this bundle.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILLS } from './skills-snapshot.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { appendDiagnostic } from './server-log.js'

const MODE_LEDGER = '.gm-skill-install-modes'
const LEDGER_HEADER = '# gm skill install modes: <name> <linked|copied|refused> <iso-ts> <source>'
const VERSION_LEDGER = '.gm-skill-versions'
const VERSION_HEADER = '# gm skill install digests: <name> <sha256> <bundle-version>'

export function skillInstallRoots(home = os.homedir()) {
    return [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')]
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function isLink(file) {
    try {
        return lstatSync(file).isSymbolicLink()
    } catch {
        return false
    }
}

function ledgerLines(file) {
    let text = ''
    try {
        text = readFileSync(file, 'utf8')
    } catch {
        return []
    }
    return text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
}

function writeLedger(file, header, rows) {
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${header}\n${rows.join('\n')}\n`)
    try {
        renameSync(tmp, file)
    } catch (error) {
        rmSync(tmp, { force: true })
        throw error
    }
}

function replaceRows(file, header, name, row) {
    const kept = ledgerLines(file).filter(line => line.split(/\s+/)[0] !== name)
    kept.push(row)
    writeLedger(file, header, kept)
}

function recordCopied(root, name) {
    replaceRows(path.join(root, MODE_LEDGER), LEDGER_HEADER, name, `${name} copied ${new Date().toISOString()} bundle-snapshot reason: copied from the gm-mcp bundle (no checkout or release source)`)
}

function recordVersion(root, name, digest) {
    replaceRows(path.join(root, VERSION_LEDGER), VERSION_HEADER, name, `${name} ${digest} ${BUNDLE_VERSION}`)
}

// Names this bundle owns in a root: the ones it copied itself. A name the ledger does not claim is left alone.
function bundleOwned(root) {
    const owned = new Set()
    for (const line of ledgerLines(path.join(root, MODE_LEDGER))) {
        const parts = line.split(/\s+/)
        if (parts[1] !== 'copied') continue
        if (line.includes('bundle-snapshot')) owned.add(parts[0])
    }
    for (const line of ledgerLines(path.join(root, VERSION_LEDGER))) {
        const name = line.split(/\s+/)[0]
        if (name) owned.add(name)
    }
    return owned
}

function writeFile(dest, text) {
    mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.tmp-${process.pid}`
    writeFileSync(tmp, text, { flag: 'wx' })
    try {
        renameSync(tmp, dest)
    } catch (error) {
        rmSync(tmp, { force: true })
        throw error
    }
}

function replaceFile(dest, text) {
    mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.tmp-${process.pid}`
    writeFileSync(tmp, text)
    try {
        renameSync(tmp, dest)
    } catch (error) {
        rmSync(tmp, { force: true })
        throw error
    }
}

// One digest per skill over every file the bundle carries for it, so a version move anywhere in a skill shows up.
const SKILL_DIGESTS = (() => {
    const byName = new Map()
    for (const entry of SKILLS) {
        const rows = byName.get(entry.name) ?? []
        rows.push(`${entry.file} ${entry.sha256}`)
        byName.set(entry.name, rows)
    }
    return new Map([...byName].map(([name, rows]) => [name, sha256(rows.sort().join('\n'))]))
})()

// Returns the skill-relative paths written or refreshed. Throws only when the bundle's own snapshot fails its digest.
export function installMissingSkills(roots = skillInstallRoots()) {
    const written = []
    for (const root of roots) {
        const owned = bundleOwned(root)
        const touched = new Set()
        for (const entry of SKILLS) {
            const skillDir = path.join(root, entry.name)
            if (isLink(skillDir)) continue
            const dest = path.join(skillDir, entry.file)
            if (sha256(entry.text) !== entry.sha256) throw new Error(`bundled skill ${entry.name}/${entry.file} does not match its sha256`)
            if (existsSync(dest)) {
                if (!owned.has(entry.name)) continue
                let have = null
                try {
                    have = sha256(readFileSync(dest))
                } catch {
                    have = null
                }
                if (have === entry.sha256) continue
                replaceFile(dest, entry.text)
                written.push(`${entry.name}/${entry.file}`)
                touched.add(entry.name)
                continue
            }
            writeFile(dest, entry.text)
            written.push(`${entry.name}/${entry.file}`)
            touched.add(entry.name)
        }
        if (touched.size > 0) {
            mkdirSync(root, { recursive: true })
            for (const name of touched) {
                recordCopied(root, name)
                recordVersion(root, name, SKILL_DIGESTS.get(name) ?? '')
            }
        }
    }
    return written
}

// Startup install: synchronous, so the files this session's host already enumerated are on disk before the
// event loop runs any other work. Never throws: a failed install leaves the installed skills unchanged.
export function installSkillsAtStartup(roots = skillInstallRoots()) {
    try {
        const written = installMissingSkills(roots)
        if (written.length === 0) return { written: [], roots }
        console.error(`gm-mcp: installed ${written.length} missing gm skill file(s) into ${roots.join(' and ')}`)
        appendDiagnostic('skills-installed', { count: written.length, phase: 'startup', first: written.slice(0, 5) })
        return { written, roots }
    } catch (error) {
        appendDiagnostic('skills-install-failed', { phase: 'startup', error: String(error?.message ?? error) })
        console.error(`gm-mcp: skill install failed (${error?.message ?? error}); the installed skills are unchanged`)
        return { written: [], roots, error: String(error?.message ?? error) }
    }
}

export function installSkillsInBackground() {
    setImmediate(() => {
        installSkillsAtStartup()
    })
}
