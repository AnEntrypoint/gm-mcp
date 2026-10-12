export const RUNNER_REGISTRY_VERBS = [
    'fs_read', 'fs_write', 'fs_readdir', 'fs_stat', 'fetch', 'env_get', 'kv_get', 'kv_put', 'kv_query',
    'git_status', 'branch_status', 'git_push', 'git_add', 'git_commit', 'git_amend', 'git_finalize', 'git_log',
    'git_diff', 'git_show', 'git_fetch', 'git_branch', 'git_remote', 'git_checkout', 'git_merge', 'git_merge_abort',
    'git_branch_delete', 'git_rm', 'git_revert', 'git_reset', 'git_pull', 'git_stash', 'git_stash_pop',
    'git_stash_drop', 'git_stash_list', 'git_init', 'git_poll', 'git_worktree', 'git_worktree_add',
    'git_worktree_list', 'git_worktree_remove', 'git_worktree_prune',
    'sql_open', 'sql_close', 'sql_list_dbs', 'sql_exec', 'sql_query', 'sql_smoke', 'sql_serialize', 'sql_deserialize',
    'memorize', 'memorize-prune', 'recall', 'codeinsight_index', 'codeinsight', 'codesearch', 'forget', 'discipline',
    'exec_js', 'lang', 'python', 'bash', 'powershell', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno',
    'transition', 'transition-revert', 'mutable-resolve', 'mutable-add', 'mutable-list', 'mutable-defer',
    'dream-policy-register', 'dream-evaluator-receipt', 'dream-discovery-record', 'dream-world-seal',
    'dream-replay-round', 'dream-round', 'dream-replay', 'dream-replay-cycle', 'memorize-fire', 'memorize-backfill',
    'discipline-note', 'discipline-check-removal', 'discipline-audit', 'capability-resolve',
    'memory-namespace-audit', 'codeinsight-namespace-audit', 'calculus-model-check', 'phase-status', 'wait', 'sleep',
    'residual-scan', 'claim-audit', 'comment-audit', 'submodule-check', 'component-loader-reconcile', 'component-loader-hmr',
    'auto-recall', 'instruction', 'prd-add', 'prd-resolve', 'prd-list', 'prd-defer', 'prd-repair', 'task-spawn', 'task-list',
    'task-stop', 'task-output', 'memorize-continue', 'fsm-vendor', 'fsm-validate', 'predicates-md',
    'fsm-propose-override',
    'health', 'config_resolve', 'config-sync-now', 'dataflow_resolve', 'status', 'close', 'filter', 'cache_get', 'cache_put',
    'cache_invalidate', 'cache_stats', 'learn', 'chrome',
    'scan_deps', 'code_index', 'callers', 'callees', 'impact', 'grep', 'ci-status', 'prd-status', 'prd-block',
    'pool-brief', 'pool-observe', 'subagent-start', 'subagent-end',
    'memorize-vacuum', 'memorize-retention', 'tencentdb-compat-probe', 'tencentdb-memory-import',
    'git_reset_head', 'browser_lease_acquire', 'browser_lease_release', 'browser_lease_status',
    'nodejs', 'javascript', 'node', 'js', 'typescript', 'py', 'sh', 'shell', 'zsh', 'ps1',
]

export function verbToolName(verb) {
    return verb.replace(/-/g, '_')
}

export function canonicalToolName(name) {
    return String(name).replace(/-/g, '_')
}

export function editDistance(left, right) {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let i = 1; i <= left.length; i++) {
        let diagonal = row[0]
        row[0] = i
        for (let j = 1; j <= right.length; j++) {
            const above = row[j]
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
            diagonal = above
        }
    }
    return row[right.length]
}

export function nearestNames(name, candidates, count = 5) {
    return [...candidates]
        .map((candidate) => ({ candidate, distance: editDistance(String(name), candidate) }))
        .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
        .slice(0, count)
        .map((entry) => entry.candidate)
}
