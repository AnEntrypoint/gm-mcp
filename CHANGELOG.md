# Changelog

## Unreleased - a running server now picks up a newer installed bundle between dispatches

A bundle installed over `~/.gm-tools/gm-mcp-server.mjs` by a lane build, by `dev-sync` or by hand never reached a long-lived server: the only refresh path, `refreshStaleDeployedBundle`, compares the deployed file against a URL, so it answers `current` whenever those two agree, whatever bytes the running process started from. A process runs the bytes it was started from and nothing re-reads them, so the singleton stayed on 0.2.31 while 0.2.32 sat on disk, and no verb said so.

`src/bundle-drift.js` closes that: every 30s the server hashes the file it launched from against the installed one (size+mtime gate first, so the 1 MB hash is taken only when the file moved) and answers `stale` plus `reloadable`. Staleness is now reported three ways -- a `bundle` block on `/health` (and `gm-mcp http-status`), one line on every dispatch reply that is not file content, and one stderr line -- because a silent mismatch is the actual defect: the lane that published 0.2.32 had no way to see it was still talking to 0.2.31. `fs_read`, `result` and `gm_result` are excluded from that line, since their replies are returned byte for byte.

An HTTP server then replaces itself instead of waiting for a reconnect: `handOverToRefreshedBundle` spawns the new bundle with an IPC channel and sends it the listening socket, so both processes hold it and the port is never unbound -- measured over 50s of continuous probing across a handover, 42056 requests, 0 refused, one transition `0.2.34/36660 -> 0.2.35/32508`. The old close-then-bind shape stays as the fallback when the child never reports ready, and `takePortBack` re-listens if the replacement never answers `/health`.

Nothing reloads mid-dispatch. The handover defers while `inflightDispatchCount() > 0` (`bundle-handover-deferred`, retried on the next tick) and the outgoing process drains before `process.exit(0)`, so a reply already being written is finished, not truncated. Measured with a 40s dispatch: a newer bundle installed 4s in, `/health` `stale: true` with the pid unchanged, the dispatch complete at 42.3s carrying the notice, the server on the new bundle only afterwards. `no-downgrade`, `installed-version-unknown`, `running-not-a-bundle` and `transport-stdio` report and refuse rather than reload; a stdio server names the mismatch and asks for a reconnect.

## Unreleased - the ten git verbs that fold a revision now fold every other body field they read

The revision lane closed with `limit`, `stat`, `path`, `mode`, `paths` and `files` still stripped at the top level: `GIT_TOP_LEVEL_FIELDS` named only `range|ref|rev`, so a client sending `{"limit": 2}` to `git_log` had the key removed by zod before `mergeVerbRangeFields` ran and the verb read its own default. `codemode` hides this -- `foldVerbArgs` moves an undeclared key into `body` before validation -- so it bites only a raw MCP caller of the verb tool.

The table is now verb -> field -> the zod type the Rust handler reads, not a shared field-type map, because the handler does not read them all the same way: `body_pathspecs` takes `path|paths|files` as one string or a list of them, while `git_revert` and `git_reset` read `paths` with `as_array` and `git_worktree_add` reads `path` with `as_str`, so those three are typed to match instead of accepting a shape the handler turns into nothing. `limit`/`count` are `z.number()` and `stat`/`staged`/`create`/`ff_only`/`summary`/`eol`/`allowOutsideRoot` are `z.boolean()` for the same reason: `as_u64` and `as_bool` are `None` on a string, so the alias refuses the call rather than letting `"2"` arrive as a silent 10 and `"true"` as a silent `false`. Added: `git_log` `limit`, `count`, `path`, `paths`, `files`; `git_diff` `staged`, `stat`, `path`, `paths`, `files`; `git_revert` `paths`; `git_reset` `mode`, `paths`, `files`; `git_checkout` `create`, `path`, `paths`, `files`; `git_merge` `ff_only`, `message`; `git_worktree_add` `path`, `create`, `allowOutsideRoot`; and `git_status`, which folds no revision and had no alias at all, `path`, `paths`, `files`, `summary`, `limit`, `eol`. `git_stash_pop` and `git_stash_drop` gain nothing: both accept `ref` and nothing else.

Measured by driving the real tool over a real stdio MCP session -- `initialize`, `notifications/initialized`, then `tools/call` with the tool registered from `verbToolInputSchema(verb)` and dispatched through `mergeVerbRangeFields` and `gmDispatch`, so the arguments really are validated by the MCP SDK against the real input schema -- against `C:/dev/gm` and a scratch repo, before and after:

| call (top level) | before | after |
| --- | --- | --- |
| `git_log {limit: 2}` | 10 commits (default) | 2 commits |
| `git_log {path: "f1.txt"}` | 8 commits | 1 commit |
| `git_diff {stat: true}` | whole diff | ` f1.txt \| 2 ++` |
| `git_diff {staged: true}` | `f1.txt` (unstaged) | `f2.txt` (staged) |
| `git_status {limit: 1}` (15 untracked) | 13 listed entries | 3 listed entries |
| `git_checkout {ref:"master", create:true}` | `ok:true, checked_out: master` | `BRANCH_CREATE_REFUSED` |
| `git_reset {paths:["f1.txt"], mode:"hard"}` | `ok:true, mode: mixed, reset_to: HEAD` | `paths scope the index only: mode must be mixed or omitted` |
| `git_reset {mode: 5}` | `ok:true` (5 -> `--mixed`) | `-32602 expected string, received number at mode` |
| `git_revert {paths:["f1.txt"]}` | `pass {paths:[...]} to discard working changes or {ref} to revert a commit` | `discarded: [f1.txt]` |
| `git_worktree_add {path:"../outside-wt"}` | `git_worktree_add requires a path` | `git_worktree_add path must not contain '..'` |
| `git_merge {ref:"feature", ff_only:true}` | merge commit `9529832` (2 parents) | `fatal: Not possible to fast-forward, aborting.` |
| `git_merge {ref:"feature", message:"lanemerge"}` | `Merge branch 'feature'` | `lanemerge` |
| `git_log {limit:"2"}` | 10 commits, `isError=false` | `-32602 expected number, received string at limit` |
| `git_diff {stat:"yes"}` | whole diff, `isError=false` | `-32602 expected boolean, received string at stat` |

The last four rows are the non-vacuity proof: a dropped field is silent, so the only way to tell folding from dropping is a value the verb refuses, and every row above is the verb's own refusal or the verb's own narrower answer rather than a default. `test/codemode-args.test.mjs` pinned `foldVerbArgs(git_status, {limit: 5})` to `{body:{limit:5}}`; `limit` is now declared, so it stays at the top level for `mergeVerbRangeFields` and the assertion moved to a verb with no alias for the key, with the three new cases asserted next to the other verb aliases.

## Unreleased - a codemode return value renders what JSON cannot instead of dropping it or throwing

`gm_codemode` rendered the body's return value with a bare `JSON.stringify(value, null, 2)`, which answers two classes of value wrong. It drops what it cannot render, so a function-valued or undefined field disappears: measured on the deployed 0.2.31 bundle, `return {f: () => 1, nested: {deep: [1, 2]}}` answered `{"nested":{"deep":[1,2]}}`, and `return {r: r.data && r.data.matches, s: s.data && s.data.matches}` with both replies undefined answered `{}` -- identical to a payload that never arrived, so an agent re-dispatches a codesearch whose result was already in hand. It also throws on a BigInt and on a cycle, and the throw happened inside the reply path, so the whole tool result became `gm-mcp: gm_codemode code threw -- TypeError: Do not know how to serialize a BigInt` (and `Converting circular structure to JSON`) with the value and every `console.log` line above it lost.

Rendering of the return value is now the only thing that changed: a string is returned as-is, anything structured goes through `JSON.stringify` with a replacer that turns what JSON cannot render into text -- a function into `[Function f]`, a symbol into `Symbol(x)`, a BigInt into `42n`, an object reachable from itself into `[Circular]` -- and `String(value)` is the fallback only when there is nothing left to render. Verb dispatch, what `gm.<verb>(...)` returns inside the body, and the spool protocol are untouched.

Measured before and after on `C:/dev/gm` by driving the real tool over a real stdio MCP session (spawn the bundle, `initialize`, `notifications/initialized`, `tools/call` `gm_codemode`), cwd `C:/dev/gm`:

| return value | 0.2.31 | 0.2.32 |
| --- | --- | --- |
| `{r:{count:2,matches:[{p,l},{p,l}]}, s:"ok"}` | whole nested JSON | whole nested JSON (unchanged) |
| `{f: () => 1, nested: {deep:[1,2]}}` | `{"nested":{"deep":[1,2]}}` | `{"f":"[Function f]","nested":{"deep":[1,2]}}` |
| `42n` | `code threw -- Do not know how to serialize a BigInt` | `"42n"` |
| `{n: 42n, keep: "me"}` | `code threw` (same) | `{"n":"42n","keep":"me"}` |
| `c = {}; c.self = c` | `code threw -- Converting circular structure to JSON` | `{"name":"root","self":"[Circular]"}` |
| `(function namedProof(){})` | `(empty string)` | `"[Function namedProof]"` |
| `{s: Symbol("x"), keep: "me"}` | `{"keep":"me"}` | `{"s":"Symbol(x)","keep":"me"}` |
| `"plain text"` / `42` / `true` / `null` / `undefined` | `plain text` / `42` / `true` / `null` / empty | unchanged |
| `console.log("logged-line"); return {ok:true}` | `logged-line` + `{"ok":true}` | unchanged |

A shared reference that is not a cycle is deliberately not marked: `{a: shared, b: shared}` still prints both objects whole, because the cycle test walks the ancestor chain recorded as the replacer descends rather than a set of everything already seen. The `{}` an agent reported is therefore a serialization miss only for values JSON renders as absent -- a returned object whose every field is `undefined` still prints `{}`, and that is now the only way to get it. `BUNDLE_VERSION` moves to 0.2.32.

## Unreleased - nine git verbs fold their revision from the top level, and two siblings deliberately get none

`git_show` declared a top-level `rev`/`ref`/`sha`/`commit` and `git_push` a top-level `rev`, but the git verbs that read a revision the same way declared none: their zod schema was the dispatch envelope alone, so a client sending `{"rev": "<sha>"}` to `git_log` had the key stripped before `mergeVerbRangeFields` ran and the verb read HEAD instead. Measured on `C:/dev/gm` by driving the real handler -- `verbToolInputSchema(verb)` wrapped in `z.object`, `.parse`, then `mergeVerbRangeFields` -- `rev`, `ref` and `range` answered `DROPPED` for `git_log` and `git_diff`, and `ref` answered `DROPPED` for `git_revert`, `git_reset`, `git_checkout`, `git_merge`, `git_stash_pop`, `git_stash_drop` and `git_worktree_add`, while `git_show` and `git_push` answered `FOLDED`. `GIT_TOP_LEVEL_FIELDS` now declares `range|ref|rev` for `git_log` and `git_diff` and `ref` for the other seven, each an `optional()` `z.string()` folded into `body` only when `body` does not already name it, so a key named in both still takes its value from `body`: measured, `{"rev":"1111111111111111111111111111111111111111", body:{"rev":"b4b1815"}}` produces `body.rev = "b4b1815"` for every one of them. Dispatched through the real verbs afterwards, `git_log {rev:"b4b1815"}` answers that commit, `{ref:"7a2a9f2"}` answers that one, `{range:"00d6c76..b4b1815"}` answers a single commit, `git_diff {rev:"076396e", stat:true}` and `{range:"076396e..a7e40db", stat:true}` answer the stat of that range, and each of the seven ref-taking verbs answers a loud failure naming the ref it was handed instead of falling back to HEAD: `git_revert` `fatal: bad object deadbeef...`, `git_reset` `fatal: Could not parse object 'deadbeef...'`, `git_checkout` `fatal: unable to read tree (deadbeef...)`, `git_merge` `merge: deadbeef... - not something we can merge`, `git_stash_pop` and `git_stash_drop` `error: refs/heads/no-such-ref-r270-54 is not a valid reference`, `git_worktree_add` `fatal: invalid reference: deadbeef...`.

Two of the ten verbs a report of this defect named get no alias, and both for the same reason: a top-level key has to name a field the verb really reads. `git_branch` accepts only `remote` and `all` and refuses an unknown body field -- measured, `body:{"ref":"main"}` answers `unknown body fields for git_branch: ref` with `accepted_fields: [remote, all]` -- so a `ref` alias would turn a working listing into a refusal. `git_revert` and `git_reset` read `ref` and nothing else: neither has a `rev` branch, and `git_reset {rev:"deadbeef..."}` measured `ok:true, reset_to:"HEAD"`, a silent reset to HEAD, so folding `rev` would add a knob with no consumer; `git_revert` has no `range` either. A body field that is not a revision -- `limit`, `stat`, `path` -- is still stripped at the top level and belongs inside `body`; only the revision keys are aliases.

## Unreleased - every gm.<verb>({...}) call reaches the verb body

`gm_codemode` bound every verb as `gm.<verb>(args)` but passed `args` straight into the dispatch envelope: a verb tool's top-level schema is the dispatch envelope (`body`, `raw_body`, `session_id`, `cwd`, `timeout_seconds`, `max_chars`, `full_response`, `resume_task`) plus that verb's own top-level aliases, and zod strips anything it does not declare, so every key the verb actually reads was deleted before the dispatch. Measured on `C:/dev/spoint`, `await gm.codesearch({query: "createWorkerRenderer", mode: "literal", max_matches: 20})` answered `ok: false`, `error_code: invalid_args`, `error: query required -- pass {"query":"<the text to search for>"}`, while `await gm.gm({verb: "codesearch", body: {query: "createWorkerRenderer", mode: "literal", max_matches: 20}})` answered real matches -- the args object was being dropped, not refused. `codesearch`, `codeinsight`, `fs_read`, `git_status`, `exec_js`, `bash` and every other argument-taking verb were affected identically, because the drop is in the shared binding rather than in any one verb's schema.

`foldVerbArgs` now moves every key the tool does not declare into `body` before validation, so `gm.<verb>(args)` is the same dispatch as `gm.gm({verb, body: args})`: a named `body` wins over a folded key (the precedence every other fold in gm-mcp already uses), a `raw_body` wins over everything, a `body` carrying a JSON string is merged as that object, and a verb's own top-level aliases (`fs_read` line ranges, `git_commit`/`git_finalize` `message`/`paths`, `git_push` `rev`, `prd_list` `id`/`status`/`limit`/`full`) stay at the top level so `mergeVerbRangeFields` keeps folding them exactly as before. Measured after the change on the same project, through the live MCP at `http://127.0.0.1:8787/mcp` with `cwd: "C:/dev/spoint"`, `gm.codesearch({query: "createWorkerRenderer", mode: "literal", max_matches: 20})` answers `count: 33 lines, 33 occurrences, 10 files` with the matches listed and no `invalid_args`, and the `gm.gm({verb, body})` form answers the same search. The sibling verbs answer on the same run: `gm.fs_read({path: "package.json", startLine: 1, endLine: 3})` answers `ok: true` with `returned_lines: 3`, `gm.exec_js({code: "return 6*7"})` answers `result: 42`, `gm.git_status({limit: 2})` answers `ok: true`, and `gm.codeinsight({path: "src/behaviours/fire.js"})` reaches the verb.

`test/codemode-args.test.mjs` covers the fold, the envelope, body precedence, `raw_body`, the verb aliases and the `gm.gm` form, and drives the handler `registerCodeMode` really installs, so it runs the same bindings -> fold -> zod -> handler path a live call takes; it is in `npm test`. The tool description now shows the flat form (`gm.codesearch({query: "..."})`) instead of the `body`-wrapped one it never accepted. `BUNDLE_VERSION` moves to 0.2.31.

Note for anyone reproducing this: a Claude Code session registered `gm` with a **stdio** command that loads `~/.gm-tools/gm-mcp-server.mjs` at process start, so restarting the shared HTTP server does not change what that session's `gm_codemode` serves -- the session has to reconnect. The witness above was run against the HTTP endpoint, which builds a fresh server per request and therefore serves the deployed bundle immediately.

## Unreleased - prd_list folds its row selector, and a verb's top-level keys resolve under either spelling

`gm.prd_list({id: "SOME-ROW"})` dropped the selector in silence and answered the whole PRD: `id` was not a field of the tool's input schema, so zod stripped it before the dispatch and the verb ran unfiltered. Measured on `C:/dev/spoint` (1019 rows), that call returned `count: 1001` in 178432 characters plus a spill file, while `body: {id: "KISS-n-r209-1"}` returned `count: 1` in 1964. `id`, `status`, `limit` and `full` -- the row selectors `prd-list` declares in `src/verb-bodies.js` -- are now top-level fields of the `prd_list` tool and are folded into `body` by `mergeVerbRangeFields`, exactly as the git verbs fold `rev`/`message`/`paths`; a key named in both places takes its value from `body`, and a call with no selector still lists the whole PRD unchanged. Measured on the same store after the change, `{"id":"KISS-n-r209-1"}` and `body:{"id":"KISS-n-r209-1"}` both answer 1964 characters naming `r209-1` only, and `{"id":"KISS-n-r209-1", body:{"id":"KISS-n-r209-2"}}` answers `r209-2` only.

The fold also never reached `git-push`, `git-commit` or `git-finalize` from `src/`: their aliases were keyed `git_push`/`git_commit`/`git_finalize` while `RUNNER_REGISTRY_VERBS` registers the hyphenated `git-push`/`git-commit`/`git-finalize`, and `VERB_EXTRA_FIELDS`, `VERB_TOP_LEVEL_ALIASES` and `VERB_DESCRIPTION_EXTRA` were read with the registry name. All three lookups now go through `verbToolName`, so a verb and its tool name resolve the same extras and the git verbs fold the keys their descriptions already advertise. `test/prd-list-mcp-tool.test.mjs` covers the schema, the fold, body precedence and the two spellings, and is in `npm test`. `BUNDLE_VERSION` moves to 0.2.30.

A selector `prd-list` does not read is still dropped by the verb rather than refused: `body: {"filter": "NOPE-n-r1"}` answers the whole store (`count: 1002`), so the tool description claims no refusal it cannot honour.

## Unreleased - a verb's body is discoverable, max_chars binds, refusals name the valid set, and every callable name is enumerable

Four frictions hit in one live session, all on the verb surface.

`gm.describe(name)` answered with the generic dispatch wrapper for every verb, so the fields a body actually accepts were undiscoverable: `prd_add`, `task-spawn`, `codesearch`, `fs_read`, `fs_write`, `git_commit`, `git_finalize`, `git_push`, `instruction`, `exec_js`, `recall` and `memorize` now carry a `body_schema` alongside `input_schema`, built by the new `src/verb-bodies.js` from the verb's Rust handler -- required-ness, types, enums and aliases, each with what the guest does with the value, and the same shape is appended to every per-verb tool description. A verb with no declared schema now says so (`declared: false`) instead of silently returning the wrapper. `describe` also accepts either spelling of a verb: `prd-add` and `prd_add` resolve to the same tool.

`gm_instruction` declared no `max_chars`, so the cap a caller passed was silently dropped and the whole reply came back -- measured on the deployed bundle, `gm_instruction({max_chars: 1200})` returned 4065 characters. It is now a declared field and reaches the dispatch; the same call returns 994. `capReplyText` also hard-clamps the head once the truncation notice is counted, so a reply can no longer exceed the cap by more than the notice's own reserve.

A verb refusal that names a missing or unsupported field now comes back with `verb_body_hint` (the field, its type, its accepted values when it has an enum, and its aliases) and, when the reply does not already carry one, `next_dispatch_hint`, so `unsupported lang: go` answers with the twelve runtimes `body.lang` accepts instead of a bare `error:` line.

The codemode namespace was neither complete nor enumerable: `gm.list()` returned a blob of spool stems, `gm.pool_observe` raised `TypeError: ... is not a function` because `pool-observe` and thirty other registry verbs were missing from gm-mcp's list, and a hyphenated or underscored spelling of a name that existed resolved to nothing. `RUNNER_REGISTRY_VERBS` gains the missing verbs, `gm.list()` returns `{name, verb, description}` for all 164 callables, the `gm` object resolves any of `pool_observe`, `pool-observe` and the verb spelling to the same function, and an unknown name raises an error naming the five nearest callable names rather than a bare `TypeError`. `BUNDLE_VERSION` moves to 0.2.29.

## Unreleased - a range key inside body ranges the read, and an unrecognised one is never dropped

The aliases reached the guest only as top-level tool arguments, so the caller path -- `body: {"path": "dsp/loop.dsp", "startLine": 34, "endLine": 38}` -- still answered with the whole file, and worse, a range key the guest does not know (`start_line`, `firstLine`, `rangeStart`) was ignored in silence: the reply looked like a successful ranged read and was the whole file. Three changes. `dispatch.js` `fsReadRangeCanonicalBody` rewrites whatever alias pair the caller sent into one canonical `startLine`/`endLine` pair before the body is written to the spool, so every alias means the same 1-based inclusive range whichever keys the guest build itself understands: `start`/`end`, `start`/`count`, `from`/`to`, `offset`/`limit`, `line`/`lines` and a lone `count` all become `startLine`/`endLine` (`count` becomes an end line: `start 3, count 3` is `endLine 5`), a start with no end stays a bare `startLine`, an invalid range (`startLine 0`, end before start, `count 0`) and a body with no recognised pair -- including one carrying only range-looking junk -- are forwarded untouched so the reply is the error rather than a guess, and non-range keys such as `path` and `max_bytes` survive. `applyFsReadRangeFallback` then reads a reply the guest already ranged whether its fields sit at the top level or nested under `data`, so a guest that sliced is never re-reported as unapplied. And `fsReadUnknownRangeKeys` turns any remaining range-looking key into `ok: false` with `unknown_range_keys` and `accepted_range_keys` instead of a whole file, matching the guest the Rust side already has. A range that cannot be applied -- an error reply, a reply with no file text -- says so with `range_applied: false`, `range_requested` and a `range_note`, rather than looking applied. No range at all still returns the whole file, unchanged. `test/fs-read-mcp-tool.test.mjs` drives the built `bin/gm-mcp-server.js` over MCP stdio exactly as a caller does and is in `npm test`; `test/fs-read-range.test.mjs` grows the canonical-pair and nested-ranged cases. `BUNDLE_VERSION` moves to 0.2.25.

## Unreleased - fs_read ranges reach the guest, and a truncation notice names the range it spilled

`fs_read` accepted `startLine`/`endLine` and silently ignored them, so `{"path": "src/dsp/audio_thread.cpp", "startLine": 1040, "endLine": 1100}` answered with the whole file from line 1, cut at the 24000-character reply cap with a spill file, and the caller had no way to know which range it held. `mcp-server.js` now advertises every accepted alias -- `startLine`, `endLine`, `start`, `end`, `count`, `from`, `to`, `offset`, `limit`, `line`, `lines` -- as top-level `numberLike` fields on the `fs_read` tool (and in its description, with the pair precedence), and `mergeVerbRangeFields` folds the ones present into `body` as numbers, so a top-level alias can no longer be dropped on the way to the spool; `body` wins when both carry the same key, and a verb without range fields is untouched. `dispatch.js` `applyFsReadRangeFallback` slices the reply itself when the guest has not: it applies the same alias precedence, the same 1-based inclusive reading (`limit`/`count`/`lines` counting lines) and the same clamping, and answers with the ranged fields. It runs only for `fs_read`, only when a range was asked for and only when the reply carries no `start_line`, so a guest that already ranged -- the rebuilt one -- and every rangeless read are untouched, and the whole-file reply stays the verbatim `data` string it was. `renderVerbatimFileText` renders that ranged `content` verbatim too, and `capReplyText` now takes a spill note: a truncated `fs_read` reply reports `spill_range: lines 1040-1100 of 3177 (1-based, inclusive)`, `spill_lines` and a `next_range` to send for the rest, so the spill file can be paged with `gm_result`. Out-of-bounds ranges (start 0, start past the last line, end before start, an empty file) are errors naming the readable range instead of a silent whole file. `BUNDLE_VERSION` moves to 0.2.24.


## Unreleased - a multi-line body writes the file instead of failing to parse

`normalizedObjectBody` handed a `body` JSON string straight to `JSON.parse`, so a multi-line file -- `{"path": "big.py", "content": "import os<newline>def main(): ..."}` with literal newlines and quotes in the content -- failed with `fs_write body is a JSON string that cannot be parsed: Bad control character in string literal in JSON at position 56`, and the only way out was to escape every newline and quote by hand. A body string now decodes in three steps: `JSON.parse` as written; if that fails, a scan escapes the control characters and the interior quotes a legal JSON value string cannot contain and parses again; and if the text is not object-shaped at all it is forwarded as the raw dispatch body rather than rejected. A body that is still unparseable is reported against the field covering the parser's error position -- `fs_write body.content is not valid JSON: ...` -- with a hint naming the array or object form that avoids the repair. Object bodies, `\n`-escaped strings and `content` arrays are unchanged. `BUNDLE_VERSION` moves to 0.2.23.


## Unreleased - the shared HTTP server is supervised again

`gm-mcp` is registered as `"type": "http"`, so the agent host never starts the server: when the process holding `127.0.0.1:8787` died, nothing brought it back, and every session that connected afterwards had no `mcp__gm__*` tools until something started it by hand -- the 2026-10-10 outage, where the server's log ends mid-dispatch with no exit line and the port stayed empty until a manual restart. `README.md` already documented the part that was missing from the code: `http-supervise` is now a real command, a detached sibling that probes `/health` every 15 s (`GM_MCP_HTTP_SUPERVISOR_INTERVAL_SECONDS` moves it) and runs the same `ensureHttpSingleton` start path when two consecutive probes answer nothing. Two probes, not one, because a single probe that times out during an index pass or a dispatch storm used to spawn a duplicate that died on `EADDRINUSE`. `ensure-http` arms one on every run, including a run that found a server already up, and a `--http` server arms one for itself on start, so the watcher comes back from any start path; `GM_MCP_HTTP_SUPERVISOR=0` opts out of both and `ensure-http` then prints `supervisor disabled`. Two supervisors on one port are harmless rather than fatal: the revival path probes before it spawns, so the loser of a claim race only ever finds a server already up. The supervisor spawns detached and unref'd, because a supervisor parented by a caller dies with that caller's tree, and it hands `GM_MCP_HTTP_SUPERVISOR=0` to every server it starts so a restarted server does not arm a second one. Its state file `gm-mcp-http-supervisor-<port>.json` is a heartbeat, not a pid: a claim older than 60 s (or four intervals, whichever is longer) is stale, so an exited supervisor cannot block a re-arm forever, and the claim is written by atomic rename. Deaths are observable too: `http-supervisor-restarted` names the pid that stopped answering, `http-listen-failed` records a `listen` refusal such as `EADDRINUSE` before it reaches the top level, and the `exit` record now carries `uptime_ms` so two servers exiting with the same code inside the log's one-minute repeat window each leave their own line. `BUNDLE_VERSION` moves to 0.2.24.

## Unreleased - the HTTP singleton is seeded by every entry point and installed at boot

Registering gm as `"type": "http"` means the agent host never starts the server, so a port nothing was listening on left the whole session without gm tools (`Failed to connect: gm`, and every `mcp__gm__*` tool absent) until somebody rescued it by hand. Seeding was gated on `GM_MCP_HTTP_SINGLETON=1` and only ran in the stdio path, so a host that launched HTTP directly, or any start without that variable, left the port empty. Seeding is now opt-out (`GM_MCP_HTTP_SINGLETON=0` or `GM_MCP_NO_HTTP_SINGLETON=1`) and runs from every entry point: a stdio server, an HTTP server listening on a different port, and `dispatch`, which is the command agents keep running anyway. The spawn stays detached and unref'd, and `dispatch` passes `wait: false`, so a short-lived caller neither waits for the server to come up nor keeps the port's startup time. The state file is dropped before a fresh spawn and the health probe remains the authority, so a file naming a dead or unresponsive pid cannot wedge the next start. `scripts/install-autostart.mjs` installs the boot hook and a five-minute crontab guard idempotently (marker blocks replaced wholesale, `--check`/`--uninstall`, `--entry`/`--hook`/`--cron-file`/`--log`), so the port is listening before any session starts and returns within five minutes after a crash. A long-lived HTTP server also picks up a refreshed deployed bundle instead of running stale bytes forever: when the staleness check swaps the bundle, it closes the listening socket, spawns the replacement, and exits only once the replacement answers `/health` -- with a different pid than its own -- taking the port back if the replacement never arrives, and deferring the whole handover while a dispatch is in flight. `BUNDLE_VERSION` moves to 0.2.23.
## Unreleased - gm_result reads a spilled result from the project that produced it

`gm_result` resolved `result_file` against the `.gm/exec-spool/out` of the project this server was started in, so the absolute path a truncation notice prints -- `C:\dev\other\.gm\exec-spool\out\git_diff-<...>.json field 'diff'` after a dispatch whose `cwd` was `C:\dev\other` -- was refused with "spool file must name a file inside this project's .gm/exec-spool/out directory", and both the bare name and the `.gm/exec-spool/out/<name>` form resolved against that same wrong root. It now accepts any absolute path that lands inside a `.gm/exec-spool/out` directory, whichever project owns it: the containing directory is checked by name and again after `realpath`, so a `..` segment, a symlink out of the spool and a hardlink are still refused, and the 4 MiB size and `nlink === 1` checks are unchanged. A relative or bare name resolves against the new optional `cwd` (alias `root`/`projectPath`, default this server's own root), and a bare name is additionally looked up under `<cwd>/.gm/exec-spool/out`. `offset` and `limit` now coerce from numeric strings, which the tool schema already advertised as `numberLike`, and the tool description states the 1..16000 `limit` cap that only the error text used to disclose. The coerced values are what the paging arithmetic then uses: `next_offset` used to be computed from the raw arguments, so a numeric-string `limit` on a field read answered `next_offset: '0200'`. Verb spill pointers themselves were never cwd-relative: `response-compact` names the dispatch root's own absolute out-file, so `git_diff` and every other spilling verb needed no change. `BUNDLE_VERSION` moves to 0.2.22.

## Unreleased - the exec limit no longer follows timeout_seconds

`withTimeoutMsPrefix` used to write `timeoutMs=<timeout_seconds * 1000>` into an exec-family body that had no prefix, so a `timeout_seconds: 240` poll also killed the child at 240 s with `exec_timeout`. The wrapper now writes the daemon default (300000), as the README and the MCP tool description say: `timeout_seconds` sets only the poll budget. A longer run puts `timeoutMs=<ms>` (up to 900000) on the first line of the body.

## Unreleased - prd-list keeps the full why

`prd-list` rows keep their `why` text in full: `response-compact` exempts that key for the `prd-list` verb, so a long `why` is no longer replaced by a spool-file pointer. The runtime folds repeated blocks of one id to the last block, so `prd-list` with an id returns one row. `BUNDLE_VERSION` moves to 0.2.19.

## Unreleased - empty pool answers stay visible

`response-compact` used to drop an empty array under every key, so an empty `pool-observe` `candidates` or `live_rows` printed as a missing key and read to the orchestrator as null. Both keys are now in `EMPTY_LIST_IS_THE_ANSWER_KEYS`, so an empty list prints as `[]`. The ranking itself lives in rs-plugkit (`pool_rank.rs`): node-first, then severity, then recency, outcome and refuted rows excluded, and the candidate list is no longer capped. `BUNDLE_VERSION` moves to 0.2.18.

## Unreleased - sha256 release bridge for the runner and guest plugin

`src/release-bridge.js` upgrades the installed `agentplug-runner` from `AnEntrypoint/agentplug-bin` and the `gm` guest (`gm.wasm`) from `AnEntrypoint/plugkit-bin` on server start, at most hourly. Verification is the release's `.sha256` sidecar. Each swap keeps the replaced file as a backup, and a successful swap signals the daemon of this `AGENTPLUG_HOME` so the next dispatch respawns the new build. `BUNDLE_VERSION` moves to 0.2.12.

## Unreleased - headless-browser verbs removed from the wrapper

`serp`, `browser` and `cdp` are no longer named anywhere in the wrapper: the plain-text-body set is derived from the exec family alone, the tool descriptions and `raw_body`/`body` field descriptions list only the exec-family stems, and the README and AGENTS.md drop the references. Exec-family plain-text handling is unchanged.

## Unreleased - glob filters forwarded as documented, and a slow dispatch discloses its wait

Glob filters no longer reject a leading `!` or brace lists: the wasm already excludes, merges aliases and expands braces, so the wrapper only validates types and blanks. `exclude_glob`/`exclude_globs` are validated the same way. Replies that waited 5 s or more carry `dispatch_waited_ms`. `timeout_ms` coerces from a numeric string like the other codesearch integers.

## Unreleased - a queued dispatch reports measured queue pressure instead of three hypotheses

A dispatch that timed out `queued_not_yet_claimed` was explained in prose: "the
daemon is between ticks or still starting, or this project already has its
maximum of 32 claimed dispatches in flight". Those are different situations with
opposite responses -- wait, or escalate -- and nothing in the response let the
caller tell them apart.

The spool holds both numbers, so the response now measures them:
`dispatch_state` gains `project_claimed_count`, `project_unclaimed_count`,
`oldest_unclaimed_age_ms`, `unclaimed_ahead_of_mine`, `claimed_dispatch_cap`,
`claim_budget_left` and `cap_saturated`, counted from `in/<verb>/` the same way
the daemon counts its own (`*.inflight` is the claim marker). When the cap is
the blocker the note says so and points at `resume_task`; when it is not, the
note says the claim budget is free and the wait is the daemon's sweep of other
projects. `daemon` also stops dropping the counts the heartbeat already
publishes -- `claimed_step_count`, `queued_step_count`,
`gm_processor_capacity` -- and adds `daemon_active_projects` from the shared
daemon status, which is what actually explains a long `queue_wait_ms` on a
shared daemon.

## Unreleased - a daemon that dies mid-dispatch is re-asked for, and one cold start no longer stacks runners

A dispatch whose daemon exits after the preflight sat `queued_not_yet_claimed`
for its whole poll budget: `ensureSpoolRunnerRunning` ran once before the file
was written and never again, so nothing revived the daemon while the caller
waited. That is what a 2026-10-02 MCP server did to a `codesearch` on
2026-10-04 -- the shared daemon had self-recycled after an idle hour (by
design), the server's bundle predated the runner watchdog, and the dispatch was
written straight into a dead spool.

The poll loop now re-asks for a runner on every wake. The call is self-throttled
to one attempt every `ENSURE_INTERVAL_MS` and is a no-op while the daemon is
live, so a dispatch that outlives its daemon is picked up by a fresh sweeper
instead of expiring.

The matching hazard on the other side: `agentplug-runner spool` costs ~11 s warm
and ~100 s cold (registering the project, then waiting out the shared daemon's
wasm compile), while the watchdog wakes every 5 s and used to spawn a fresh
`spool` every 2 s regardless. A cold start therefore stacked ~50 runners, all
contending for `daemon.lock`. `runnerEnsureInFlight` now suppresses a spawn
while the previous one for that root is still running, and a child older than
`ENSURE_CHILD_MAX_AGE_MS` (120 s) is treated as wedged and re-issued, so a hung
`spool` cannot block supervision forever.

## Unreleased - the fields that aim a search at another project are documented on the tools that call them

`codesearch` (and `grep`, and `codeinsight_index`) read the directory to search
from body `"root"`, aliased `"projectPath"` and now `"cwd"` -- but no MCP
client could discover that. The `gm` tool's schema described `body` generically
for every verb and described `cwd` only as "project root containing
.gm/exec-spool", so a caller searching a project other than the server's own
had no documented way to say so, and read the out-of-root refusal as "cwd is
ignored and gm can only search one project".

The `gm` tool's `body` description now names the fields, and both tools' `cwd`
descriptions say what `cwd` actually does: it selects the project whose daemon
handles the dispatch (the daemon is spawned with `cwd: root`, so it is also the
project a verb like codesearch searches), and it is not forwarded into the verb
body -- `root` inside `body` is how a single dispatch is aimed elsewhere
without moving the daemon.

## Unreleased - a self-update can no longer quietly revert a fix

`bin/gm-mcp-server.js` on `main` is the live release channel: every deployed
`~/.gm-tools/gm-mcp-server.mjs` swaps itself for it within the hour. That swap
is a bare file overwrite, so a release that loses a fix silently undoes it on
the machine -- which is exactly what happened to `windowsHide: true` on two
child spawns (`execFileSync("git", ...)` and `spawnSync(process.execPath,
["--check", ...])`), present in `src/` and in the committed bundle and missing
from the 2026-10-04 08:57 release build.

Three guards now gate `replaceDeployedBundle`:

- **Freeze**: `GM_MCP_NO_SELF_UPDATE` set to anything but `0`/`false`/`no`/
  `off`, or a `gm-mcp-server.no-self-update` file in `$AGENTPLUG_HOME` (else
  `~/.agentplug`), refuses every self-update before any network call.
- **Local-build pin**: `gm-mcp pin-local-build [path]` records the installed
  bundle's sha256, path, version and ts in `gm-mcp-server.local-build.json`;
  while the installed bundle's sha256 matches, the channel may not overwrite
  it. `unpin-local-build` clears it and `self-update-status` reports the whole
  state. Pinning a bundle you built by hand is what keeps a local fix local.
- **No downgrade**: the candidate's version must be strictly greater than the
  installed `BUNDLE_VERSION` (`src/bundle-version.js`, compared numerically
  component by component). Equal, older, or unreadable versions are refused.

Every refusal logs `refusing deployed bundle self-update (<code>) -- <reason>`
to stderr, so it reaches the daemon log instead of vanishing into the
background check. The `.prev` backup and the `node --check` validation of a
candidate are unchanged. `BUNDLE_VERSION` is 0.2.3 and must be bumped with
every release: a release that keeps the installed version is refused.

## Unreleased - a dispatch to a dead daemon fails fast instead of hanging

The daemon self-recycles every few minutes (see AGENTS.md "Runner recovery"),
and a dispatch sent into a recycle used to discover that only at the poll
timeout: the ticket was written, sat `queued_not_yet_claimed`, and the caller
waited out its whole `timeout_seconds` -- 120 s by default -- for an answer
that was never coming. The `daemon` liveness block already said `alive: false`
with a heartbeat 157 s stale; nothing acted on it.

`gmDispatch` now checks liveness before writing. A project whose heartbeat is
stale and whose `pid` is gone gets a runner restart and `DAEMON_START_GRACE_MS`
(15 s) to come back, and only then answers `error: daemon-not-running`,
carrying the heartbeat age, `~/.agentplug/daemon.log`, the spool log, the
`.status.json` it read and the one-line restart command -- and no ticket is
written, so nothing is left queued behind a daemon that will never claim it.
A project with no `.status.json` is the registration path rather than a dead
daemon and still dispatches, as does one inside `daemonBootGraceActive` or a
`runner_update_in_progress` handoff, where a stale heartbeat is expected and
transient. Opt out with `GM_MCP_DAEMON_PREFLIGHT=0`.

The stale-heartbeat note no longer points at a `daemon.log` that does not exist
in a project: it names `~/.agentplug/daemon.log` and the project's
`.watcher.log`, and both now carry the restart command.

## Unreleased - a recall reply stops repeating every hit twice

A `recall` reply returned the ranked rows twice: once in `hits`, once in
`vector_hits`, with the same `key` and the same truncated `text`. The two
lists float-differ in `score` and `cos`, so the existing byte-identical row
collapse could not merge them, and every hit's prose crossed the wire twice.

`compactWireResponse` now drops `vector_hits` when every row in it is already
in `hits` -- the case where the fused list is exactly the vector candidates --
and names it in `wire_compacted.omitted`. It keeps `vector_hits` whenever it
carries a row `hits` does not, so the degraded paths that report an error
there and the `codesearch` replies whose `vector_hits` and `bm25_hits` are
independent retrieval channels are untouched. `full_response: true` still
returns both lists byte for byte.

## Unreleased - fs_read reads whole files, and the verb name is honest

`fs_read` came back truncated at 400 chars with a pointer to the out-file, so
reading a whole file through the tool was impossible and callers fell back to
a host file-read tool. The daemon-side `fs_read` was never the cause: its own
`offset`/`limit`/`max_bytes` were being cut down again by the generic
long-prose cap in `cleanResponse`. `fs_read` now gets its own budget
(`FILE_READ_INLINE_MAX`, 65536, env `GM_MCP_FILE_READ_INLINE_MAX`), and a new
`max_chars` MCP argument overrides every text budget for one dispatch
(ceiling 1048576). `full_response: true` now lifts the text cap too, so its
"every field verbatim" description is true.

The `verb` argument's description now says the verb set belongs to the running
build and names the real replacement for the four names callers keep guessing:
`fs_readdir` for `fs_list`, `grep`/`codesearch` with a body `glob` filter for
`fs_glob`/`glob`, and `bash`/`exec_js` with `raw_body` for `exec_bash`.

`typescript` is gone from the plain-text verb list. The running build has no
`typescript` verb: dispatching it answered `unknown_verb`, and because the
list routed it down the `raw_body` path the daemon could not even parse the
body (`body_parse_error: true`). Naming it there sent callers to a verb that
cannot work.

## 0.2.2 - a missing runner binary fails fast instead of timing out

When `agentplug-runner` was not installed at `~/.gm-tools/agentplug-runner`,
`ensureSpoolRunnerRunning()` returned without spawning anything, and a fresh
dispatch was still written to the spool. It could never be claimed, so the
caller waited out the full poll timeout and got the generic "daemon may not
have picked up this project" note, with no hint that the runner binary was
absent. A fresh dispatch now checks for the binary before writing: with no
runner and no live daemon heartbeat it returns `error: runner-not-installed`
with the install command instead of queueing. A live shared daemon
short-circuits the check, so projects served by a running daemon are
unaffected. The daemon-liveness note in a timeout reply also names the missing
binary when it applies.

## 0.2.1 - exec-family bodies get a timeoutMs line

gm rejects an `exec_js` body that has no `timeoutMs=<ms>` line. Two bare
bodies sent through the `gm` tool failed with `invalid_args: missing
timeoutMs`, although the tool already carried `timeout_seconds`. The server
now adds `timeoutMs=<timeout_seconds * 1000>` as the first line for `exec_js`,
its aliases, and every language stem. A body that already starts with
`timeoutMs=` or `timeout_ms=` is sent unchanged. `serp`, `browser` and `cdp`
are not changed. The README documents the rule under "Exec-family timeout
prefix".

The plain-text verb list now also names the exec_js aliases (`nodejs`,
`javascript`, `node`, `js`, `typescript`) and the shell aliases (`sh`,
`shell`, `zsh`, `py`, `ps1`). The server refuses a JSON `body` for one of
them with the same message as for `exec_js`.
