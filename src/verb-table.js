import { z } from 'zod'

// The single table of gm verbs. Every verb-facing value is derived from these rows:
//   canonical   the tool and lookup spelling, underscores only (fs_read, prd_add)
//   hyphen      true when the runner's own verb name is hyphenated (prd-add, memorize-prune)
//   aliases     top-level keys folded into body when a caller sends them beside body
//   fields      zod shape of those top-level keys, merged into the tool's input schema
//   description extra prose appended to the tool description
//   body        declared body schema (required and fields); absent when the runner's body is undeclared
// The runner receives the hyphen spelling only through runnerVerb(), the one boundary conversion.

const numberLike = z.union([z.number(), z.string()])
const booleanLike = z.union([z.boolean(), z.string()])
const pathspec = z.union([z.string(), z.array(z.string())])

export const EXEC_LANGS = ['nodejs', 'js', 'python', 'py', 'bash', 'sh', 'shell', 'powershell', 'ps1', 'deno', 'agent', 'claude']

const LANG_FIELD = {
    type: 'string',
    enum: EXEC_LANGS,
    description: 'Runtime that runs `code`. Any other value answers "unsupported lang: <value>"; go, rust, c, cpp and java are registered verb stems with no runtime arm, so dispatch them as the verb instead of as body.lang.',
}

function aliasFields(label, types, keys) {
    return Object.fromEntries(keys.map((key) => [key, types[key].optional()
        .describe(`Top-level alias of body.${key} for ${label}: folded into body when body does not already name it.`)]))
}

function topLevelDescription(verb, keys, defaultsOf) {
    return ` ${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'} accepted at the top level and folded into body, so {"${keys[0]}":"<${defaultsOf.sample}>"} and body:{"${keys[0]}":"<${defaultsOf.sample}>"} are the same call; a key named in both takes its value from body. Without one of them ${verb} takes its own default: ${defaultsOf.text}.`
}

const FS_READ_RANGE_ALIASES = ['startLine', 'endLine', 'start', 'end', 'count', 'from', 'to', 'offset', 'limit', 'line', 'lines']
const FS_READ_RANGE_PAIR_HELP = 'Pairs are resolved in this order: startLine/endLine, then start/end (start/count also works), then from/to, then offset/limit, then line/lines. endLine/end/to is the last line to return; limit/count/lines is a number of lines, not an end line.'
const FS_READ_RANGE_LINE_HELP = {
    startLine: 'First line to return (1-based).',
    endLine: 'Last line to return (1-based, inclusive).',
    start: 'First line to return (1-based).',
    end: 'Last line to return (1-based, inclusive).',
    count: 'Number of lines to return.',
    from: 'First line to return (1-based).',
    to: 'Last line to return (1-based, inclusive).',
    offset: 'First line to return (1-based).',
    limit: 'Number of lines to return.',
    line: 'First line to return (1-based).',
    lines: 'Number of lines to return.',
}
const FS_READ_RANGE_FIELDS = Object.fromEntries(FS_READ_RANGE_ALIASES.map((key) => [key, numberLike.optional().describe(FS_READ_RANGE_LINE_HELP[key])]))
const FS_READ_PATH_RULE = ` "path" is resolved against the cwd you pass (the project root), never absolutely: an absolute path is refused even when it is inside that root, and so is any path carrying ".."; the refusal names the project-relative form to send instead. allowOutsideRoot:true widens a read verb to another root, never permission to climb out of one, and never applies to fs_write.`
const FS_READ_DESCRIPTION = ` Line ranges are 1-based and inclusive on both ends: ${FS_READ_RANGE_ALIASES.join(', ')} are accepted at the top level and folded into body, and the same keys inside body work identically. ${FS_READ_RANGE_PAIR_HELP} A range-looking key that is not one of them is an error naming the accepted keys rather than a silent whole file. Without any of them the whole file is returned, unchanged.` + FS_READ_PATH_RULE

const GIT_COMMIT_TYPES = {
    message: z.string(),
    paths: z.array(z.string()),
    files: z.array(z.string()),
    allow_whole_index: booleanLike,
    recover_remote_moved: booleanLike,
    source_ref: z.string(),
    rev: z.string(),
    ref: z.string(),
    sha: z.string(),
    commit: z.string(),
    stat: booleanLike,
    path: z.string(),
}
const GIT_COMMIT_KEYS = ['message', 'paths', 'files', 'allow_whole_index', 'recover_remote_moved', 'source_ref', 'rev']
const GIT_COMMIT_FIELDS = aliasFields('git_finalize/git_commit', GIT_COMMIT_TYPES, GIT_COMMIT_KEYS)
const GIT_COMMIT_DESCRIPTION = ` ${GIT_COMMIT_KEYS.join(', ')} are accepted at the top level and folded into body, so {"message":..., "paths":[...]} and body:{"message":..., "paths":[...]} are the same call; a key named in both takes its value from body.`

const GIT_PUSH_KEYS = ['rev']
const GIT_PUSH_FIELDS = aliasFields('git_push', GIT_COMMIT_TYPES, GIT_PUSH_KEYS)
const GIT_PUSH_DESCRIPTION = ` ${GIT_PUSH_KEYS.join(', ')} is accepted at the top level and folded into body, so {"rev":"<sha>"} and body:{"rev":"<sha>"} are the same call; a key named in both takes its value from body.`

const GIT_SHOW_KEYS = ['rev', 'ref', 'sha', 'commit', 'stat', 'path', 'paths', 'files']
const GIT_SHOW_FIELDS = aliasFields('git_show', GIT_COMMIT_TYPES, GIT_SHOW_KEYS)
const GIT_SHOW_DESCRIPTION = ` ${GIT_SHOW_KEYS.join(', ')} are accepted at the top level and folded into body, so {"rev":"<sha>", "stat": true} and body:{"rev":"<sha>", "stat": true} are the same call; a key named in both takes its value from body. Without a rev git_show reads HEAD, and without stat, path, paths or files it prints the whole commit, which is what a dropped field used to look like.`

const PRD_LIST_TYPES = {
    id: z.string(),
    status: z.enum(['pending', 'ready', 'completed', 'blocked', 'all']),
    limit: numberLike,
    offset: numberLike,
    full: booleanLike,
}
const PRD_LIST_KEYS = ['id', 'status', 'limit', 'offset', 'full']
const PRD_LIST_FIELDS = aliasFields('prd_list', PRD_LIST_TYPES, PRD_LIST_KEYS)
const PRD_LIST_DESCRIPTION = ` ${PRD_LIST_KEYS.join(', ')} are accepted at the top level and folded into body, so {"id":"<row id>"} and body:{"id":"<row id>"} are the same call; a key named in both takes its value from body. Without one of them the whole PRD is listed, which is what a dropped selector used to look like.`

const GIT_PATHSPEC = pathspec
const GIT_SCOPED_TYPES = {
    git_log: {
        range: z.string(), ref: z.string(), rev: z.string(),
        limit: z.number(), count: z.number(),
        path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC,
    },
    git_diff: {
        range: z.string(), ref: z.string(), rev: z.string(),
        staged: z.boolean(), stat: z.boolean(),
        path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC,
    },
    git_revert: { ref: z.string(), paths: z.array(z.string()) },
    git_reset: { ref: z.string(), rev: z.string(), mode: z.string(), hard: z.boolean(), paths: z.array(z.string()), files: z.array(z.string()) },
    git_checkout: { ref: z.string(), create: z.boolean(), path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC },
    git_merge: { ref: z.string(), ff_only: z.boolean(), message: z.string() },
    git_stash_pop: { ref: z.string() },
    git_stash_drop: { ref: z.string() },
    git_worktree_add: { ref: z.string(), rev: z.string(), commit: z.string(), start_point: z.string(), path: z.string(), create: z.boolean(), allowOutsideRoot: z.boolean() },
    git_status: { path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC, summary: z.boolean(), limit: z.number(), eol: z.boolean() },
}

function scopedGitRow(verb) {
    const types = GIT_SCOPED_TYPES[verb]
    const keys = Object.keys(types)
    const revisions = keys.filter((key) => key === 'range' || key === 'ref' || key === 'rev')
    const scoped = keys.filter((key) => !revisions.includes(key))
    const text = [
        revisions.length > 0 ? 'without a revision it falls back to its own default or refuses' : '',
        scoped.length > 0 ? `without ${scoped.join(', ')} it falls back to its own default too, and a dropped one looks exactly like one never sent` : '',
    ].filter((part) => part !== '').join('; ')
    const sample = revisions.includes(keys[0]) ? 'rev' : 'value'
    const description = topLevelDescription(verb, keys, { sample, text })
    return {
        aliases: keys,
        fields: aliasFields(verb, types, keys),
        description: verb === 'git_reset'
            ? description + ' hard:true is the boolean form of mode:"hard" and rev is an alias of ref; paths scope the index only, so hard:true together with paths is refused. mode accepts soft|mixed|hard and hard must be a boolean -- anything else is refused with error_code invalid_args, never coerced to a default. Every ok reply carries mode, hard, reset_to and scope, so the operation that ran is readable without re-reading the repo.'
            : description,
    }
}

const TASK_SPAWN_BODY = {
    required: ['lang', 'code'],
    fields: {
        lang: LANG_FIELD,
        code: { type: 'string', aliases: ['body'], description: 'Program text or, for lang agent/claude, the prompt.' },
        timeoutMs: { type: 'integer', description: 'Clamped to [1000, cap]; cap defaults to 1800000.' },
        cwd: { type: 'string', description: 'Directory the job runs in; defaults to the dispatch root.' },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: 'Only for lang agent/claude; defaults to bypassPermissions.' },
    },
}
const LANG_BODY = {
    required: ['lang', 'code'],
    fields: {
        lang: LANG_FIELD,
        code: { type: 'string', aliases: ['body'], description: 'Program text or, for lang agent/claude, the prompt.' },
        timeoutMs: { type: 'integer', description: 'Clamped to [1000, cap].' },
        cwd: { type: 'string', description: 'Directory the job runs in.' },
    },
}
const EXEC_JS_BODY = {
    required: ['code'],
    fields: {
        code: { type: 'string', aliases: ['body'], description: 'JavaScript body, run as nodejs. Pass it as the top-level raw_body argument: a JSON object body is refused. A leading "timeoutMs=<ms>" line sets the budget (floor 100, ceiling 900000).' },
        cwd: { type: 'string', description: 'Directory the script runs in.' },
    },
}
const INSTRUCTION_BODY = {
    required: [],
    fields: {
        prompt: { type: 'string', description: 'Current task prompt. An empty prompt is a continuation.' },
        phase: { type: 'string', description: 'Phase to serve; a bare-string body or a "phase=<x>" prefix carries it too. An unknown phase falls back to the phase on disk.' },
        mode: {
            type: 'string',
            enum: ['investigate_readonly', 'readonly', 'read_only', 'investigate', 'readonly_investigate'],
            description: 'Any of these is the read-only mode: it skips phase orchestration and touches no PRD or mutable state. Any other value is accepted but is not read-only.',
        },
        known_instruction_hash: { type: 'string', aliases: ['instruction_hash', 'ih'], description: 'Suppresses an unchanged reply.' },
        known_policy_hash: { type: 'string', aliases: ['ph'], description: 'Suppresses an unchanged policy block.' },
        git_root_override: { type: 'string', description: 'Pins the project root when cwd is not inside a git repository.' },
        full: { type: 'boolean', aliases: ['prd_full_detail'], description: 'Expands the PRD block.' },
    },
}
const PRD_ADD_BODY = {
    required: [],
    fields: {
        id: { type: 'string', aliases: ['prd_id', 'slug'], description: 'Row id. Absent, it is slugged from subject, title, name, task, goal, description or notes. A row id is a claim until prd-list with that id resolves it.' },
        subject: { type: 'string', description: 'What the row asserts.' },
        status: { type: 'string', enum: ['pending', 'ready', 'completed', 'blocked'], description: 'Row status; defaults to pending.' },
        blockedBy: { type: 'array', description: 'Row ids this row waits on.' },
        overwrite: { type: 'boolean', description: 'Rescopes an existing row; refused when that row is closed.' },
        repair: { type: 'boolean', description: 'Repairs the PRD store before the add.' },
    },
}
const PRD_RESOLVE_BODY = {
    required: ['id'],
    fields: {
        id: { type: 'string', aliases: ['prd_id', 'mutable_id', 'item_id', 'slug', 'key'], description: 'Row id to close.' },
        witness_evidence: { type: 'string', aliases: ['witness', 'evidence'], description: 'Mandatory on every resolve: the observed output that closes the row.' },
        witness_dispatch_id: { type: 'string', aliases: ['dispatch_id'], description: 'Dispatch id recorded in this project\'s .gm/exec-spool/.dispatch-ledger.json. Supplying it replaces the four witness_* fields below.' },
        witness_exit_code: { type: 'integer', description: 'Binding option B, with the three fields after it: all four or none. Must be 0.' },
        witness_output_sha256: { type: 'string', description: '64 lowercase hex chars of the witness output file.' },
        witness_output_path: { type: 'string', description: 'Witness output path relative to the project root, with no "..".' },
        witness_ts: { type: 'string', description: 'RFC 3339 timestamp.' },
        resolution: { type: 'string', aliases: ['resolution_text'], description: 'Free-text resolution note.' },
        commit_sha: { type: 'string', aliases: ['commit'], description: '7-40 hex chars of the delivering commit.' },
        commit_comment: { type: 'string', aliases: ['commit_message', 'resolution_note'], description: 'Commit message for the resolving commit.' },
        status: { type: 'string', description: 'Status to set on the row.' },
        keep_status: { type: 'boolean', aliases: ['preserve_status', 'leave_pending'], description: 'Annotate only: skips the witness gates.' },
        cwd: { type: 'string', description: 'Project root when it differs from the dispatch root.' },
    },
}
const PRD_LIST_BODY = {
    required: [],
    fields: {
        id: { type: 'string', aliases: ['ids', 'row_id'], description: 'Resolves one row. prd-list is not a selector beyond this.' },
        status: { type: 'string', enum: ['pending', 'ready', 'completed', 'blocked'], description: 'Keeps only rows of this status.' },
        limit: { type: 'integer', description: 'Maximum rows returned.' },
        full: { type: 'boolean', aliases: ['verbose', 'bodies'], description: 'Expands row bodies; the default is full when an id filter was given.' },
        brief: { type: 'boolean', aliases: ['compact'], description: 'Compresses rows.' },
    },
}
const POOL_OBSERVE_BODY = {
    required: [],
    fields: {
        live: { type: 'integer', description: 'Live subagent count (the ListAgents count).' },
        held: { type: 'array', description: 'Row ids this session holds.' },
        refusal: { type: 'string', description: 'A spawn refusal text, so the pool can record the ceiling.' },
    },
}
const CODESEARCH_BODY = {
    required: ['query'],
    fields: {
        query: { type: 'string', aliases: ['pattern'], description: 'Non-empty needle. Passing query and pattern with different values is refused.' },
        mode: { type: 'string', enum: ['dual', 'literal', 'regex', 'filename', 'comments'], description: 'An unknown mode is refused. literal, regex and filename refuse any field outside the exhaustive set.' },
        k: { type: 'integer', aliases: ['max_results', 'maxResults', 'limit', 'head_limit'], description: 'Result cap. Defaults to 50 for literal, regex and filename (the reply then reports count, shown and a hint); 0 means unlimited for those modes (refused for dual); conflicting values are refused.' },
        max_matches: { type: 'integer', description: 'Match cap.' },
        max_files: { type: 'integer', description: 'File cap.' },
        max_chars: { type: 'integer', description: 'Byte cap on returned text.' },
        timeout_ms: { type: 'integer', description: 'Scan budget in milliseconds.' },
        path: { type: 'string', aliases: ['paths', 'files'], description: 'Scopes the scan to a subtree; dual applies it to its ranked rows and its literal fallback.' },
        root: { type: 'string', aliases: ['projectPath', 'cwd'], description: 'Searches another project.' },
        glob: { type: 'string', aliases: ['path_glob'], description: 'Path glob; a "!" prefix negates.' },
        exclude: { type: 'string', aliases: ['exclude_glob', 'exclude_globs'], description: 'Exclusion glob.' },
        combine: { type: 'string', aliases: ['term_combination'], enum: ['phrase', 'and', 'or'], description: 'Anything else is refused.' },
        output: { type: 'string', enum: ['matches', 'full', 'compact', 'files', 'count'], description: 'Output shape.' },
        case_insensitive: { type: 'boolean', description: 'Folds case.' },
        whole_word: { type: 'boolean', description: 'Whole-word match; refused in filename mode.' },
        comments_only: { type: 'boolean', aliases: ['comments'], description: 'Scans comments only; refused in filename mode.' },
        verbatim: { type: 'boolean', description: 'Forces combine to phrase.' },
        docs: { type: 'boolean', description: 'Documentation scan; must be a boolean.' },
        refresh: { type: 'boolean', aliases: ['no_cache', 'force_disk'], description: 'Bypasses the cache.' },
        no_ignore: { type: 'boolean', aliases: ['include_ignored', 'exhaustive'], description: 'Includes ignored paths.' },
    },
}
const FS_READ_BODY = {
    required: ['path'],
    fields: {
        path: { type: 'string', description: 'Project-relative path. An absolute path is refused even inside the root, and so is any path carrying "..".' },
        allowOutsideRoot: { type: 'boolean', aliases: ['allow_outside_root', 'allowAbsolute'], description: 'Widens the read to another root; never applies to fs_write.' },
        startLine: { type: 'integer', description: 'First line to return, 1-based.' },
        endLine: { type: 'integer', description: 'Last line to return, 1-based and inclusive.' },
        limit: { type: 'integer', description: 'Number of lines to return, not an end line.' },
        max_bytes: { type: 'integer', aliases: ['maxBytes'], description: 'Byte cap on the read.' },
    },
}
const FS_WRITE_BODY = {
    required: ['path', 'content'],
    fields: {
        path: { type: 'string', description: 'Project-relative path. allowOutsideRoot never widens a write.' },
        content: { type: 'string', aliases: ['data', 'text'], description: 'Complete file content: gm has no edit verb, so a whole-file write is the supported edit.' },
        allow_empty: { type: 'boolean', description: 'Empty content is refused without it.' },
        append: { type: 'boolean', description: 'Appends instead of replacing.' },
    },
}
const FS_READDIR_BODY = {
    required: [],
    fields: {
        path: { type: 'string', description: 'Project-relative directory; an absolute path is refused even inside the root.' },
        limit: { type: 'integer', description: 'Default 200, maximum 1000.' },
        offset: { type: 'integer', description: 'First entry to return.' },
        allowOutsideRoot: { type: 'boolean', aliases: ['allow_outside_root', 'allowAbsolute'], description: 'Widens the read to another root.' },
    },
}
const FS_STAT_BODY = {
    required: ['path'],
    fields: {
        path: { type: 'string', description: 'Project-relative path.' },
        allowOutsideRoot: { type: 'boolean', aliases: ['allow_outside_root', 'allowAbsolute'], description: 'Widens the read to another root.' },
    },
}
const GIT_COMMIT_BODY = {
    required: ['message'],
    fields: {
        message: { type: 'string', description: 'Commit message.' },
        paths: { type: 'array', aliases: ['files'], description: 'Paths to commit; a pathless finalize sweeps every staged change, including another lane\'s. Non-string entries are refused.' },
        allow_empty: { type: 'boolean', description: 'Commits with no changes.' },
        amend: { type: 'boolean', description: 'Amends HEAD; refused on a pushed HEAD.' },
        add_all: { type: 'boolean', description: 'Stages everything first.' },
        allow_whole_index: { type: 'boolean', description: 'Commits the whole index when paths is absent.' },
        allow_foreign_rows: { type: 'boolean', aliases: ['allow_foreign_prd_rows'], description: 'Commits rows another session owns.' },
    },
}
const GIT_FINALIZE_BODY = {
    required: [],
    fields: {
        message: { type: 'string', description: 'Commit message; required unless rev or source_ref is given.' },
        paths: { type: 'array', aliases: ['files'], description: 'Paths to commit.' },
        rev: { type: 'string', aliases: ['source_ref'], description: 'Present, this is the push-only path and commits nothing.' },
        allow_whole_index: { type: 'boolean', description: 'Commits the whole index when paths is absent.' },
    },
}
const GIT_PUSH_BODY = {
    required: [],
    fields: {
        branch: { type: 'string', description: 'Defaults to the current branch, with HEAD resolving to main. A non-main branch without this is gate-denied.' },
        rev: { type: 'string', aliases: ['source_ref'], description: 'Literal sha to push; defaults to HEAD. A symbolic rev is gate-denied.' },
        force: { type: 'boolean', aliases: ['force_with_lease'], description: 'Forces the push.' },
        recover_remote_moved: { type: 'boolean', aliases: ['pull_first'], description: 'Pulls before pushing when the remote moved.' },
        allow_foreign_commits: { type: 'boolean', description: 'Pushes commits another session owns.' },
    },
}
const RECALL_BODY = {
    required: [],
    fields: {
        query: { type: 'string', description: 'Non-empty recall query; required unless key is given.' },
        key: { type: 'string', description: 'Exact memory key, 1-128 chars of [A-Za-z0-9_-].' },
        namespace: { type: 'string', description: 'Namespace to recall from; defaults to the configured one.' },
        limit: { type: 'integer', description: 'Maximum hits.' },
        full: { type: 'boolean', description: 'Returns whole entries instead of excerpts.' },
    },
}
const MEMORIZE_BODY = {
    required: ['text'],
    fields: {
        text: { type: 'string', description: 'Text to store; a bare string body carries it too.' },
        namespace: { type: 'string', description: 'Defaults to "default".' },
        kind: { type: 'string', description: 'Defaults to l0; honoured on routed namespaces only.' },
        discipline: { type: 'string', description: 'Discipline the entry belongs to; checked against the namespace.' },
    },
}

const FETCH_TYPES = {
    url: z.string(),
    prompt: z.string(),
    max_chars: numberLike,
    answer_max_chars: numberLike,
    raw: booleanLike,
    method: z.string(),
    headers: z.record(z.string(), z.string()),
    timeoutMs: numberLike,
}
const FETCH_KEYS = ['url', 'prompt', 'max_chars', 'answer_max_chars', 'raw', 'method', 'headers', 'timeoutMs']
const FETCH_FIELDS = aliasFields('fetch', FETCH_TYPES, FETCH_KEYS)
const FETCH_DESCRIPTION = ` ${FETCH_KEYS.join(', ')} are accepted at the top level and folded into body, so {"url":"<url>"} and body:{"url":"<url>"} are the same call; a key named in both takes its value from body. The reply is the READABLE page, not the transport payload: HTML is converted to markdown before it is returned (head, script, style, svg, nav, header, footer, aside, form and iframe blocks are dropped; article or main wins over the rest of the document), and a body that is not HTML is returned as it arrived. prompt answers that prompt against the converted page and returns the matching passages instead of the page: gm holds no outbound model credential, so answer_mode is always "extractive". max_chars caps the characters returned (default 20000), so one fetch cannot dump a whole page into context; answer_max_chars caps a prompt answer (default 4000). raw:true (aliases full_response, fullResponse) is the escape hatch that returns the original body with no conversion and no prompt answering.`
const FETCH_BODY = {
    required: ['url'],
    fields: {
        url: { type: 'string', description: 'Page to fetch. https:// and http:// only; no whitespace and at most 2048 bytes.' },
        prompt: { type: 'string', description: 'When present the reply answers this against the converted page and returns the matching passages, not the page. Answering is extractive: the passages are verbatim from the page.' },
        max_chars: { type: 'number', description: 'Cap on characters returned. Default 20000, ceiling 4000000.' },
        answer_max_chars: { type: 'number', description: 'Cap on the characters of a prompt answer. Default 4000.' },
        raw: { type: 'boolean', description: 'Return the original response body with no markdown conversion and no prompt answering. Aliases full_response and fullResponse.' },
        method: { type: 'string', description: 'HTTP method; GET when absent.' },
        headers: { type: 'object', description: 'Request headers.' },
        body: { type: 'string', description: 'Request body, sent when method carries one.' },
        timeoutMs: { type: 'number', description: 'Transport timeout in milliseconds. Default 60000, ceiling 600000.' },
        opts: { type: 'object', description: 'Transport options object; method, headers and body are folded into it.' },
    },
}

const WEBSEARCH_TYPES = {
    query: z.string(),
    url: z.string(),
    engine: z.string(),
    limit: numberLike,
    max_results: numberLike,
    allowed_domains: z.array(z.string()),
    blocked_domains: z.array(z.string()),
    prompt: z.string(),
    max_chars: numberLike,
    timeoutMs: numberLike,
}
const WEBSEARCH_KEYS = ['query', 'url', 'engine', 'limit', 'allowed_domains', 'blocked_domains', 'prompt', 'max_chars', 'timeoutMs']
const WEBSEARCH_FIELDS = aliasFields('websearch', WEBSEARCH_TYPES, WEBSEARCH_KEYS)
const WEBSEARCH_DESCRIPTION = ` ${WEBSEARCH_KEYS.join(', ')} are accepted at the top level and folded into body, so {"query":"<query>"} and body:{"query":"<query>"} are the same call; a key named in both takes its value from body. Web discovery stays inside gm: results are fetched over the same fetch port and returned as compact rows (title, url, host, snippet). The built-in engine is duckduckgo, read from https://html.duckduckgo.com/html/, which needs no credential; pass url to read another engine's results page instead. limit caps the rows returned (default 8, ceiling 25; max_results and k are aliases). allowed_domains keeps only results whose host matches, blocked_domains drops them, and both take host suffixes, so "example.com" matches docs.example.com. prompt answers that prompt against the result titles, urls and snippets the same extractive way fetch answers one.`
const WEBSEARCH_BODY = {
    required: [],
    fields: {
        query: { type: 'string', description: 'What to search for; q is an alias. Required unless url is given.' },
        url: { type: 'string', description: 'Read this search engine results page instead of building one from query.' },
        engine: { type: 'string', description: 'duckduckgo, the default and the only built-in engine; any other engine is reached by passing its results page as url.' },
        limit: { type: 'number', description: 'Rows returned. Default 8, ceiling 25; aliases max_results, maxResults and k.' },
        allowed_domains: { type: 'array', description: 'Host suffixes to keep; a non-matching result is dropped.' },
        blocked_domains: { type: 'array', description: 'Host suffixes to drop; a matching result is removed.' },
        prompt: { type: 'string', description: 'Answered against the kept rows instead of returning the whole listing.' },
        max_chars: { type: 'number', description: 'Cap on characters returned. Default 20000.' },
        raw: { type: 'boolean', description: 'Return the raw search page with no result parsing.' },
        timeoutMs: { type: 'number', description: 'Transport timeout in milliseconds. Default 30000, ceiling 600000.' },
    },
}

// One row per registry verb, in the runner's registry order.
const ROWS = [
    { canonical: 'fs_read', aliases: FS_READ_RANGE_ALIASES, fields: FS_READ_RANGE_FIELDS, description: FS_READ_DESCRIPTION, body: FS_READ_BODY },
    { canonical: 'fs_write', body: FS_WRITE_BODY },
    { canonical: 'fs_readdir', description: FS_READ_PATH_RULE, body: FS_READDIR_BODY },
    { canonical: 'fs_stat', body: FS_STAT_BODY },
    { canonical: 'fetch', aliases: FETCH_KEYS, fields: FETCH_FIELDS, description: FETCH_DESCRIPTION, body: FETCH_BODY },
    { canonical: 'websearch', aliases: WEBSEARCH_KEYS, fields: WEBSEARCH_FIELDS, description: WEBSEARCH_DESCRIPTION, body: WEBSEARCH_BODY },
    { canonical: 'env_get' },
    { canonical: 'kv_get' },
    { canonical: 'kv_put' },
    { canonical: 'kv_query' },
    { canonical: 'git_status', ...scopedGitRow('git_status') },
    { canonical: 'branch_status' },
    { canonical: 'git_push', aliases: GIT_PUSH_KEYS, fields: GIT_PUSH_FIELDS, description: GIT_PUSH_DESCRIPTION, body: GIT_PUSH_BODY },
    { canonical: 'git_add' },
    { canonical: 'git_commit', aliases: GIT_COMMIT_KEYS, fields: GIT_COMMIT_FIELDS, description: GIT_COMMIT_DESCRIPTION, body: GIT_COMMIT_BODY },
    { canonical: 'git_amend' },
    { canonical: 'git_finalize', aliases: GIT_COMMIT_KEYS, fields: GIT_COMMIT_FIELDS, description: GIT_COMMIT_DESCRIPTION, body: GIT_FINALIZE_BODY },
    { canonical: 'git_log', ...scopedGitRow('git_log') },
    { canonical: 'git_diff', ...scopedGitRow('git_diff') },
    { canonical: 'git_show', aliases: GIT_SHOW_KEYS, fields: GIT_SHOW_FIELDS, description: GIT_SHOW_DESCRIPTION },
    { canonical: 'git_fetch' },
    { canonical: 'git_branch' },
    { canonical: 'git_remote' },
    { canonical: 'git_checkout', ...scopedGitRow('git_checkout') },
    { canonical: 'git_merge', ...scopedGitRow('git_merge') },
    { canonical: 'git_merge_abort' },
    { canonical: 'git_branch_delete' },
    { canonical: 'git_rm' },
    { canonical: 'git_revert', ...scopedGitRow('git_revert') },
    { canonical: 'git_reset', ...scopedGitRow('git_reset') },
    { canonical: 'git_pull' },
    { canonical: 'git_stash' },
    { canonical: 'git_stash_pop', ...scopedGitRow('git_stash_pop') },
    { canonical: 'git_stash_drop', ...scopedGitRow('git_stash_drop') },
    { canonical: 'git_stash_list' },
    { canonical: 'git_init' },
    { canonical: 'git_poll' },
    { canonical: 'git_worktree' },
    { canonical: 'git_worktree_add', ...scopedGitRow('git_worktree_add') },
    { canonical: 'git_worktree_list' },
    { canonical: 'git_worktree_remove' },
    { canonical: 'git_worktree_prune' },
    { canonical: 'sql_open' },
    { canonical: 'sql_close' },
    { canonical: 'sql_list_dbs' },
    { canonical: 'sql_exec' },
    { canonical: 'sql_query' },
    { canonical: 'sql_smoke' },
    { canonical: 'sql_serialize' },
    { canonical: 'sql_deserialize' },
    { canonical: 'memorize', body: MEMORIZE_BODY },
    { canonical: 'memorize_prune', hyphen: true },
    { canonical: 'recall', body: RECALL_BODY },
    { canonical: 'codeinsight_index' },
    { canonical: 'codeinsight' },
    { canonical: 'codesearch', body: CODESEARCH_BODY },
    { canonical: 'forget' },
    { canonical: 'discipline' },
    { canonical: 'exec_js', body: EXEC_JS_BODY },
    { canonical: 'lang', body: LANG_BODY },
    { canonical: 'python' },
    { canonical: 'bash' },
    { canonical: 'powershell' },
    { canonical: 'ssh' },
    { canonical: 'go' },
    { canonical: 'rust' },
    { canonical: 'c' },
    { canonical: 'cpp' },
    { canonical: 'java' },
    { canonical: 'deno' },
    { canonical: 'transition' },
    { canonical: 'transition_revert', hyphen: true },
    { canonical: 'mutable_resolve', hyphen: true },
    { canonical: 'mutable_add', hyphen: true },
    { canonical: 'mutable_list', hyphen: true },
    { canonical: 'mutable_defer', hyphen: true },
    { canonical: 'dream_policy_register', hyphen: true },
    { canonical: 'dream_evaluator_receipt', hyphen: true },
    { canonical: 'dream_discovery_record', hyphen: true },
    { canonical: 'dream_world_seal', hyphen: true },
    { canonical: 'dream_replay_round', hyphen: true },
    { canonical: 'dream_round', hyphen: true },
    { canonical: 'dream_replay', hyphen: true },
    { canonical: 'dream_replay_cycle', hyphen: true },
    { canonical: 'memorize_fire', hyphen: true },
    { canonical: 'memorize_backfill', hyphen: true },
    { canonical: 'discipline_note', hyphen: true },
    { canonical: 'discipline_check_removal', hyphen: true },
    { canonical: 'discipline_audit', hyphen: true },
    { canonical: 'capability_resolve', hyphen: true },
    { canonical: 'memory_namespace_audit', hyphen: true },
    { canonical: 'codeinsight_namespace_audit', hyphen: true },
    { canonical: 'calculus_model_check', hyphen: true },
    { canonical: 'phase_status', hyphen: true },
    { canonical: 'wait' },
    { canonical: 'sleep' },
    { canonical: 'residual_scan', hyphen: true },
    { canonical: 'claim_audit', hyphen: true },
    { canonical: 'comment_audit', hyphen: true },
    { canonical: 'submodule_check', hyphen: true },
    { canonical: 'component_loader_reconcile', hyphen: true },
    { canonical: 'component_loader_hmr', hyphen: true },
    { canonical: 'auto_recall', hyphen: true },
    { canonical: 'instruction', body: INSTRUCTION_BODY },
    { canonical: 'prd_add', hyphen: true, body: PRD_ADD_BODY },
    { canonical: 'prd_resolve', hyphen: true, body: PRD_RESOLVE_BODY },
    { canonical: 'prd_list', hyphen: true, aliases: PRD_LIST_KEYS, fields: PRD_LIST_FIELDS, description: PRD_LIST_DESCRIPTION, body: PRD_LIST_BODY },
    { canonical: 'prd_defer', hyphen: true },
    { canonical: 'prd_repair', hyphen: true },
    { canonical: 'task_spawn', hyphen: true, body: TASK_SPAWN_BODY },
    { canonical: 'task_list', hyphen: true },
    { canonical: 'task_stop', hyphen: true },
    { canonical: 'task_output', hyphen: true },
    { canonical: 'memorize_continue', hyphen: true },
    { canonical: 'fsm_vendor', hyphen: true },
    { canonical: 'fsm_validate', hyphen: true },
    { canonical: 'predicates_md', hyphen: true },
    { canonical: 'fsm_propose_override', hyphen: true },
    { canonical: 'health' },
    { canonical: 'config_resolve' },
    { canonical: 'config_sync_now', hyphen: true },
    { canonical: 'dataflow_resolve' },
    { canonical: 'status' },
    { canonical: 'close' },
    { canonical: 'filter' },
    { canonical: 'cache_get' },
    { canonical: 'cache_put' },
    { canonical: 'cache_invalidate' },
    { canonical: 'cache_stats' },
    { canonical: 'learn' },
    { canonical: 'chrome' },
    { canonical: 'scan_deps' },
    { canonical: 'code_index' },
    { canonical: 'callers' },
    { canonical: 'callees' },
    { canonical: 'impact' },
    { canonical: 'grep' },
    { canonical: 'ci_status', hyphen: true },
    { canonical: 'prd_status', hyphen: true },
    { canonical: 'prd_block', hyphen: true },
    { canonical: 'pool_brief', hyphen: true },
    { canonical: 'pool_observe', hyphen: true, body: POOL_OBSERVE_BODY },
    { canonical: 'subagent_start', hyphen: true },
    { canonical: 'subagent_end', hyphen: true },
    { canonical: 'memorize_vacuum', hyphen: true },
    { canonical: 'memorize_retention', hyphen: true },
    { canonical: 'tencentdb_compat_probe', hyphen: true },
    { canonical: 'tencentdb_memory_import', hyphen: true },
    { canonical: 'browser_lease_acquire' },
    { canonical: 'browser_lease_release' },
    { canonical: 'browser_lease_status' },
    { canonical: 'nodejs' },
    { canonical: 'javascript' },
    { canonical: 'node' },
    { canonical: 'js' },
    { canonical: 'typescript' },
    { canonical: 'py' },
    { canonical: 'sh' },
    { canonical: 'shell' },
    { canonical: 'zsh' },
    { canonical: 'ps1' },
]

// Normalised rows: every key present, defaults filled in.
export const VERB_TABLE = ROWS.map((row) => ({
    canonical: row.canonical,
    hyphen: row.hyphen === true,
    aliases: row.aliases ?? [],
    fields: row.fields ?? {},
    description: row.description ?? '',
    body: row.body,
}))

// The sentence every runner verb's tool description opens with; gm.list() strips it from its summary.
export function verbDescriptionLead(verb) {
    return `gm spool verb \`${verb}\`, dispatched exactly as the generic gm tool dispatches it. Plain-text verbs take raw_body instead of body.`
}

// The only place a canonical (underscore) name becomes the runner's spelling.
export function runnerVerb(row) {
    return row.hyphen ? row.canonical.replace(/_/g, '-') : row.canonical
}

// Any spelling a caller uses (runner, hyphen or underscore) to its canonical name.
export function canonicalName(spelling) {
    return String(spelling).replace(/-/g, '_')
}

const BY_CANONICAL = new Map(VERB_TABLE.map((row) => [row.canonical, row]))

export function tableRow(spelling) {
    return BY_CANONICAL.get(canonicalName(spelling)) ?? null
}

export const RUNNER_REGISTRY_VERBS = VERB_TABLE.map(runnerVerb)
