export const NOTICES = {
    matches_cut: 'The matches list is incomplete: the reply was cut at max_chars. The full list is in spill_file (and result_artifact.path when reported). Raise max_chars, or scope with path/glob and union the per-subtree results.',
    unproven_zero: 'The scan was incomplete, so a zero here is not a finding. Re-scope with path/glob and union the per-subtree results before concluding the code is absent.',
    scanner_zero_files: 'The scan searched 0 files, so this empty result is a scanner failure, not a finding. Name a scope with path (or paths), confirm the root, and re-run.',
    query_regex: 'mode regex honours every metacharacter as written: a | alternates and a space belongs to the pattern. combine has no effect on a regex.',
    exhaustive_scope: 'To reach every match, scope the scan per subtree (path, paths or glob) and union the results. A scoped scan\'s cap is per call.',
    file_source_git: 'The file list is git ls-files (tracked plus untracked, not ignored). Pass refresh:true to walk the disk instead.',
}

export const NOTICE_CODES = Object.keys(NOTICES)

export function noticeText(code) {
    return NOTICES[code] ?? null
}
