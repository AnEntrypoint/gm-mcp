// Public code search and PRD references. The github-search and prd-references verbs (triage-verbs.js), the
// public_search block that a prd-add reply carries (dispatch.js), and the reference gate that prd-resolve, prd-close
// and the closing commit of publish_on_origin pass through. Search runs through the gh CLI (gh search code): gh holds
// the user's token, maps every filter to a flag, and reports the API's errors; the REST endpoint would need a token
// in the environment and its own qualifier mapping.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { withBlock } from './continuation.js'

export const SEARCH_DEFAULT_LIMIT = 30
export const SEARCH_MAX_LIMIT = 100
export const REFERENCE_CAP = 60
export const REFERENCE_BATCH_CAP = 20
const GH_TIMEOUT_MS = 60_000
const GH_MAX_BUFFER = 16 * 1024 * 1024
const SEARCH_JSON_FIELDS = 'path,repository,sha,url'
const MATCH_VALUES = ['file', 'path']
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_FULL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/
const LANGUAGE = /^[A-Za-z0-9+#.-]{1,40}$/
const FILENAME = /^[A-Za-z0-9_.-]{1,200}$/
const EXTENSION = /^[A-Za-z0-9]{1,16}$/
const SIZE = /^([<>]=?)?\d+$|^\d+\.\.\d+$/
const SHA = /^[0-9a-f]{7,64}$/i
const RELATIVE_PATH = /^[A-Za-z0-9_.\/-]{1,300}$/
const BLOB_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/
const HTTPS_URL = /^https:\/\/[^\s/]+\/\S+$/
const OK_TRUE = /(?:^|\n)\s*"?ok"?:\s*true\b/
const NO_REFERENCES_LINE = /no public references:\s*\S[^\n]{9,}/i
const ROW_TEXT_EXCLUDED = new Set(['id', 'status', 'owner', 'session_id', 'disposition'])
const PRD_ADD_VERBS = new Set(['prd-add', 'prd_add'])
const FILE_NAME = /\b[\w-]+\.(?:rs|mjs|cjs|js|jsx|ts|tsx|go|py|java|kt|swift|cc|cpp|c|h|hpp|cs|rb|php|sh|ps1|json|ya?ml|toml)\b/g
const BACKTICK = /`([^`\n]{2,80})`/g
const SNAKE_OR_CAMEL = /\b(?:[a-z]+(?:_[a-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+)\b/g
const QUOTED = /"([^"\n]{6,120})"/
const EXT_LANGUAGE = {
    rs: 'Rust', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
    go: 'Go', py: 'Python', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++',
    cs: 'C#', rb: 'Ruby', php: 'PHP', sh: 'Shell', ps1: 'PowerShell',
}
const STOPWORDS = new Set([
    'about', 'after', 'again', 'against', 'because', 'before', 'being', 'between', 'could', 'should', 'would', 'these', 'those',
    'there', 'their', 'where', 'which', 'while', 'other', 'still', 'every', 'through', 'without', 'within', 'makes', 'sure',
    'needs', 'needed', 'issue', 'handle', 'handles', 'row', 'prd', 'file', 'files', 'code',
])

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const unique = (values) => [...new Set(values)]
const allMatches = (pattern, source) => [...source.matchAll(pattern)].map((match) => match[1] ?? match[0])
const words = (source) => source.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []
const firstWords = (source, count) => source.replace(/["`]/g, '').trim().split(/\s+/).filter(Boolean).slice(0, count).join(' ')
const extensionOf = (file) => file.slice(file.lastIndexOf('.') + 1).toLowerCase()

export function firstText(...values) {
    for (const value of values) {
        const trimmed = text(value)
        if (trimmed !== '') return trimmed
    }
    return null
}

function safeRelativePath(value) {
    return RELATIVE_PATH.test(value) && !value.startsWith('/') && !value.split('/').includes('..')
}

// The gh argv for one search, or {error} for input the verb must refuse before it runs.
export function searchPlan(input) {
    const query = text(input.query)
    const mode = input.mode ?? 'text'
    if (mode === 'symbol' && !IDENTIFIER.test(query)) return { error: 'symbol mode needs one identifier as query' }
    const owners = [input.owner].flat().map(text).filter((owner) => owner !== '')
    if (owners.some((owner) => !OWNER.test(owner))) return { error: 'owner must be a GitHub user or organisation name' }
    const repo = text(input.repo)
    if (repo !== '' && !REPO_FULL.test(repo)) return { error: 'repo must be owner/name' }
    const language = text(input.language)
    if (language !== '' && !LANGUAGE.test(language)) return { error: 'language must be a GitHub language name, e.g. Rust or JavaScript' }
    const extension = text(input.extension).replace(/^\./, '')
    if (extension !== '' && !EXTENSION.test(extension)) return { error: 'extension must be letters and digits, without the dot' }
    const filename = text(input.filename)
    if (filename !== '' && !FILENAME.test(filename)) return { error: 'filename must be a bare file name' }
    const folder = text(input.path)
    if (folder !== '' && !safeRelativePath(folder)) return { error: 'path must be a repository-relative path with no ".." part' }
    const size = text(input.size)
    if (size !== '' && !SIZE.test(size)) return { error: 'size must be a kilobyte range such as >100, <50 or 10..200' }
    if (input.match !== undefined && !MATCH_VALUES.includes(input.match)) return { error: 'match must be file or path' }
    const limit = input.limit ?? SEARCH_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) return { error: `limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}` }
    const hasFilter = owners.length > 0 || repo !== '' || language !== '' || extension !== '' || filename !== '' || folder !== '' || size !== ''
    if (query === '' && !hasFilter) return { error: 'query, or at least one filter (owner, repo, language, extension, filename, path, size), is required' }
    const terms = [mode === 'symbol' ? `symbol:${query}` : query, folder === '' ? '' : `path:${folder}`].filter((term) => term !== '')
    const flags = [
        ...owners.flatMap((owner) => ['--owner', owner]),
        ...(repo === '' ? [] : ['--repo', repo]),
        ...(language === '' ? [] : ['--language', language]),
        ...(extension === '' ? [] : ['--extension', extension]),
        ...(filename === '' ? [] : ['--filename', filename]),
        ...(input.match === undefined ? [] : ['--match', input.match]),
        ...(size === '' ? [] : ['--size', size]),
    ]
    const joined = terms.join(' ')
    return { query: joined, argv: ['search', 'code', joined, ...flags, '--json', SEARCH_JSON_FIELDS, '--limit', String(limit)] }
}

export function classifySearchFailure(stderr, error) {
    const detail = stderr.trim()
    const first = detail.split('\n')[0] ?? ''
    if (error.code === 'ENOENT') return { code: 'gh_missing', message: 'the gh CLI is not on PATH: install it, then run gh auth login' }
    if (error.killed === true || error.signal) return { code: 'search_timeout', message: `gh search code did not finish in ${GH_TIMEOUT_MS / 1000} seconds` }
    if (/rate limit/i.test(detail)) return { code: 'rate_limited', message: first }
    if (/HTTP 401|Bad credentials|gh auth login|authentication/i.test(detail)) return { code: 'auth_required', message: first }
    if (/HTTP 422|HTTP 400|ERROR_TYPE_QUERY_PARSING|unable to parse query|invalid qualifier/i.test(detail)) return { code: 'bad_qualifier', message: first }
    return { code: 'search_failed', message: first || `gh exited with ${error.code}` }
}

export function parseHits(stdout) {
    const rows = JSON.parse(stdout.trim() === '' ? '[]' : stdout)
    if (!Array.isArray(rows)) throw new Error('gh returned no result list')
    return rows.map((row, index) => {
        const url = text(row.url)
        const blob = BLOB_URL.exec(url)
        return {
            rank: index + 1,
            repo: text(row.repository?.nameWithOwner),
            path: text(row.path),
            sha: text(row.sha),
            url,
            raw_url: blob === null ? '' : `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`,
        }
    })
}

export function runGhSearch(argv) {
    return new Promise((resolve) => {
        const options = { env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, encoding: 'utf8', maxBuffer: GH_MAX_BUFFER, timeout: GH_TIMEOUT_MS, windowsHide: true }
        execFile('gh', argv, options, (error, stdout, stderr) => {
            if (error !== null) return resolve({ ok: false, ...classifySearchFailure(String(stderr ?? ''), error) })
            try {
                return resolve({ ok: true, hits: parseHits(String(stdout ?? '')) })
            } catch (parseError) {
                return resolve({ ok: false, code: 'search_failed', message: `gh output was not a result list: ${parseError.message}` })
            }
        })
    })
}

export function rowFileOf(root, id) {
    return path.join(root, '.gm', 'prd', `${id}.yml`)
}

export function validRowId(value) {
    return ROW_ID.test(value)
}

export function readRow(root, id) {
    const file = rowFileOf(root, id)
    let source
    try {
        source = fs.readFileSync(file, 'utf8')
    } catch {
        return { error_code: 'row_missing', error: `no open row ${id} at ${file}; references attach to open rows only` }
    }
    let doc
    try {
        doc = yaml.load(source)
    } catch (error) {
        return { error_code: 'row_unparseable', error: `${file} does not parse: ${error.message}` }
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { error_code: 'row_unparseable', error: `${file} is not a mapping` }
    return { file, doc }
}

let spoolDispatch = null

export function bindSpoolDispatch(dispatch) {
    spoolDispatch = dispatch
}

function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
        fs.writeFileSync(tmp, text)
        fs.renameSync(tmp, file)
    } catch (error) {
        fs.rmSync(tmp, { force: true })
        throw error
    }
}

function noteAccepted(reply) {
    return /"?noted"?\s*:/.test(reply) && !/"?ok"?\s*:\s*false/.test(reply)
}

// Appends one note to a named list of an open row through the runner's prd-note, the write path prd-resolve shares (a
// compare-and-swap write that retries on conflict). Null when the note landed, else the runner's refusal text.
export async function appendRowNote(root, id, field, note, sessionId) {
    if (spoolDispatch === null) return 'the spool dispatch is not bound'
    const reply = String(await spoolDispatch({ verb: 'prd-note', body: { id, field, note }, cwd: root, session_id: sessionId }))
    return noteAccepted(reply) ? null : reply.trim().slice(0, 400)
}

// Checks each reference: url and why are required; repo, path and sha are checked when given; license defaults to unknown.
export function checkReferences(list) {
    if (!Array.isArray(list) || list.length === 0) return { error: 'references must be a non-empty array of {url, why} objects' }
    if (list.length > REFERENCE_BATCH_CAP) return { error: `at most ${REFERENCE_BATCH_CAP} references per call` }
    const references = []
    for (const [index, ref] of list.entries()) {
        const at = `references[${index}]`
        if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return { error: `${at} must be an object` }
        const url = text(ref.url)
        if (!HTTPS_URL.test(url)) return { error: `${at}.url must be an https URL` }
        const why = text(ref.why)
        if (why === '' || why.length > 300 || /[\r\n]/.test(why)) return { error: `${at}.why must be one line of 1 to 300 characters` }
        const repo = text(ref.repo)
        if (repo !== '' && !REPO_FULL.test(repo)) return { error: `${at}.repo must be owner/name` }
        const refPath = text(ref.path)
        if (refPath !== '' && !safeRelativePath(refPath)) return { error: `${at}.path must be a repository-relative path with no ".." part` }
        const sha = text(ref.sha)
        if (sha !== '' && !SHA.test(sha)) return { error: `${at}.sha must be a 7 to 64 character hex git object id` }
        references.push({ url, repo, path: refPath, sha, why, license: text(ref.license) || 'unknown' })
    }
    return { references }
}

// The urls already on a row. Each reference is one note holding its JSON, so the url is read from that JSON.
export function recordedUrls(doc) {
    return (Array.isArray(doc.references) ? doc.references : []).map(recordedUrl).filter((url) => typeof url === 'string')
}

function recordedUrl(entry) {
    if (typeof entry?.url === 'string') return entry.url
    if (typeof entry?.note !== 'string') return null
    try {
        const parsed = JSON.parse(entry.note)
        return typeof parsed?.url === 'string' ? parsed.url : null
    } catch {
        return null
    }
}

const GRANDFATHER_NOTE = 'grandfathered:'
const GATE_STATE = path.join('.gm', 'prd-references-gate.json')

function isGrandfathered(doc) {
    return Array.isArray(doc.references_gate) && doc.references_gate.some((entry) => typeof entry?.note === 'string' && entry.note.startsWith(GRANDFATHER_NOTE))
}

export function rowHasReferences(doc) {
    if (Array.isArray(doc.references) && doc.references.length > 0) return true
    if (isGrandfathered(doc)) return true
    const prose = Object.entries(doc)
        .filter(([key, value]) => !ROW_TEXT_EXCLUDED.has(key) && typeof value === 'string')
        .map(([, value]) => value)
        .join('\n')
    return NO_REFERENCES_LINE.test(prose)
}

// Null when the row may close: it has references, carries the grandfather note, or its body states why none apply. A row
// that cannot be read is left to the runner, which refuses a missing or malformed row on its own.
export function referenceGateRefusal(root, id, verb) {
    const read = readRow(root, id)
    if (read.error_code !== undefined) return null
    if (rowHasReferences(read.doc)) return null
    return `${verb} refused: row ${id} has no references (field "references" is empty). Fill it with gm["prd-references"]({cwd, id, references: [{url, why}]}), or add a row body line "No public references: <reason of at least 10 characters>".`
}

// Tags each row that exists when the gate first runs with a grandfather note, once per project, and records the pass in
// .gm/prd-references-gate.json. Rows created later carry no such note and are gated. Returns null, or the reason the pass
// stopped (the state file is then not written, so the next PRD dispatch retries).
export async function ensureReferenceGate(root) {
    const state = path.join(root, GATE_STATE)
    if (fs.existsSync(state)) return null
    let names = []
    try {
        names = fs.readdirSync(path.join(root, '.gm', 'prd'))
    } catch {
        names = []
    }
    const grandfathered = []
    for (const name of names.filter((file) => file.endsWith('.yml'))) {
        const id = name.slice(0, -'.yml'.length)
        const read = readRow(root, id)
        if (read.error_code !== undefined) continue
        if (!isGrandfathered(read.doc)) {
            const failure = await appendRowNote(root, id, 'references_gate', `${GRANDFATHER_NOTE} row predates the public-references gate`)
            if (failure !== null) return `grandfathering ${id} was refused: ${failure}`
        }
        grandfathered.push(id)
    }
    fs.mkdirSync(path.dirname(state), { recursive: true })
    writeAtomic(state, `${JSON.stringify({ gate: 'public-references', grandfathered, written_at: new Date().toISOString() }, null, 2)}\n`)
    return null
}

export function closeRowId(args) {
    const body = args?.body !== null && typeof args?.body === 'object' && !Array.isArray(args.body) ? args.body : {}
    return firstText(args?.id, body.id, args?.prd_id, body.prd_id)
}

const isKeyword = (word) => word.length >= 5 && !STOPWORDS.has(word)

// The directive for a freshly added row: suggested queries from its title and body, the qualifiers to try, and the prompt an
// agent passes to its Agent tool, which runs the public search and files the references.
export function publicSearchBlock({ id, subject = '', description = '', root = '<project root>' }) {
    const prose = `${subject}\n${description}`
    const files = unique(allMatches(FILE_NAME, prose)).slice(0, 2)
    const symbols = unique([
        ...allMatches(BACKTICK, prose).map((span) => span.replace(/\(\)$/, '').split(/::|\./).pop()),
        ...allMatches(SNAKE_OR_CAMEL, prose),
    ]).filter((name) => IDENTIFIER.test(name)).slice(0, 3)
    const phrase = firstWords(QUOTED.exec(prose)?.[1] ?? subject, 8)
    const queries = unique([
        ...files.map((file) => (symbols[0] === undefined ? `filename:${file}` : `${symbols[0]} filename:${file}`)),
        ...symbols,
        phrase === '' ? '' : `"${phrase}"`,
        firstWords(words(subject).filter(isKeyword).join(' '), 3),
        firstWords(subject, 5),
        firstWords(description, 5),
    ].filter((query) => query !== '')).slice(0, 6)
    const extensions = unique(files.map(extensionOf))
    const languages = unique(extensions.map((ext) => EXT_LANGUAGE[ext]).filter(Boolean))
    const qualifiers = [
        ...languages.map((language) => `language=${language}`),
        ...files.map((file) => `filename=${file}`),
        ...extensions.map((ext) => `extension=${ext}`),
        'owner=<leave out first; add when the first pass is noisy>',
        'repo=<owner/name once a candidate repository is known>',
        'match=path for filename hits, match=file for content hits',
        'size=<kilobyte range such as >20, to drop generated files>',
    ]
    const prompt = [
        'use the gm skill for this; code questions go to codeinsight (callers, impact) first, then the code-search port, and fs_read only a located path.',
        `Find public code for PRD row ${id} ("${subject}"). Symptom: ${phrase || subject}.`,
        `1. Run gm["github-search"]({cwd: "${root}", query, language, owner, repo, extension, filename, path, match, size}) for each query below and its variants. Widen by dropping language, then owner. Narrow by adding language, repo or extension.`,
        '2. Read the best hits with gm.fetch({url: <raw_url>, prompt: "<what the passage must show>"}). Keep only hits that show the mechanism the symptom names.',
        `3. Finish with gm["prd-references"]({cwd: "${root}", id: "${id}", references: [{url, repo, path, sha, why, license}]}), one line of why per reference. Do not change the row status and do not call prd-resolve.`,
        '4. Return only located citations as path:line and counts. Never return file excerpts beyond the located path and line.',
        `Queries: ${queries.join(' | ')}`,
    ].join('\n')
    return { row: id, queries, qualifiers, prompt }
}

function replyFieldId(reply) {
    return /^id:\s*(\S+)\s*$/m.exec(reply)?.[1] ?? null
}

// Adds public_search to a successful prd-add reply. The row id comes from the call, or from the reply's id line.
export function withPublicSearch(args, reply) {
    if (!PRD_ADD_VERBS.has(args?.verb) || typeof reply !== 'string' || !OK_TRUE.test(reply)) return reply
    const body = args?.body !== null && typeof args?.body === 'object' && !Array.isArray(args.body) ? args.body : {}
    const id = firstText(args?.id, body.id, replyFieldId(reply))
    if (id === null || !ROW_ID.test(id)) return reply
    const block = publicSearchBlock({
        id,
        subject: firstText(args?.subject, body.subject, body.title) ?? '',
        description: firstText(args?.description, body.description) ?? '',
        root: firstText(args?.cwd) ?? '<project root>',
    })
    return withBlock(reply, 'public_search', block)
}

// A prd-add call with body.quiet === true gets no public_search block and no continuation block; its id, status and dispatch_id stay.
export function prdAddQuiet(args) {
    return PRD_ADD_VERBS.has(args?.verb) && args?.body?.quiet === true
}
