import { SKILLS } from './skills-snapshot.js'
import { gmDispatch } from './dispatch.js'
import { liveStateText } from './live-state.js'
import { CWD_PROMPT_ARGS, registerArgsPrompt } from './prompt-args.js'

// The gm skills as MCP primitives, from the snapshot embedded at build time (scripts/embed-skills.mjs).
// Per skill: a prompt named after it (SKILL.md body, frontmatter removed) with one optional cwd argument, which adds
// live project state read when the prompt is fetched. Per file: a resource at skill://<name>/<file>. skill://index
// lists every skill with its description and file URIs. The content is fixed when the bundle is built; no cache is read.

const INDEX_URI = 'skill://index'
const JSON_MIME = 'application/json'
const RESERVED_PROMPTS = new Set(['gm-completion'])

function unquote(value) {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value)
        } catch {
            return value.slice(1, -1)
        }
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
    return value
}

// Flat frontmatter keys (plain, quoted, or folded block scalars) and the body after the closing ---.
export function splitFrontmatter(raw) {
    const text = raw.replace(/^\uFEFF/, '')
    const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
    if (!match) return { meta: {}, body: text.trim() }
    const meta = {}
    let key = null
    for (const line of match[1].split(/\r?\n/)) {
        const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
        if (field) {
            key = field[1]
            const value = field[2].trim()
            meta[key] = /^[>|][+-]?$/.test(value) ? '' : unquote(value)
        } else if (key !== null && /^\s/.test(line)) {
            meta[key] = `${meta[key]} ${line.trim()}`.trim()
        }
    }
    return { meta, body: text.slice(match[0].length).trim() }
}

const uriOf = (entry) => `skill://${entry.name}/${entry.file}`
const mimeOf = (file) => (file.endsWith('.md') ? 'text/markdown' : 'text/plain')

function groupByName(records) {
    const groups = new Map()
    for (const record of records) {
        if (!groups.has(record.name)) groups.set(record.name, [])
        groups.get(record.name).push(record)
    }
    return groups
}

function registerFile(server, entry) {
    const uri = uriOf(entry)
    const mimeType = mimeOf(entry.file)
    server.registerResource(
        uri,
        uri,
        { title: uri, description: `File ${entry.file} of the gm skill ${entry.name}.`, mimeType },
        (url) => ({ contents: [{ uri: url.href, mimeType, text: entry.text }] })
    )
}

// The SKILL.md body, its supporting-file listing, then one live-state block for cwd (or the no-root line).
function registerSkillPrompt(server, name, description, body, supportingUris) {
    const messages = [{ role: 'user', content: { type: 'text', text: body } }]
    if (supportingUris.length > 0) {
        const listing = `Supporting files for the ${name} skill, read with resources/read:\n${supportingUris.map((uri) => `- ${uri}`).join('\n')}`
        messages.push({ role: 'user', content: { type: 'text', text: listing } })
    }
    registerArgsPrompt(server, name, { description, argsSchema: CWD_PROMPT_ARGS }, async ({ cwd } = {}) => ({
        messages: [...messages, { role: 'user', content: { type: 'text', text: await liveStateText(gmDispatch, cwd) } }],
    }))
}

function registerIndex(server, index) {
    const text = JSON.stringify(index, null, 2)
    server.registerResource(
        'skill-index',
        INDEX_URI,
        { title: 'gm skills index', description: 'Every gm skill: name, description, and the resource URIs of its files.', mimeType: JSON_MIME },
        (url) => ({ contents: [{ uri: url.href, mimeType: JSON_MIME, text }] })
    )
}

export function registerSkillsSurface(server) {
    const index = []
    for (const [name, entries] of groupByName(SKILLS)) {
        const skillMd = entries.find((entry) => entry.file === 'SKILL.md')
        const { meta, body } = splitFrontmatter(skillMd?.text ?? '')
        const description = skillMd ? meta.description || null : null
        const uris = entries.map(uriOf)
        index.push({ name, description, files: uris })
        for (const entry of entries) registerFile(server, entry)
        if (skillMd && !RESERVED_PROMPTS.has(name)) {
            const supporting = uris.filter((uri) => uri !== uriOf(skillMd))
            registerSkillPrompt(server, name, description ?? `The gm skill ${name}.`, body, supporting)
        }
    }
    registerIndex(server, index)
}
