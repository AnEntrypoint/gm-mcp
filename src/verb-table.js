import { z } from 'zod'

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

export const FS_READ_RANGE_ALIASES = ['startLine', 'endLine', 'start_line', 'end_line', 'start', 'end', 'count', 'from', 'to', 'offset', 'limit', 'line', 'lines']
const FS_READ_RANGE_PAIR_HELP = 'Pairs are resolved in this order: startLine/endLine (snake_case start_line/end_line is the same pair), then start/end (start/count also works), then from/to, then offset/limit, then line/lines. endLine/end/to is the last line to return; limit/count/lines is a number of lines, not an end line.'
const FS_READ_RANGE_LINE_HELP = {
    startLine: 'First line to return (1-based).',
    endLine: 'Last line to return (1-based, inclusive).',
    start_line: 'First line to return (1-based). Snake_case alias of startLine.',
    end_line: 'Last line to return (1-based, inclusive). Snake_case alias of endLine.',
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
const FS_READ_PATH_RULE = ` "path" is resolved against the cwd you pass (the project root). An absolute path inside that root is rewritten to its project-relative form; an absolute path outside it, and any path carrying "..", is refused, and the refusal names the project-relative form to send instead. allowOutsideRoot:true widens a read verb to another root, never permission to climb out of one, and never applies to fs_write.`
const FS_READDIR_PATH_RULE = ` "path" is resolved against the cwd you pass (the project root), never absolutely: an absolute path is refused even when it is inside that root, and so is any path carrying ".."; the refusal names the project-relative form to send instead. allowOutsideRoot:true widens a read verb to another root, never permission to climb out of one, and never applies to fs_write.`
const FS_READ_DESCRIPTION = ` Line ranges are 1-based and inclusive on both ends: ${FS_READ_RANGE_ALIASES.join(', ')} are accepted at the top level and folded into body, and the same keys inside body work identically. ${FS_READ_RANGE_PAIR_HELP} A range-looking key that is not one of them is an error naming the accepted keys rather than a silent whole file. Without any of them the whole file is returned, unchanged.` + FS_READ_PATH_RULE

const COMMIT_SUBJECT_LIMIT = 50
const commitSubjectCheck = (message, ctx) => {
    const length = [...message.split('\n', 1)[0]].length
    if (length > COMMIT_SUBJECT_LIMIT) ctx.addIssue({ code: 'custom', message: `commit subject is ${length} characters; the limit is ${COMMIT_SUBJECT_LIMIT} characters (the subject is the first line of message). Shorten the first line and resend.` })
}

const GIT_COMMIT_TYPES = {
    message: z.string().superRefine(commitSubjectCheck),
    paths: z.array(z.string()),
    files: z.array(z.string()),
    allow_whole_index: booleanLike,
    untrack: booleanLike,
    recover_remote_moved: booleanLike,
    source_ref: z.string(),
    rev: z.string(),
    ref: z.string(),
    sha: z.string(),
    commit: z.string(),
    stat: booleanLike,
    path: z.string(),
    author_name: z.string(),
    author_email: z.string(),
    claim_only: booleanLike,
    patch: z.string(),
    hunks: z.record(z.string(), z.array(numberLike)),
    offset: numberLike,
    full: booleanLike,
}
const GIT_COMMIT_KEYS = ['message', 'paths', 'files', 'allow_whole_index', 'untrack', 'recover_remote_moved', 'source_ref', 'rev', 'author_name', 'author_email']
const GIT_FINALIZE_FIELDS = aliasFields('git_finalize', GIT_COMMIT_TYPES, GIT_COMMIT_KEYS)
const GIT_COMMIT_VERB_KEYS = ['message', 'paths', 'files', 'allow_whole_index', 'author_name', 'author_email', 'claim_only', 'patch', 'hunks']
const GIT_COMMIT_FIELDS = aliasFields('git_commit', GIT_COMMIT_TYPES, GIT_COMMIT_VERB_KEYS)
const GIT_SINGLE_SHAPE = (verb, keys, sample) => ` ${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'} accepted at the top level and folded into body, so {"${sample}":...} and body:{"${sample}":...} are the same call (one accepted shape for ${verb}); a key named in both takes its value from body.`
const GIT_COMMIT_DESCRIPTION = GIT_SINGLE_SHAPE('git_commit', GIT_COMMIT_VERB_KEYS, 'message') + ` The commit subject (first line of message) must be ${COMMIT_SUBJECT_LIMIT} characters or fewer; a longer subject is refused before the commit runs, naming the ${COMMIT_SUBJECT_LIMIT}-character limit. claim_only:true only claims paths in .gm/lane-claims.json for SESSION_ID (needs a non-empty paths array) and does not commit or publish.`
const GIT_FINALIZE_DESCRIPTION = ` ${GIT_COMMIT_KEYS.join(', ')} are accepted at the top level and folded into body, so {"message":..., "paths":[...]} and body:{"message":..., "paths":[...]} are the same call; a key named in both takes its value from body. The commit subject (first line of message) must be ${COMMIT_SUBJECT_LIMIT} characters or fewer; a longer subject is refused before the commit runs, naming the ${COMMIT_SUBJECT_LIMIT}-character limit. .agentplug* paths are runtime state: add and modify are refused with a reason; untrack:true with only tracked .agentplug* paths commits their index removal (files stay on disk).`

const GIT_PUSH_KEYS = ['rev']
const GIT_PUSH_FIELDS = aliasFields('git_push', GIT_COMMIT_TYPES, GIT_PUSH_KEYS)
const GIT_PUSH_DESCRIPTION = GIT_SINGLE_SHAPE('git_push', GIT_PUSH_KEYS, 'rev') + ' Every other push field (remote, branch, force, recover_remote_moved, allow_foreign_commits) goes under body only.'

const GIT_SHOW_KEYS = ['rev', 'ref', 'sha', 'commit', 'stat', 'path', 'paths', 'files', 'offset', 'full']
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
        limit: z.number(), max_count: z.number(),
        path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC,
    },
    git_diff: {
        range: z.string(), ref: z.string(), rev: z.string(),
        staged: z.boolean(), stat: z.boolean(), limit: z.number(),
        path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC,
    },
    git_revert: { ref: z.string(), paths: z.array(z.string()) },
    git_cherry_pick: { rev: z.string(), ref: z.string() },
    git_reset: { ref: z.string(), rev: z.string(), mode: z.string(), hard: z.boolean(), paths: z.array(z.string()), files: z.array(z.string()) },
    git_checkout: { ref: z.string(), create: z.boolean(), path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC },
    git_merge: { ref: z.string(), ff_only: z.boolean(), message: z.string() },
    git_stash_pop: { ref: z.string() },
    git_stash_drop: { ref: z.string() },
    git_worktree_add: { ref: z.string(), rev: z.string(), commit: z.string(), start_point: z.string(), path: z.string(), create: z.boolean(), allowOutsideRoot: z.boolean() },
    git_status: { path: GIT_PATHSPEC, paths: GIT_PATHSPEC, files: GIT_PATHSPEC, summary: z.boolean(), limit: z.number(), eol: z.boolean() },
    git_pull: { remote: z.string(), branch: z.string(), ff_only: booleanLike, rebase: booleanLike, autostash: booleanLike, user_name: z.string(), author_name: z.string(), user_email: z.string(), author_email: z.string() },
    git_rewrite_authors: { apply: booleanLike, confirm: z.string(), since: z.string(), author_name: z.string(), author_email: z.string() },
}

const ZOD_BODY_TYPE_NAMES = { ZodString: 'string', ZodBoolean: 'boolean', ZodNumber: 'number', ZodArray: 'array' }
function zodBodyType(zt) {
    let t = zt
    while (t._def.innerType) t = t._def.innerType
    if (t._def.options) return t._def.options.map(zodBodyType).join('|')
    return ZOD_BODY_TYPE_NAMES[t._def.typeName] ?? 'any'
}

function scopedGitRow(verb) {
    const types = GIT_SCOPED_TYPES[verb]
    const keys = Object.keys(types)
    const body = {
        required: [],
        fields: Object.fromEntries(keys.map((key) => [key, { type: zodBodyType(types[key]), description: `${key} body field of ${verb}; a dropped one falls back to the verb's own default.` }])),
    }
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
        body,
        description: verb === 'git_reset'
            ? description + ' hard:true is the boolean form of mode:"hard" and rev is an alias of ref; paths scope the index only, so hard:true together with paths is refused. mode accepts soft|mixed|hard and hard must be a boolean -- anything else is refused with error_code invalid_args, never coerced to a default. Every ok reply carries mode, hard, reset_to and scope, so the operation that ran is readable without re-reading the repo.'
            : verb === 'git_log'
            ? description + ' When several count keys are sent, limit wins, then max_count.'
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
        timeoutMs: { type: 'integer', description: 'Wall-clock budget for the child in milliseconds (floor 100, ceiling 900000, default 300000). Sent as a leading timeoutMs= line of the raw body. Above 600000 the caller wait stops at the 600000 ms poll ceiling (timeout_seconds max 600): the timed-out reply then carries exec_limit_ms (the child budget) and poll_timeout_ceiling_ms (the wait) as separate fields, and resume_task keeps waiting on the same dispatch.' },
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
const SESSION_HANDOVER_BODY = {
    required: ['session_id'],
    fields: {
        session_id: { type: 'string', aliases: ['SESSION_ID', 'sessionId'], description: 'Session that takes ownership. Required in the body: the envelope session id is not used, so a body without it is refused and the owner is unchanged.' },
    },
}
const PRD_ADD_BODY = {
    required: [],
    fields: {
        id: { type: 'string', aliases: ['prd_id', 'slug'], description: 'Row id. Absent, it is slugged from subject, title, name, task, goal, description or notes. A row id is a claim until prd-list with that id resolves it.' },
        subject: { type: 'string', description: 'What the row asserts. Persisted verbatim, so the accepted subject spellings (title, name, task, goal, description, notes) land on the row as written.' },
        description: { type: 'string', description: 'Long-form row prose: what the row asserts and why. Persisted on the row and served by prd-list and {"full":true}.' },
        acceptance_criteria: { type: 'string', description: 'What closes the row. Persisted on the row and served by prd-list and {"full":true}.' },
        witness_plan: { type: 'string', description: 'The observation that would close the row. Persisted on the row and served by prd-list and {"full":true}.' },
        status: { type: 'string', enum: ['pending', 'ready', 'completed', 'blocked'], description: 'Row status; defaults to pending.' },
        blockedBy: { type: 'array', description: 'Row ids this row waits on.' },
        overwrite: { type: 'boolean', description: 'Rescopes an existing row; refused when that row is closed.' },
        repair: { type: 'boolean', description: 'Repairs the PRD store before the add.' },
        owner: { type: 'string', description: 'Accountable lane or session that must act on the finding. Defaults to the filer session_id.' },
        disposition: { type: 'string', enum: ['open', 'accepted', 'rejected', 'deferred'], description: 'Inspection disposition of the finding; a reason belongs in description.' },
        recheck_by: { type: 'string', description: 'Session that re-checks the finding; must differ from owner.' },
    },
}
const PRD_ADD_TYPES = {
    id: z.string(),
    subject: z.string(),
    description: z.string(),
    acceptance_criteria: z.string(),
    witness_plan: z.string(),
    status: z.enum(['pending', 'ready', 'completed', 'blocked']),
    blockedBy: z.array(z.string()),
    overwrite: booleanLike,
    repair: booleanLike,
    owner: z.string(),
    disposition: z.enum(['open', 'accepted', 'rejected', 'deferred']),
    recheck_by: z.string(),
}
const PRD_ADD_KEYS = ['id', 'subject', 'description', 'acceptance_criteria', 'witness_plan', 'status', 'blockedBy', 'overwrite', 'repair', 'owner', 'disposition', 'recheck_by']
const PRD_ADD_FIELDS = aliasFields('prd_add', PRD_ADD_TYPES, PRD_ADD_KEYS)
const PRD_ADD_DESCRIPTION = ` ${PRD_ADD_KEYS.join(', ')} are accepted at the top level and folded into body, so {"subject":"<row intent>","description":"<row prose>"} and body:{"subject":"...","description":"..."} are the same call; a key named in both takes its value from body. description is the row prose: it is persisted on the row as description, never as the dispatch body. Without an id or any subject/title/name/task/goal/description/notes text the row is refused.`
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
        status: { type: 'string', enum: ['pending', 'ready', 'completed', 'blocked', 'all'], description: 'Keeps only rows of this status; all pages every status.' },
        limit: { type: 'integer', description: 'Maximum rows returned.' },
        offset: { type: 'integer', description: 'First row to return (0-based); use next_offset of the previous page.' },
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
const CODEINSIGHT_ACTIONS = ['overview', 'status', 'sync', 'outline', 'find', 'callers', 'callees', 'impact', 'hotspots', 'orphans', 'imports', 'importers', 'cycles', 'coupling', 'complexity', 'duplicates', 'tests']
const CODEINSIGHT_BODY = {
    required: [],
    fields: {
        verb: { type: 'string', aliases: ['action', 'mode'], enum: CODEINSIGHT_ACTIONS, description: 'Which answer to build. Omitting verb/action/mode is the index overview, so a caller that meant "callers" and dropped the selector reads the whole-index stats instead of an error. callers/callees/impact/tests need `symbol`; outline/imports/importers need `path`; find needs `symbol`.' },
        symbol: { type: 'string', aliases: ['name'], description: 'Symbol callers/callees/impact/tests/find resolve. Call edges are keyed by unqualified name, so a qualified "pkg.Name" with no edge of its own is answered from its last dotted segment and the reply names both spellings.' },
        path: { type: 'string', aliases: ['file', 'path_prefix'], description: 'File for outline/imports/importers, or a path scope for find/orphans/coupling. callers/callees/impact/tests refuse it: edges are keyed by unqualified names, so use codesearch for path-scoped call sites.' },
        root: { type: 'string', aliases: ['projectPath', 'cwd'], description: 'Answers for another project root.' },
        limit: { type: 'integer', aliases: ['k'], description: 'Row cap; default 25, maximum 200.' },
        kind: { type: 'string', description: 'find only: symbol kind filter.' },
        max_depth: { type: 'integer', description: 'impact only: call hops to walk; default 3, clamped to 1-10.' },
        direction: { type: 'string', enum: ['callers', 'upstream', 'callees', 'downstream'], description: 'impact only: "callees"/"downstream" walks what the symbol depends on; anything else walks its callers. The gm.impact verb itself defaults to callees.' },
        through_ambiguous: { type: 'boolean', description: 'impact only: keep walking through ambiguous names instead of stopping at them.' },
        language: { type: 'string', aliases: ['lang'], description: 'orphans only: language filter.' },
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
        output: { type: 'string', enum: ['matches', 'full', 'compact', 'content', 'files', 'count'], description: 'Output shape. "compact" is path:line: trimmed text and "content" is the same shape under grep\'s name for it; "full" is an alias of "matches".' },
        case_insensitive: { type: 'boolean', aliases: ['ignore_case'], description: 'Folds case. Literal and regex are case-sensitive by default (a mixed-case match is missed unless this is true); the reply echoes case_insensitive.' },
        whole_word: { type: 'boolean', description: 'Whole-word match; refused in filename mode.' },
        comments_only: { type: 'boolean', aliases: ['comments'], description: 'Scans comments only; refused in filename mode.' },
        verbatim: { type: 'boolean', description: 'Forces combine to phrase.' },
        docs: { type: 'boolean', description: 'Documentation scan; must be a boolean.' },
        refresh: { type: 'boolean', aliases: ['no_cache', 'force_disk'], description: 'Bypasses the cache.' },
        no_ignore: { type: 'boolean', aliases: ['include_ignored', 'exhaustive'], description: 'Includes ignored paths.' },
    },
}
const GREP_UNACCEPTED_CODESEARCH_FIELDS = ['max_chars', 'timeout_ms', 'root', 'combine', 'output', 'verbatim', 'docs']
const GREP_BODY = {
    required: [],
    fields: {
        ...Object.fromEntries(Object.entries(CODESEARCH_BODY.fields).filter(([name]) => !GREP_UNACCEPTED_CODESEARCH_FIELDS.includes(name))),
        mode: { type: 'string', enum: ['pattern', 'literal', 'regex', 'comments', 'content', 'files', 'files_with_matches', 'count'], description: 'grep mode: "pattern" (default) reads regex metacharacters as a regex, "literal" matches verbatim, "regex" always compiles, "comments" finds comment spans and needs no pattern. An output shape is accepted as mode and sets output_mode.' },
        context: { type: 'number', description: 'Lines of context around each content hit.' },
        output_mode: { type: 'string', aliases: ['outputMode'], enum: ['content', 'files_with_matches', 'count'], description: 'grep output shape: "content" (default) is path:line: text per hit, "files_with_matches" each matching path once, "count" path:count.' },
    },
}
const FS_READ_BODY = {
    required: ['path'],
    fields: {
        path: { type: 'string', description: 'Project-relative path. An absolute path inside the root is rewritten to project-relative; an absolute path outside it, and any path carrying "..", is refused.' },
        allowOutsideRoot: { type: 'boolean', aliases: ['allow_outside_root', 'allowAbsolute'], description: 'Widens the read to another root; never applies to fs_write.' },
        startLine: { type: 'integer', aliases: ['start_line', 'offset'], description: 'First line to return, 1-based. start_line and offset are accepted as aliases.' },
        endLine: { type: 'integer', aliases: ['end_line'], description: 'Last line to return, 1-based and inclusive. end_line is accepted as an alias.' },
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
        author_name: { type: 'string', description: 'Commit author name; defaults to the configured git identity.' },
        author_email: { type: 'string', description: 'Commit author email; defaults to the configured git identity.' },
        patch: { type: 'string', description: 'Hunk-scoped commit: a unified diff against HEAD, committed through a temp index so only its hunks land. Exclusive with hunks; does not combine with paths, files, add_all, amend or allow_empty.' },
        hunks: { type: 'object', description: 'Hunk-scoped commit: {path: [1-based hunk numbers from git diff HEAD -- <path>]}, committed through a temp index. Exclusive with patch; does not combine with paths, files, add_all, amend or allow_empty.' },
    },
}
const GIT_ADD_BODY = {
    required: [],
    fields: {
        paths: { type: 'array', aliases: ['files'], description: 'Pathspecs to stage with git add. Protected gm state paths are refused and named in the refusal.' },
        hunks: { type: 'object', description: 'Refused: git_add stages whole files only, so hunk-scoped staging has no verb. Use git_commit {hunks} to commit named hunks without staging the rest.' },
        patch: { type: 'string', description: 'Refused: git_add stages whole files only, so patch-scoped staging has no verb. Use git_commit {patch} to commit a diff without staging the rest.' },
    },
}

const GIT_SUBMODULE_ADD_BODY = {
    required: ['url', 'path'],
    fields: {
        url: { type: 'string', description: 'https:// URL of the submodule repository (no user:password@, no whitespace).' },
        path: { type: 'string', description: 'Relative path inside the repo root; no leading /, no . .. or .git segment.' },
        branch: { type: 'string', description: 'Optional branch to track (git submodule add -b). Letters, digits, . _ - /; not starting with -.' },
    },
}

const GIT_SUBMODULE_UPDATE_BODY = {
    required: ['path'],
    fields: {
        path: { type: 'string', description: 'Relative path of the submodule inside the repo root; no leading /, no . .. or .git segment.' },
        recursive: { type: 'boolean', description: 'Also initialise nested submodules (git submodule update --recursive).' },
    },
}

const BROWSER_LEASE_BODY = {
    required: ['agent'],
    fields: {
        agent: { type: 'string', description: 'Name of the agent holding or releasing the shared browser lease.' },
        ttl_ms: { type: 'integer', description: 'Lease time-to-live in milliseconds before a silent holder counts as dead.' },
        wait_ms: { type: 'integer', description: 'Milliseconds to wait for the lease before refusing.' },
    },
}

const GIT_FINALIZE_BODY = {
    required: [],
    fields: {
        message: { type: 'string', description: 'Commit message; required unless rev or source_ref is given.' },
        paths: { type: 'array', aliases: ['files'], description: 'Paths to commit.' },
        rev: { type: 'string', aliases: ['source_ref'], description: 'Present, this is the push-only path and commits nothing.' },
        allow_whole_index: { type: 'boolean', description: 'Commits the whole index when paths is absent.' },
        untrack: { type: 'boolean', description: 'Removes the named .agentplug* paths from the index only (git rm --cached semantics; files stay on disk) in a commit that names nothing else, then pushes. Add and modify of .agentplug* stay refused.' },
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
        remote: { type: 'string', description: 'Configured remote name; defaults to origin.' },
    },
}
const CI_LOG_BODY = {
    required: [],
    fields: {
        run_id: { type: 'integer', aliases: ['run'], description: 'GitHub Actions run id to read; ci-status returns one per job. Required unless sha, rev or ref is given.' },
        job_id: { type: 'integer', description: 'Reads only that job\'s log. Without it the whole run is read.' },
        sha: { type: 'string', aliases: ['rev', 'ref'], description: 'Reads the newest run for this commit when run_id is absent.' },
        github_repo: { type: 'string', aliases: ['repo'], description: 'owner/name; defaults to the origin remote of cwd.' },
        job: { type: 'string', description: 'Keeps only lines whose job name matches.' },
        step: { type: 'string', description: 'Keeps only lines whose step name matches.' },
        pattern: { type: 'string', aliases: ['match', 'grep'], description: 'Keeps only lines whose message matches.' },
        mode: { type: 'string', enum: ['literal', 'regex'], description: 'How pattern, job and step match; literal is the default and any other value is refused.' },
        regex: { type: 'boolean', description: 'Shorthand for mode:"regex".' },
        ignore_case: { type: 'boolean', description: 'Folds case in every match.' },
        max_lines: { type: 'integer', description: 'Line cap, 1 through 500, default 40, so a whole multi-job run is never dumped into context.' },
        max_chars: { type: 'integer', description: 'Character cap, 1 through 40000, default 8000.' },
        failed_only: { type: 'boolean', description: 'Returns failures per failing step: the error lines of each step, with a tail when tail_lines is set.' },
        tail_lines: { type: 'integer', description: 'Trailing lines kept per failing step when failed_only is set; the guest default is 10 and its ceiling is 100.' },
    },
}
const FETCH_TYPES = {
    url: z.string(),
    query: z.string(),
    q: z.string(),
    search: z.string(),
    backend: z.string(),
    engine: z.string(),
    count: numberLike,
    limit: numberLike,
    max_results: numberLike,
    k: numberLike,
    n: numberLike,
    kind: z.string(),
    wiki: z.string(),
    user: z.string(),
    repo: z.string(),
    stars: z.union([z.string(), z.number()]),
    allowed_domains: z.array(z.string()),
    blocked_domains: z.array(z.string()),
    prompt: z.string(),
    max_chars: numberLike,
    answer_max_chars: numberLike,
    offset: numberLike,
    length: numberLike,
    len: numberLike,
    start_line: numberLike,
    startLine: numberLike,
    end_line: numberLike,
    endLine: numberLike,
    lines: numberLike,
    line_count: numberLike,
    lineCount: numberLike,
    raw: booleanLike,
    method: z.string(),
    headers: z.record(z.string(), z.string()),
    timeoutMs: numberLike,
}
const FETCH_KEYS = ['url', 'query', 'q', 'search', 'backend', 'engine', 'count', 'limit', 'max_results', 'k', 'n', 'kind', 'wiki', 'user', 'repo', 'stars', 'allowed_domains', 'blocked_domains', 'prompt', 'max_chars', 'answer_max_chars', 'offset', 'length', 'len', 'start_line', 'startLine', 'end_line', 'endLine', 'lines', 'line_count', 'lineCount', 'raw', 'method', 'headers', 'timeoutMs']
const FETCH_FIELDS = aliasFields('fetch', FETCH_TYPES, FETCH_KEYS)
const FETCH_DESCRIPTION = ` ${FETCH_KEYS.join(', ')} are accepted at the top level and folded into body, so {"url":"<url>"} and body:{"url":"<url>"} are the same call; a key named in both takes its value from body. The reply is the READABLE page, not the transport payload: HTML is converted to markdown before it is returned (head, script, style, svg, nav, header, footer, aside, form and iframe blocks are dropped; article or main wins over the rest of the document), and a body that is not HTML is returned as it arrived. query (aliases q, search) with no url turns the call into a web search on the same port, walking the same backends websearch walks -- the structured JSON backends github, hn and wikipedia first, then the keyless html engines -- and backend (alias engine) picks the order; kind, wiki, user, repo and stars tune the github and wikipedia backends, count (aliases limit, max_results, k, n) caps the hits and allowed_domains/blocked_domains filter every backend. prompt answers that prompt against the converted page and returns the matching passages instead of the page: gm holds no outbound model credential, so answer_mode is always "extractive". max_chars caps the characters returned (default 6000), so one fetch cannot dump a whole page into context; answer_max_chars caps a prompt answer (default 4000). offset/length (characters, offset 0-based) or start_line/end_line (1-based, inclusive) or start_line plus lines read one bounded page of that document instead of its head, with offset/length/total_chars/has_more/next_offset or start_line/end_line/total_lines/has_more/next_start_line on the reply, so a document longer than the cap is readable end to end; a page defaults to 24000 characters and never mixes character keys with line keys. A prompt reply carries answer_status: matched, no_match (the page has text and none of it scored), or empty_source (no text was retrieved or converted, which is a failure and comes back ok:false with error_code fetch_empty_source). raw:true (aliases full_response, fullResponse) is the escape hatch that returns the original body with no conversion and no prompt answering.`
const FETCH_BODY = {
    required: [],
    fields: {
        url: { type: 'string', description: 'Page to fetch. https:// and http:// only; no whitespace and at most 2048 bytes. Required unless query is given.' },
        query: { type: 'string', description: 'With no url, turns the call into a web search on the same port; aliases q and search.' },
        backend: { type: 'string', description: 'Backend order for a search: github, hn, wikipedia, duckduckgo, mojeek, bing, searxng, brave, marginalia, or a comma-separated list. Alias engine; GM_SEARCH_BACKEND sets the same order.' },
        kind: { type: 'string', description: 'The github endpoint for a search: repos (the default), code or issues.' },
        wiki: { type: 'string', description: 'MediaWiki host for the wikipedia backend; default en.wikipedia.org.' },
        user: { type: 'string', description: 'github qualifier appended to a search query as user:<value>.' },
        repo: { type: 'string', description: 'github qualifier appended to a search query as repo:<value>.' },
        stars: { type: 'string', description: 'github qualifier appended to a search query as stars:>=<value>.' },
        count: { type: 'number', description: 'Hits returned by a search. Default 10, ceiling 50; aliases limit, max_results, k and n.' },
        allowed_domains: { type: 'array', description: 'Host suffixes a search result must match to be kept.' },
        blocked_domains: { type: 'array', description: 'Host suffixes that drop a search result.' },
        prompt: { type: 'string', description: 'When present the reply answers this against the converted page and returns the matching passages, not the page. Answering is extractive: the passages are verbatim from the page.' },
        max_chars: { type: 'number', description: 'Cap on characters returned. Default 6000, ceiling 4000000.' },
        answer_max_chars: { type: 'number', description: 'Cap on the characters of a prompt answer. Default 4000.' },
        offset: { type: 'number', description: '0-based character offset of a bounded page; with no length it reads to the end of the document. Never combine with start_line/end_line.' },
        length: { type: 'number', description: 'Characters to return from offset (alias len). A paged read defaults to 24000 characters, not 6000, and an explicit max_chars still caps it.' },
        start_line: { type: 'number', description: 'First line of a bounded page, 1-based (alias startLine).' },
        end_line: { type: 'number', description: 'Last line of a bounded page, 1-based and inclusive (alias endLine).' },
        lines: { type: 'number', description: 'Line count to read from start_line; aliases line_count and lineCount.' },
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
    q: z.string(),
    url: z.string(),
    engine: z.string(),
    backend: z.string(),
    kind: z.string(),
    wiki: z.string(),
    user: z.string(),
    repo: z.string(),
    stars: z.union([z.string(), z.number()]),
    limit: numberLike,
    max_results: numberLike,
    maxResults: numberLike,
    k: numberLike,
    allowed_domains: z.array(z.string()),
    blocked_domains: z.array(z.string()),
    prompt: z.string(),
    max_chars: numberLike,
    answer_max_chars: numberLike,
    raw: booleanLike,
    timeoutMs: numberLike,
}
const WEBSEARCH_KEYS = ['query', 'q', 'url', 'engine', 'backend', 'kind', 'wiki', 'user', 'repo', 'stars', 'limit', 'max_results', 'maxResults', 'k', 'allowed_domains', 'blocked_domains', 'prompt', 'max_chars', 'answer_max_chars', 'raw', 'timeoutMs']
const WEBSEARCH_FIELDS = aliasFields('websearch', WEBSEARCH_TYPES, WEBSEARCH_KEYS)
const WEBSEARCH_DESCRIPTION = ` ${WEBSEARCH_KEYS.join(', ')} are accepted at the top level and folded into body, so {"query":"<query>"} and body:{"query":"<query>"} are the same call; a key named in both takes its value from body. Web discovery stays inside gm: results are fetched over the same fetch port and returned as compact rows (title, url, host, snippet, source). One call walks the structured JSON backends FIRST -- github, hn, wikipedia -- because each answers machine-readable JSON with no credential and no challenge page, and only then falls back to the keyless html engines -- duckduckgo, mojeek, bing, searxng, brave, marginalia -- which answer a CAPTCHA or consent page to some clients; it stops at the first backend that parses into hits, 7 at most, and every attempt is reported in attempts. engine (alias backend) picks one or a comma-separated list; url reads a results page of your own, and a url answering JSON is parsed as JSON. kind selects the github endpoint: repos (the default), code or issues; user, repo and stars become github qualifiers and a qualifier written into the query (user:lanmower, repo:owner/name, stars:>100) is passed through. wiki names the MediaWiki host, default en.wikipedia.org. limit caps the rows returned (default 8, ceiling 25; max_results, maxResults and k are aliases). allowed_domains keeps only results whose host matches and blocked_domains drops them, both host suffixes, and both filter every backend, so a backend whose rows are all filtered out does not stop the walk. prompt answers that prompt against the result titles, urls and snippets the same extractive way fetch answers one.`
const WEBSEARCH_BODY = {
    required: [],
    fields: {
        query: { type: 'string', description: 'What to search for; q is an alias. Required unless url is given.' },
        url: { type: 'string', description: 'Read this search results page instead of building one from query; a url answering JSON is parsed as JSON.' },
        engine: { type: 'string', description: 'Backend order: github, hn, wikipedia, duckduckgo, mojeek, bing, searxng, brave, marginalia, or a comma-separated list. Alias backend; GM_SEARCH_BACKEND sets the same order. The JSON backends are tried first.' },
        kind: { type: 'string', description: 'The github endpoint: repos (the default), code or issues.' },
        wiki: { type: 'string', description: 'MediaWiki host for the wikipedia backend; default en.wikipedia.org. Any MediaWiki install works.' },
        user: { type: 'string', description: 'github qualifier appended to q as user:<value>; a user: qualifier already in the query is passed through.' },
        repo: { type: 'string', description: 'github qualifier appended to q as repo:<value>; a repo: qualifier already in the query is passed through.' },
        stars: { type: 'string', description: 'github qualifier appended to q as stars:>=<value>; a stars: qualifier already in the query is passed through.' },
        limit: { type: 'number', description: 'Rows returned. Default 8, ceiling 25; aliases max_results, maxResults and k.' },
        allowed_domains: { type: 'array', description: 'Host suffixes to keep; a non-matching result is dropped. Applied to every backend.' },
        blocked_domains: { type: 'array', description: 'Host suffixes to drop; a matching result is removed. Applied to every backend.' },
        prompt: { type: 'string', description: 'Answered against the kept rows instead of returning the whole listing.' },
        max_chars: { type: 'number', description: 'Cap on characters returned. Default 20000.' },
        answer_max_chars: { type: 'number', description: 'Cap on the characters of a prompt answer. Default 4000.' },
        raw: { type: 'boolean', description: 'Return the raw search page with no result parsing.' },
        timeoutMs: { type: 'number', description: 'Transport timeout in milliseconds. Default 30000, ceiling 600000.' },
    },
}

const PRD_WITNESS_REQUEST_BODY = {
    required: ['id'],
    fields: {
        id: { type: 'string', aliases: ['prd_id', 'row'], description: 'PRD row id that needs a verifier witness.' },
        note: { type: 'string', aliases: ['expect', 'observe'], description: 'What the verifier must observe.' },
    },
}

const EXPANSION_AUDIT_BODY = {
    required: [],
    fields: {
        scope: { type: 'string', aliases: ['goal', 'subject'], description: 'What the sweep covered. Required unless list is true.' },
        rows_added: { type: 'number', description: 'Rows this sweep filed with prd-add. Required unless list is true.' },
        unknowns_added: { type: 'number', description: 'Unknowns this sweep filed with mutable-add. Required unless list is true.' },
        result: { type: 'string', enum: ['fixed_point', 'expanded'], description: 'Optional claim; refused when it disagrees with the counts (both zero = fixed_point).' },
        note: { type: 'string', description: 'Free text kept on the audit entry.' },
        list: { type: 'boolean', description: 'true reads .gm/expansion-audit.jsonl instead of appending.' },
        limit: { type: 'number', description: 'With list, how many latest entries to return (default 5).' },
    },
}

const REGISTRY_ROWS = [
    { canonical: 'fs_read', aliases: FS_READ_RANGE_ALIASES, fields: FS_READ_RANGE_FIELDS, description: FS_READ_DESCRIPTION, body: FS_READ_BODY },
    { canonical: 'fs_write', body: FS_WRITE_BODY },
    { canonical: 'fs_readdir', description: FS_READDIR_PATH_RULE, body: FS_READDIR_BODY },
    { canonical: 'fs_stat', body: FS_STAT_BODY },
    { canonical: 'fetch', aliases: FETCH_KEYS, fields: FETCH_FIELDS, description: FETCH_DESCRIPTION, body: FETCH_BODY },
    { canonical: 'websearch', aliases: WEBSEARCH_KEYS, fields: WEBSEARCH_FIELDS, description: WEBSEARCH_DESCRIPTION, body: WEBSEARCH_BODY },
    { canonical: 'web_search', aliases: WEBSEARCH_KEYS, fields: WEBSEARCH_FIELDS, description: WEBSEARCH_DESCRIPTION, body: WEBSEARCH_BODY },
    { canonical: 'env_get' },
    { canonical: 'kv_get' },
    { canonical: 'kv_put' },
    { canonical: 'kv_query' },
    { canonical: 'git_status', ...scopedGitRow('git_status') },
    { canonical: 'branch_status' },
    { canonical: 'git_push', aliases: GIT_PUSH_KEYS, fields: GIT_PUSH_FIELDS, description: GIT_PUSH_DESCRIPTION, body: GIT_PUSH_BODY },
    { canonical: 'git_add', body: GIT_ADD_BODY },
    { canonical: 'git_commit', aliases: GIT_COMMIT_VERB_KEYS, fields: GIT_COMMIT_FIELDS, description: GIT_COMMIT_DESCRIPTION, body: GIT_COMMIT_BODY },
    { canonical: 'git_amend' },
    { canonical: 'git_rewrite_authors', ...scopedGitRow('git_rewrite_authors') },
    { canonical: 'git_finalize', aliases: GIT_COMMIT_KEYS, fields: GIT_FINALIZE_FIELDS, description: GIT_FINALIZE_DESCRIPTION, body: GIT_FINALIZE_BODY },
    { canonical: 'git_log', ...scopedGitRow('git_log') },
    { canonical: 'git_diff', ...scopedGitRow('git_diff') },
    { canonical: 'git_show', aliases: GIT_SHOW_KEYS, fields: GIT_SHOW_FIELDS, description: GIT_SHOW_DESCRIPTION },
    { canonical: 'git_fetch' },
    { canonical: 'git_branch' },
    { canonical: 'git_remote' },
    { canonical: 'git_submodule_add', description: 'Add a git submodule: git submodule add [-b branch] -- url path. Stages .gitmodules and the gitlink; does not commit. Protected-path gate as git_add.', body: GIT_SUBMODULE_ADD_BODY },
    { canonical: 'git_submodule_update', description: 'Initialise and check out a submodule at the parent gitlink: git submodule update --init [--recursive] -- path. Protected-path gate as git_add.', body: GIT_SUBMODULE_UPDATE_BODY },
    { canonical: 'git_checkout', ...scopedGitRow('git_checkout') },
    { canonical: 'git_merge', ...scopedGitRow('git_merge') },
    { canonical: 'git_merge_abort' },
    { canonical: 'git_branch_delete' },
    { canonical: 'git_rm' },
    { canonical: 'git_revert', ...scopedGitRow('git_revert') },
    { canonical: 'git_cherry_pick', ...scopedGitRow('git_cherry_pick') },
    { canonical: 'git_reset', ...scopedGitRow('git_reset') },
    { canonical: 'git_pull', ...scopedGitRow('git_pull') },
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
    { canonical: 'codeinsight_index' },
    { canonical: 'codeinsight', body: CODEINSIGHT_BODY },
    { canonical: 'codesearch', body: CODESEARCH_BODY },
    { canonical: 'code_search', body: CODESEARCH_BODY },
    { canonical: 'search', body: CODESEARCH_BODY },
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
    { canonical: 'discipline_note', hyphen: true },
    { canonical: 'discipline_check_removal', hyphen: true },
    { canonical: 'discipline_audit', hyphen: true },
    { canonical: 'capability_resolve', hyphen: true },
    { canonical: 'codeinsight_namespace_audit', hyphen: true },
    { canonical: 'calculus_model_check', hyphen: true },
    { canonical: 'phase_status', hyphen: true },
    { canonical: 'session_handover', hyphen: true, body: SESSION_HANDOVER_BODY },
    { canonical: 'wait' },
    { canonical: 'sleep' },
    { canonical: 'residual_scan', hyphen: true },
    { canonical: 'claim_audit', hyphen: true },
    { canonical: 'comment_audit', hyphen: true },
    { canonical: 'submodule_check', hyphen: true },
    { canonical: 'component_loader_reconcile', hyphen: true },
    { canonical: 'component_loader_hmr', hyphen: true },
    { canonical: 'instruction', body: INSTRUCTION_BODY },
    { canonical: 'prd_add', hyphen: true, aliases: PRD_ADD_KEYS, fields: PRD_ADD_FIELDS, description: PRD_ADD_DESCRIPTION, body: PRD_ADD_BODY },
    { canonical: 'prd_resolve', hyphen: true, body: PRD_RESOLVE_BODY },
    { canonical: 'prd_list', hyphen: true, aliases: PRD_LIST_KEYS, fields: PRD_LIST_FIELDS, description: PRD_LIST_DESCRIPTION, body: PRD_LIST_BODY },
    { canonical: 'prd_defer', hyphen: true },
    { canonical: 'prd_witness_request', hyphen: true, description: 'Ask a separate verifier session to witness a PRD row: records the request on the row with the requesting session.', body: PRD_WITNESS_REQUEST_BODY },
    { canonical: 'expansion_audit', hyphen: true, description: 'Record one traversal sweep (scope, rows_added, unknowns_added) in .gm/expansion-audit.jsonl; both counts zero with no open rows or unknowns is the verifiable end state. {list:true} reads the log.', body: EXPANSION_AUDIT_BODY },
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
    { canonical: 'chrome', description: 'The CDP crawl as a named verb: the same plain-text body as crawl, always on the cdp engine with a headful window. Answers the crawl host JSON object. Plain-text body, so pass raw_body.' },
    { canonical: 'crawl' },
    { canonical: 'scan_deps' },
    { canonical: 'code_index' },
    { canonical: 'callers', body: CODEINSIGHT_BODY },
    { canonical: 'callees', body: CODEINSIGHT_BODY },
    { canonical: 'impact', body: CODEINSIGHT_BODY },
    { canonical: 'grep', body: GREP_BODY },
    { canonical: 'rg', body: GREP_BODY },
    { canonical: 'ci_status', hyphen: true },
    { canonical: 'ci_log', hyphen: true, body: CI_LOG_BODY },
    { canonical: 'prd_block', hyphen: true },
    { canonical: 'pool_brief', hyphen: true },
    { canonical: 'pool_observe', hyphen: true, body: POOL_OBSERVE_BODY },
    { canonical: 'subagent_start', hyphen: true },
    { canonical: 'subagent_end', hyphen: true },
    { canonical: 'browser_lease_acquire', description: 'Acquire the shared browser lease for body.agent, waiting up to 600 s. Answers port, chrome_pid and lease_file. A holder whose heartbeat is older than 120 s counts as dead.', body: BROWSER_LEASE_BODY },
    { canonical: 'browser_lease_release', description: 'Release the shared browser lease held by body.agent. Answers the lease state with released set to that agent.', body: BROWSER_LEASE_BODY },
    { canonical: 'browser_lease_status', description: 'Read the shared browser lease state. Takes no agent field; answers the lease state alone.' },
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

export const VERB_TABLE = REGISTRY_ROWS.map((row) => ({
    canonical: row.canonical,
    hyphen: row.hyphen === true,
    aliases: row.aliases ?? [],
    fields: row.fields ?? {},
    description: row.description ?? '',
    body: row.body,
}))

export function verbDescriptionLead(verb) {
    return `gm spool verb \`${verb}\`, dispatched exactly as the generic gm tool dispatches it. Plain-text verbs take raw_body instead of body.`
}

export function runnerVerb(row) {
    return row.hyphen ? row.canonical.replace(/_/g, '-') : row.canonical
}

export function canonicalName(spelling) {
    return String(spelling).replace(/-/g, '_')
}

const BY_CANONICAL = new Map(VERB_TABLE.map((row) => [row.canonical, row]))

export function tableRow(spelling) {
    return BY_CANONICAL.get(canonicalName(spelling)) ?? null
}

export function wireVerb(spelling) {
    const row = tableRow(spelling)
    return row ? runnerVerb(row) : String(spelling)
}

export const RUNNER_REGISTRY_VERBS = VERB_TABLE.map(runnerVerb)
