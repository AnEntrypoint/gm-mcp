export const GUEST_BODY_SOURCE = {"repo":"AnEntrypoint/rs-plugkit","sha":"9a6ce828ccf393e0328e17008e29ce60ad24311d"}

export const GUEST_ENVELOPE_FIELDS = ["SESSION_ID","session_id","sessionId","cwd","repo","root","projectPath","git_root_override","full_response"]

export const GUEST_ACCEPTED_FIELDS = {
    "git_status": [
        "path",
        "paths",
        "files",
        "summary",
        "limit",
        "eol"
    ],
    "git_log": [
        "limit",
        "count",
        "max_count",
        "n",
        "range",
        "ref",
        "rev",
        "path",
        "paths",
        "files"
    ],
    "git_diff": [
        "range",
        "ref",
        "rev",
        "staged",
        "stat",
        "path",
        "paths",
        "files",
        "limit"
    ],
    "git_show": [
        "rev",
        "ref",
        "sha",
        "commit",
        "stat",
        "path",
        "paths",
        "files",
        "offset"
    ],
    "git_fetch": [
        "remote",
        "ref",
        "rev",
        "refspec"
    ],
    "git_pull": [
        "remote",
        "branch",
        "ff_only",
        "rebase",
        "autostash",
        "user_name",
        "author_name",
        "user_email",
        "author_email"
    ],
    "ci-log": [
        "github_repo",
        "repo",
        "run_id",
        "run",
        "job_id",
        "job",
        "step",
        "pattern",
        "match",
        "grep",
        "mode",
        "regex",
        "ignore_case",
        "max_lines",
        "max_chars",
        "sha",
        "rev",
        "ref"
    ],
    "git_branch": [
        "remote",
        "all"
    ],
    "git_checkout": [
        "ref",
        "create",
        "path",
        "paths",
        "files"
    ],
    "git_merge": [
        "ref",
        "ff_only",
        "message"
    ],
    "git_merge_abort": [
        "preserve"
    ],
    "git_cherry_pick": [
        "rev",
        "ref"
    ],
    "git_stash": [
        "include_untracked",
        "message",
        "path",
        "paths",
        "files"
    ],
    "git_stash_list": [],
    "git_init": [
        "path",
        "user_name",
        "user_email",
        "initial_branch"
    ],
    "git_stash_drop": [
        "ref"
    ],
    "git_stash_pop": [
        "ref"
    ],
    "git_branch_delete": [
        "branch",
        "remote",
        "remote_name",
        "force"
    ],
    "git_rm": [
        "paths",
        "force",
        "cached"
    ],
    "git_reset": [
        "ref",
        "rev",
        "mode",
        "hard",
        "paths",
        "files",
        "allow_rewrite"
    ],
    "git_worktree_add": [
        "path",
        "ref",
        "rev",
        "commit",
        "start_point",
        "create",
        "allowOutsideRoot"
    ],
    "git_worktree_list": [],
    "git_worktree_remove": [
        "path",
        "force",
        "allowOutsideRoot",
        "allow_rewrite"
    ],
    "git_worktree_prune": [],
    "grep": [
        "pattern",
        "query",
        "mode",
        "comments",
        "help",
        "path",
        "paths",
        "files",
        "glob",
        "include",
        "path_glob",
        "exclude",
        "exclude_glob",
        "exclude_globs",
        "output_mode",
        "outputMode",
        "detail",
        "columns",
        "regex",
        "fixed_strings",
        "fixedStrings",
        "case_insensitive",
        "ignore_case",
        "whole_word",
        "context",
        "max_files",
        "no_ignore",
        "include_ignored",
        "max_results",
        "maxResults",
        "limit",
        "head_limit",
        "max_matches",
        "k",
        "refresh",
        "no_cache",
        "force_disk",
        "file_source"
    ],
    "codesearch": [
        "query",
        "mode",
        "path",
        "paths",
        "files",
        "glob",
        "path_glob",
        "exclude",
        "exclude_glob",
        "exclude_globs",
        "case_insensitive",
        "whole_word",
        "comments_only",
        "no_ignore",
        "include_ignored",
        "exhaustive",
        "k",
        "max_results",
        "maxResults",
        "limit",
        "head_limit",
        "max_matches",
        "max_files",
        "output",
        "max_chars",
        "verbose",
        "docs",
        "timeout_ms",
        "refresh",
        "no_cache",
        "force_disk",
        "root",
        "projectPath",
        "cwd",
        "combine",
        "term_combination",
        "verbatim",
        "regex",
        "literal",
        "pattern"
    ]
}
