// The gm_skill verb: the skills this bundle carries, and their SKILL.md text, answered from the bundle itself.
// A host freezes its skill list when it starts, so a session that began before gm wrote ~/.claude/skills sees no
// gm skill at all; this verb is how an agent in that session reads the instructions without restarting. Text is
// paged by line and capped by characters, so a 54 KB SKILL.md never lands in one reply.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { SKILLS } from './skills-snapshot.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { skillInstallRoots } from './skill-install.js'

const DEFAULT_PAGE_LINES = 400
const DEFAULT_MAX_CHARS = 20000
const RESERVE_CHARS = 900

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// Frontmatter description only; skills-mcp.js owns the full parser but importing it here would circle back
// through dispatch.js, so this stays local and reads the one key a host shows.
function descriptionOf(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))
    if (!match) return ''
    const field = /^description:[ \t]*(.*)$/m.exec(match[1])
    if (!field) return ''
    const value = field[1].trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try { return JSON.parse(value) } catch { return value.slice(1, -1) }
    }
    return value
}

function byName() {
    const groups = new Map()
    for (const entry of SKILLS) {
        if (!groups.has(entry.name)) groups.set(entry.name, [])
        groups.get(entry.name).push(entry)
    }
    return groups
}

function toInt(value, fallback) {
    const n = typeof value === 'string' ? Number(value.trim()) : value
    return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function truthy(value) {
    return value === true || value === 'true' || value === 1 || value === '1'
}

function clipText(text, maxChars) {
    if (text.length <= maxChars) return { text, cut: false }
    const cutAt = text.lastIndexOf('\n', maxChars)
    const end = cutAt > Math.floor(maxChars * 0.5) ? cutAt : maxChars
    return { text: text.slice(0, end), cut: true }
}

function installedPathOf(root, name, file) {
    return path.join(root, name, file)
}

function skillIndex(groups, roots) {
    const skills = [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, entries]) => {
            const main = entries.find(entry => entry.file === 'SKILL.md') ?? entries[0]
            const installed = roots
                .map(root => ({ root, file: installedPathOf(root, name, 'SKILL.md') }))
                .find(candidate => existsSync(candidate.file))
            return {
                name,
                description: descriptionOf(main.text),
                files: entries.length,
                bundle_sha256: main.sha256,
                installed_path: installed?.file ?? null,
                installed_matches_bundle: installed === undefined ? null : sha256(readFileSync(installed.file, 'utf8')) === main.sha256,
            }
        })
    return {
        ok: true,
        verb: 'gm-skill',
        bundle_version: BUNDLE_VERSION,
        count: skills.length,
        install_roots: roots,
        skills,
        note: 'Every skill this bundle carries. Ask for one with name (and optionally file) to read its text; the text is paged by line, so follow next until truncated is false.',
    }
}

function pageOf(entry, offset, limit, maxChars) {
    const lines = entry.text.replace(/\n$/, '').split('\n')
    const start = Math.min(Math.max(offset, 1), Math.max(lines.length, 1))
    const room = Math.max(1, maxChars - RESERVE_CHARS)
    const slice = lines.slice(start - 1, start - 1 + limit)
    const joined = slice.join('\n')
    const clipped = clipText(joined, room)
    const shown = clipped.text === '' ? [] : clipped.text.split('\n')
    const end = start - 1 + shown.length
    const truncated = end < lines.length
    return {
        lines_total: lines.length,
        lines_from: start,
        lines_to: end,
        truncated,
        text: clipped.text,
        next: truncated ? { verb: 'gm-skill', name: entry.name, file: entry.file, offset: end + 1, limit } : null,
    }
}

export function gmSkillReply({ body = {}, maxChars = DEFAULT_MAX_CHARS } = {}) {
    const groups = byName()
    const roots = skillInstallRoots()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const file = typeof body.file === 'string' && body.file.trim() !== '' ? body.file.trim() : 'SKILL.md'
    if (name === '' || truthy(body.list)) return yaml.dump(skillIndex(groups, roots), { lineWidth: 100 })
    const entries = groups.get(name)
    if (!entries) {
        return yaml.dump({
            ok: false,
            verb: 'gm-skill',
            error: `no skill named ${name} in this bundle`,
            known: [...groups.keys()].sort(),
            next: { verb: 'gm-skill', list: true },
        }, { lineWidth: 100 })
    }
    const entry = entries.find(candidate => candidate.file === file)
    if (!entry) {
        return yaml.dump({
            ok: false,
            verb: 'gm-skill',
            error: `${name} carries no file ${file}`,
            files: entries.map(candidate => candidate.file),
        }, { lineWidth: 100 })
    }
    if (truthy(body.head) && file === 'SKILL.md') {
        // head asks for the frontmatter-only view: the description a host would show, not the prose.
        return yaml.dump({ ok: true, verb: 'gm-skill', name, file, description: descriptionOf(entry.text) }, { lineWidth: 100 })
    }
    const offset = toInt(body.offset ?? body.startLine ?? body.from, 1)
    const limit = toInt(body.limit ?? body.lines ?? body.count, DEFAULT_PAGE_LINES)
    const page = pageOf(entry, offset, limit, maxChars)
    const installed = roots.map(root => installedPathOf(root, name, file)).find(candidate => existsSync(candidate))
    return yaml.dump({
        ok: true,
        verb: 'gm-skill',
        bundle_version: BUNDLE_VERSION,
        name,
        file,
        sha256: entry.sha256,
        install_roots: roots,
        installed_path: installed ?? null,
        ...page,
        note: 'This is the bundled text, not the file on disk. A host that enumerated its skills before gm wrote them cannot see them this session; read installed_path with fs_read for the same text from disk.',
    }, { lineWidth: 100 })
}

export const GM_SKILL_BODY = {
    required: [],
    fields: {
        name: { type: 'string', description: 'Skill name, e.g. gm. Omit (or send list:true) for the index of every skill with its description and installed path.' },
        file: { type: 'string', description: "File inside the skill; defaults to SKILL.md. prose/ and docs/ paths work too." },
        list: { type: 'boolean', description: 'Answer the index even when name is given.' },
        head: { type: 'boolean', description: 'Answer only the SKILL.md frontmatter (name and description) instead of the body.' },
        offset: { type: 'integer', description: 'First line to return (1-based).' },
        limit: { type: 'integer', description: `Lines to return; defaults to ${DEFAULT_PAGE_LINES}, then cut to fit the reply cap.` },
        startLine: { type: 'integer', description: '1-based alias of offset.' },
        lines: { type: 'integer', description: 'Alias of limit.' },
    },
}
