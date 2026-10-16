import { shapeGitDiffReply } from '../src/dispatch.js'

const PATCH = [
    'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1 +1 @@', '-x', '+y',
    'diff --git a/b.js b/b.js', '--- a/b.js', '+++ b/b.js', '@@ -1 +1 @@', '-x', '+z',
    'diff --git a/c.js b/c.js', '--- a/c.js', '+++ b/c.js', '@@ -1 +1 @@', '-x', '+w',
    '',
].join('\n')
const STAT = [' a.js | 2 +-', ' b.js | 2 +-', ' c.js | 2 +-', ' 3 files changed, 3 insertions(+), 3 deletions(-)', ''].join('\n')

const outcomes = []
const expect = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    outcomes.push(ok)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

const capped = shapeGitDiffReply('git_diff', { limit: 2 }, { ok: true, diff: PATCH })
expect('patch: limit 2 keeps the first two file sections', (capped.diff.match(/^diff --git /gm) ?? []).length, 2)
expect('patch: limit 2 reports one omitted file', capped.files_omitted, 1)
expect('patch: the kept text is a prefix of the full patch', PATCH.startsWith(capped.diff), true)

const passthrough = shapeGitDiffReply('git_diff', { limit: 3 }, { ok: true, diff: PATCH })
expect('patch: limit equal to the file count leaves the reply unchanged', passthrough.diff === PATCH && passthrough.files_omitted === undefined, true)

const noLimit = shapeGitDiffReply('git_diff', {}, { ok: true, diff: PATCH })
expect('patch: no limit leaves the reply unchanged', noLimit.diff === PATCH && noLimit.files_omitted === undefined, true)

const statCapped = shapeGitDiffReply('git_diff', { limit: 1 }, { ok: true, diff: STAT })
expect('stat: limit 1 keeps one stat row', statCapped.diff.split('\n').filter((line) => / \| /.test(line)).length, 1)
expect('stat: limit 1 keeps the summary line', statCapped.diff.includes('3 files changed'), true)
expect('stat: limit 1 reports two omitted rows', statCapped.files_omitted, 2)

const other = shapeGitDiffReply('git_log', { limit: 1 }, { ok: true, diff: PATCH })
expect('other verbs are not reshaped', other.diff === PATCH, true)

const passed = outcomes.filter(Boolean).length
console.log(`checks ${passed}/${outcomes.length}`)
console.log(passed === outcomes.length ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = passed === outcomes.length ? 0 : 1
