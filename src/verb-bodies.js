export const EXEC_LANGS = ['nodejs', 'js', 'python', 'py', 'bash', 'sh', 'shell', 'powershell', 'ps1', 'deno', 'agent', 'claude']

const LANG_FIELD = {
    type: 'string',
    enum: EXEC_LANGS,
    description: 'Runtime that runs `code`. Any other value answers "unsupported lang: <value>"; go, rust, c, cpp and java are registered verb stems with no runtime arm, so dispatch them as the verb instead of as body.lang.',
}

const VERB_BODY_SCHEMAS = {
    'task-spawn': {
        required: ['lang', 'code'],
        fields: {
            lang: LANG_FIELD,
            code: { type: 'string', aliases: ['body'], description: 'Program text or, for lang agent/claude, the prompt.' },
            timeoutMs: { type: 'integer', description: 'Clamped to [1000, cap]; cap defaults to 1800000.' },
            cwd: { type: 'string', description: 'Directory the job runs in; defaults to the dispatch root.' },
            permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: 'Only for lang agent/claude; defaults to bypassPermissions.' },
        },
    },
    lang: {
        required: ['lang', 'code'],
        fields: {
            lang: LANG_FIELD,
            code: { type: 'string', aliases: ['body'], description: 'Program text or, for lang agent/claude, the prompt.' },
            timeoutMs: { type: 'integer', description: 'Clamped to [1000, cap].' },
            cwd: { type: 'string', description: 'Directory the job runs in.' },
        },
    },
    exec_js: {
        required: ['code'],
        fields: {
            code: { type: 'string', aliases: ['body'], description: 'JavaScript body, run as nodejs. Pass it as the top-level raw_body argument: a JSON object body is refused. A leading "timeoutMs=<ms>" line sets the budget (floor 100, ceiling 900000).' },
            cwd: { type: 'string', description: 'Directory the script runs in.' },
        },
    },
    instruction: {
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
    },
    'prd-add': {
        required: [],
        fields: {
            id: { type: 'string', aliases: ['prd_id', 'slug'], description: 'Row id. Absent, it is slugged from subject, title, name, task, goal, description or notes. A row id is a claim until prd-list with that id resolves it.' },
            subject: { type: 'string', description: 'What the row asserts.' },
            status: { type: 'string', enum: ['pending', 'ready', 'completed', 'blocked'], description: 'Row status; defaults to pending.' },
            blockedBy: { type: 'array', description: 'Row ids this row waits on.' },
            overwrite: { type: 'boolean', description: 'Rescopes an existing row; refused when that row is closed.' },
            repair: { type: 'boolean', description: 'Repairs the PRD store before the add.' },
        },
    },
    'prd-resolve': {
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
    },
    'prd-list': {
        required: [],
        fields: {
            id: { type: 'string', aliases: ['ids', 'row_id'], description: 'Resolves one row. prd-list is not a selector beyond this.' },
            status: { type: 'string', enum: ['pending', 'ready', 'completed', 'blocked'], description: 'Keeps only rows of this status.' },
            limit: { type: 'integer', description: 'Maximum rows returned.' },
            full: { type: 'boolean', aliases: ['verbose', 'bodies'], description: 'Expands row bodies; the default is full when an id filter was given.' },
            brief: { type: 'boolean', aliases: ['compact'], description: 'Compresses rows.' },
        },
    },
    'pool-observe': {
        required: [],
        fields: {
            live: { type: 'integer', description: 'Live subagent count (the ListAgents count).' },
            held: { type: 'array', description: 'Row ids this session holds.' },
            refusal: { type: 'string', description: 'A spawn refusal text, so the pool can record the ceiling.' },
        },
    },
    codesearch: {
        required: ['query'],
        fields: {
            query: { type: 'string', aliases: ['pattern'], description: 'Non-empty needle. Passing query and pattern with different values is refused.' },
            mode: { type: 'string', enum: ['dual', 'literal', 'regex', 'filename', 'comments'], description: 'An unknown mode is refused. literal, regex and filename refuse any field outside the exhaustive set.' },
            k: { type: 'integer', aliases: ['max_results', 'maxResults', 'limit', 'head_limit'], description: 'Result cap; 0 means unlimited for literal, regex and filename (refused for dual); conflicting values are refused.' },
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
    },
    fs_read: {
        required: ['path'],
        fields: {
            path: { type: 'string', description: 'Project-relative path. An absolute path is refused even inside the root, and so is any path carrying "..".' },
            allowOutsideRoot: { type: 'boolean', aliases: ['allow_outside_root', 'allowAbsolute'], description: 'Widens the read to another root; never applies to fs_write.' },
            startLine: { type: 'integer', description: 'First line to return, 1-based.' },
            endLine: { type: 'integer', description: 'Last line to return, 1-based and inclusive.' },
            limit: { type: 'integer', description: 'Number of lines to return, not an end line.' },
            max_bytes: { type: 'integer', aliases: ['maxBytes'], description: 'Byte cap on the read.' },
        },
    },
    fs_write: {
        required: ['path', 'content'],
        fields: {
            path: { type: 'string', description: 'Project-relative path. allowOutsideRoot never widens a write.' },
            content: { type: 'string', aliases: ['data', 'text'], description: 'Complete file content: gm has no edit verb, so a whole-file write is the supported edit.' },
            allow_empty: { type: 'boolean', description: 'Empty content is refused without it.' },
            append: { type: 'boolean', description: 'Appends instead of replacing.' },
        },
    },
    fs_readdir: {
        required: [],
        fields: {
            path: { type: 'string', description: 'Project-relative directory; an absolute path is refused even inside the root.' },
            limit: { type: 'integer', description: 'Default 200, maximum 1000.' },
            offset: { type: 'integer', description: 'First entry to return.' },
            allowOutsideRoot: { type: 'boolean', aliases: ['allow_outside_root', 'allowAbsolute'], description: 'Widens the read to another root.' },
        },
    },
    fs_stat: {
        required: ['path'],
        fields: {
            path: { type: 'string', description: 'Project-relative path.' },
            allowOutsideRoot: { type: 'boolean', aliases: ['allow_outside_root', 'allowAbsolute'], description: 'Widens the read to another root.' },
        },
    },
    git_commit: {
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
    },
    git_finalize: {
        required: [],
        fields: {
            message: { type: 'string', description: 'Commit message; required unless rev or source_ref is given.' },
            paths: { type: 'array', aliases: ['files'], description: 'Paths to commit.' },
            rev: { type: 'string', aliases: ['source_ref'], description: 'Present, this is the push-only path and commits nothing.' },
            allow_whole_index: { type: 'boolean', description: 'Commits the whole index when paths is absent.' },
        },
    },
    git_push: {
        required: [],
        fields: {
            branch: { type: 'string', description: 'Defaults to the current branch, with HEAD resolving to main. A non-main branch without this is gate-denied.' },
            rev: { type: 'string', aliases: ['source_ref'], description: 'Literal sha to push; defaults to HEAD. A symbolic rev is gate-denied.' },
            force: { type: 'boolean', aliases: ['force_with_lease'], description: 'Forces the push.' },
            recover_remote_moved: { type: 'boolean', aliases: ['pull_first'], description: 'Pulls before pushing when the remote moved.' },
            allow_foreign_commits: { type: 'boolean', description: 'Pushes commits another session owns.' },
        },
    },
    recall: {
        required: [],
        fields: {
            query: { type: 'string', description: 'Non-empty recall query; required unless key is given.' },
            key: { type: 'string', description: 'Exact memory key, 1-128 chars of [A-Za-z0-9_-].' },
            namespace: { type: 'string', description: 'Namespace to recall from; defaults to the configured one.' },
            limit: { type: 'integer', description: 'Maximum hits.' },
            full: { type: 'boolean', description: 'Returns whole entries instead of excerpts.' },
        },
    },
    memorize: {
        required: ['text'],
        fields: {
            text: { type: 'string', description: 'Text to store; a bare string body carries it too.' },
            namespace: { type: 'string', description: 'Defaults to "default".' },
            kind: { type: 'string', description: 'Defaults to l0; honoured on routed namespaces only.' },
            discipline: { type: 'string', description: 'Discipline the entry belongs to; checked against the namespace.' },
        },
    },
}

const UNDECLARED_NOTE = 'gm-mcp declares no body schema for this verb; send the fields its Rust handler reads and read the refusal when one is wrong.'

export function verbBodySchema(verb) {
    const declared = VERB_BODY_SCHEMAS[verb]
    if (!declared) return { declared: false, note: UNDECLARED_NOTE }
    return {
        declared: true,
        verb,
        required: declared.required,
        fields: declared.fields,
    }
}

export function describeBodyField(schema, name) {
    if (!schema.declared) return null
    const direct = schema.fields[name]
    if (direct) return { name, ...direct }
    for (const [field, spec] of Object.entries(schema.fields)) {
        if ((spec.aliases ?? []).includes(name)) return { name: field, ...spec }
    }
    return null
}

export function renderBodyHint(verb, fieldName) {
    const schema = verbBodySchema(verb)
    if (!schema.declared) return `${verb} declares no body schema in gm-mcp; ${UNDECLARED_NOTE}`
    const named = fieldName ? describeBodyField(schema, fieldName) : null
    if (named) {
        const aliases = named.aliases?.length ? ` (aliases ${named.aliases.join(', ')})` : ''
        const values = named.enum ? `, one of ${named.enum.join(' | ')}` : ''
        const required = schema.required.includes(named.name) ? 'required' : 'optional'
        return `${verb} body field "${named.name}"${aliases}: ${required} ${named.type}${values} -- ${named.description}`
    }
    const render = (name) => {
        const spec = schema.fields[name]
        const values = spec.enum ? ` one of ${spec.enum.join('|')}` : ''
        return `${name}${schema.required.includes(name) ? '*' : ''}:${spec.type}${values}`
    }
    return `${verb} body accepts ${Object.keys(schema.fields).map(render).join(', ')} (* = required)`
}

export function bodyShapeLine(verb) {
    const schema = verbBodySchema(verb)
    if (!schema.declared) return ''
    const names = Object.keys(schema.fields).map((name) => (schema.required.includes(name) ? name : `${name}?`))
    return ` Body fields: ${names.join(', ')}.`
}
