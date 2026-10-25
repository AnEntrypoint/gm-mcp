// Writes the gm skill files this bundle carries (src/skills-snapshot.js) into the skill roots a host reads,
// so a fresh machine needs no installer. Only missing files are written: an existing file is never
// overwritten, because the runner's refresh loop owns updates to installed skills. A skill directory
// that is a link (a checkout linked by hand) is left alone.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILLS } from './skills-snapshot.js'
import { appendDiagnostic } from './server-log.js'

const MODE_LEDGER = '.gm-skill-install-modes'
const LEDGER_HEADER = '# gm skill install modes: <name> <linked|copied|refused> <iso-ts> <source>'

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

function recordCopied(root, name) {
    const file = path.join(root, MODE_LEDGER)
    let kept = []
    try {
        kept = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '' && !line.startsWith('#') && line.split(/\s+/)[0] !== name)
    } catch {}
    kept.push(`${name} copied ${new Date().toISOString()} bundle-snapshot reason: copied from the gm-mcp bundle (no checkout or release source)`)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${LEDGER_HEADER}\n${kept.join('\n')}\n`)
    try {
        renameSync(tmp, file)
    } catch (error) {
        rmSync(tmp, { force: true })
        throw error
    }
}

// Returns the skill-relative paths written. Throws only when the bundle's own snapshot fails its digest.
export function installMissingSkills(roots = skillInstallRoots()) {
    const written = []
    for (const root of roots) {
        const copiedNames = new Set()
        for (const entry of SKILLS) {
            const skillDir = path.join(root, entry.name)
            if (isLink(skillDir)) continue
            const dest = path.join(skillDir, entry.file)
            if (existsSync(dest)) continue
            if (sha256(entry.text) !== entry.sha256) throw new Error(`bundled skill ${entry.name}/${entry.file} does not match its sha256`)
            mkdirSync(path.dirname(dest), { recursive: true })
            const tmp = `${dest}.tmp-${process.pid}`
            writeFileSync(tmp, entry.text, { flag: 'wx' })
            try {
                renameSync(tmp, dest)
            } catch (error) {
                rmSync(tmp, { force: true })
                throw error
            }
            copiedNames.add(entry.name)
            written.push(`${entry.name}/${entry.file}`)
        }
        if (copiedNames.size > 0) {
            mkdirSync(root, { recursive: true })
            for (const name of copiedNames) recordCopied(root, name)
        }
    }
    return written
}

export function installSkillsInBackground() {
    setImmediate(() => {
        try {
            const written = installMissingSkills()
            if (written.length === 0) return
            console.error(`gm-mcp: installed ${written.length} missing gm skill file(s) into ${skillInstallRoots().join(' and ')}`)
            appendDiagnostic('skills-installed', { count: written.length, first: written.slice(0, 5) })
        } catch (error) {
            appendDiagnostic('skills-install-failed', { error: String(error?.message ?? error) })
            console.error(`gm-mcp: skill install failed (${error?.message ?? error}); the installed skills are unchanged`)
        }
    })
}
