# Changelog

## 0.2.190 - gm_codemode replies expose `.text`, and the generic gm call takes a verb's top-level arguments

A gm_codemode verb call returned a plain string, so `r.text` read undefined. The reply is now a String object whose `.text` is the same text (`replyValue` in `src/codemode.js`); `return` still yields plain text. The generic `gm` call folds top-level keys that the named verb declares into its body (`verbShapedTool`), so `gm.gm({verb: "prd_list", status: "pending"})` is accepted like `gm.prd_list({...})`.

## 0.2.187 - a spool request that is already linked is never reported as failed

`publishSpoolRequest` (`src/dispatch.js`) ran `removeIfPresent` in its `finally`, which rethrew any unlink error other than `ENOENT`. Once `fs.linkSync` had published the request into `in/<verb>/`, an `EPERM`, `EBUSY` or `EACCES` from removing the temp replaced the successful return, so a request already in the spool reported as failed. The cleanup is now `removeTemp`, which ignores every unlink error: a leftover `.tmp` name is harmless because the daemon claims only `.txt` requests. A failed link still rethrows its own error, since the cleanup no longer throws over it. `BUNDLE_VERSION` and `package.json` move to 0.2.187.

## 0.2.186 - a concurrent spool write no longer fails on a temp that vanished

`publishSpoolRequest` (`src/dispatch.js`) wrote each request to a temp file and then hard-linked it into `in/<verb>/`. A remover that took the temp between the write and the link made `fs.linkSync` throw `ENOENT`, and that reply surfaced as a codemode error (log 2026-10-19T12:43:01Z, codesearch). The temp name now carries a `randomUUID()` suffix, so no two writes share a name, and an `ENOENT` from the write or the link is retried as that one write (up to `SPOOL_PUBLISH_ATTEMPTS` = 3, recreating the directory each time). Any other error is thrown unchanged. The cleanup in `finally` ignores `ENOENT`, so a temp another actor already removed no longer throws out of the reply. `BUNDLE_VERSION` and `package.json` move to 0.2.186.

## 0.2.185 - a long gm_codemode body reports that it is alive

A `gm_codemode` body that awaits gm calls for longer than the client's idle window was aborted with no reply, because nothing reached the client between the call and its final reply. While a body runs, `startHeartbeat` (`src/codemode.js`) now sends a `notifications/message` log line every `CODEMODE_HEARTBEAT_MS` (60000, `src/codemode-budget.js`) naming the elapsed seconds, and also a `notifications/progress` when the client supplied a `progressToken`. The timer is cleared in a `finally`, so the reply is returned exactly as before, and a failed heartbeat send is swallowed so it cannot change the reply. A body that blocks the event loop with synchronous calls (for example `execFileSync` in a loop) still emits nothing, because no timer can fire; only bodies that await gm calls get the heartbeat. `BUNDLE_VERSION` and `package.json` move to 0.2.185.

## 0.2.72 - an orphaned leak is reported as its whole tree

`orphan-scan.js` reported only processes whose `ppid` was `1`, so the children of a leaked root were invisible: the 2026-10-15 litebox run left a tree of 12 processes whose root was flagged while its children, several of them the hottest and largest, were not orphans by that rule. Each orphan root now also gets a `trees` entry, one per `items` entry in the same order, built by walking its descendants through the `ppid` field of `/proc/<pid>/stat` (depth 16 and 512 members at most; `truncated` names the bound that cut a walk). A tree is one finding: `leak-watch --json` shows `orphans.trees[]` with `member_count`, `rss_mb` (root included), `max_depth` and the member pids, the one-line summary names each tree beside its root, and the CLI prints a `TREE` line under each root. `orphans.items` keeps its shape. The walk never counts the scanning process or its ancestors. Detection only: nothing signals a pid. `BUNDLE_VERSION` moves to 0.2.72.

## 0.2.69 - a self-update can be asked for now instead of an hour later

The deployed bundle is refreshed by an hourly tick that defers while `<deployed bundle>.checked` is fresher than `GM_MCP_SELF_UPDATE_INTERVAL_MS` (default 3600000), so a fix pushed upstream reached the machine up to an interval later -- measured 2026-10-15: a fix pushed at 19:47 had not landed an hour afterwards, and an agent that pushes a gm fix and immediately keeps working runs the OLD bundle and can conclude its fix did not land. There was no way to trigger a check by hand; `self-update-status` only reads. `gm-mcp-server.js self-update-now` now runs the same check at once through `refreshDeployedBundleNow` (`src/self-update.js`), the same `refreshStaleDeployedBundle` with `ignoreStamp: true`, so the stamp-freshness deferral is the only thing it skips: the freeze file and `GM_MCP_NO_SELF_UPDATE`, the local-build pin, the no-downgrade and `same-build` guards, the size/shebang/`node --check` loadability gates and the inflight-dispatch wait all still stand. It is safe beside a running server on 8787: it starts no server, binds no port, signals no process, arms no retry timer and calls no `onRefreshed`, so it never hands the process over to the bundle it just installed -- the only writes are the deployed bundle itself (the previous is kept as `.prev`) and its `.checked` stamp, which is what the hourly tick already writes. It records the same `self-update-check` diagnostic, marked `forced: true`, and prints the previous and new bundle version plus `describeSelfUpdateOutcome(result)`, which names the reason nothing moved for every other outcome (`current`, `refused <code>`, `deferred-dispatch-inflight`, `no-deployed-copy`, `disabled`). `selfUpdateStatus` and `deployedBundleVersion` give the CLI the before and after versions. The hourly path is unchanged: an unforced check still defers on a fresh stamp. `BUNDLE_VERSION` moves to 0.2.69.

## 0.2.70 - prd-add declares the row fields the served prose promises

`prd_items_truncated.inlined_rows_shape` tells callers a row carries `description`, `acceptance_criteria` and `witness_plan`, and the store agrees, `prd.rs` clones the whole `prd-add` body into the row, minus `overwrite`, so any key sent is persisted and `prd-list` serves it back, but `PRD_ADD_BODY` declared only `id`, `subject`, `status`, `blockedBy`, `overwrite` and `repair`, so `refuseUndeclaredBodyKeys` refused all three by name before the write ran and the prose named fields no caller could set. All three are now declared, and `subject`'s description names the spellings `subject_from_fields` already derives a slug from (`title`, `name`, `task`, `goal`, `description`, `notes`). Nothing about the write changes: the row is stored exactly as before. `BUNDLE_VERSION` moves to 0.2.70.

## 0.2.68 - leak watch reports the orphans gm never spawned

`leak-reaper.js` assesses only pids the child ledger knows, so a process gm never spawned piled up invisibly: 11 `litebox_runner_linux_userland` processes reparented to pid 1 held 3367 MB of a 7.8 GB box at load 4.69 on 2026-10-15, and the hourly pass said nothing about any of them, because none was in the ledger. `src/orphan-scan.js` now rides the same pass and the same single process-table read (no second timer) and reports, in a new additive `orphans` section, every pid whose `ppid` is `1`, that no ledger row claims, whose RSS is at or above `GM_MCP_LEAK_ORPHAN_RSS_MB` (default 150 MB), whose CPU seconds over seconds alive is below `GM_MCP_LEAK_ORPHAN_DUTY` (default `0.02`) and that has been alive at least `GM_MCP_LEAK_ORPHAN_MIN_AGE_MS` (default 900000). The duty ratio is the discriminator: those 11 sat near 0.01 while the one live run of the same binary was still burning CPU. Detection only, nothing here signals a pid, and there is no auto-apply switch, because gm did not spawn an orphan and so cannot classify whether it may be killed. Rss, threads, state and CPU ticks are read from `/proc/<pid>/status` and `/proc/<pid>/stat` per candidate rather than through `ps`, which on such a box can take over 120 s and time out; where there is no `/proc` the section is empty instead of reporting a number it never measured. `BUNDLE_VERSION` moves to 0.2.68.

## 0.2.60 - a fetch page the caller asked for is inlined instead of being left in the spill file

`cleanResponse` inlines every long text field to `LONG_TEXT_FIELD_TRUNCATE_AT` (400 characters) and replaces the rest with `... [N chars total, full text at <spool> field 'content']`, which is right for a whole-document read and wrong for a page. With `fetch` able to read one bounded page (`offset`/`length`, or `start_line`/`end_line`/`lines`), a caller that asked for a page got 400 characters of it and a pointer, so a document still could not be read through the port, which is what paging exists to fix. `inlineMaxForVerb` now gives a `fetch` carrying a page key the file-read budget (`FILE_READ_INLINE_MAX`, 65536) instead of the 400-character one, so the page comes back whole, while the dispatch reply cap still bounds the whole reply. Only a call carrying a page key pays it: an ordinary `fetch` keeps its 6000-character default and its 400-character window, and no other verb's inline budget changes. `BUNDLE_VERSION` moves to 0.2.60.

## 0.2.59 - fetch declares offset/length, start_line/end_line and lines

The guest read one bounded page of a document, but the `fetch` body schema declared none of the nine keys, so `refuseUndeclaredBodyKeys` refused `offset` by name before it ever reached the guest and the paging was unreachable through this port. All nine are now declared in `FETCH_TYPES`/`FETCH_KEYS`, accepted at the top level and folded into the body, and in `FETCH_BODY`, and `FETCH_DESCRIPTION` says what a page reply carries (`offset`, `length`, `total_chars`, `has_more`, `next_offset`, or `start_line`, `end_line`, `lines`, `total_lines`, `has_more`, `next_start_line`), that a character key and a line key may not be mixed, and what `answer_status` means, so `gm.describe("fetch")` is enough to use it. `BUNDLE_VERSION` moves to 0.2.59.

## 0.2.56 - gm_codemode folds a second object argument in instead of dropping it

`bindings` generated every verb as `(args) => call(resolved, args)`, so `gm.git_status({}, {cwd: "C:/dev/gm/rs-plugkit"})`, the envelope-as-second-argument form callers write constantly, lost the whole object with no error and the dispatch ran against the ambient project: a submodule's `git_status` came back as a different repository's status, and no reply said so. A second object argument is now folded into the first (`{...args, ...envelope}`), and a second argument that is not an object is refused rather than dropped, which is the rule `refuseUnknownKeys` already applies to keys. `cwd` as a top-level key of the single object, and `gm.gm({verb, body, cwd})`, both already worked and still do. `git_root_override` now pins `cwd` when a call names no cwd of its own, the same `cwd || git_root_override` rule the per-verb MCP tools apply, so the body field `docs/verbs.md` documents as pinning the root for any verb pins it inside gm_codemode too. `BUNDLE_VERSION` moves to 0.2.56.

## 0.2.55 - codeinsight declares the body it accepts, and callers/callees/impact stop being undeclared

`codeinsight` had no `body` row in the verb table, so `gm.describe("codeinsight")` answered `body_schema.declared: false` and a caller had no way to learn the selector it must send. The table gains `CODEINSIGHT_BODY`: `verb` (aliases `action`, `mode`) enumerating the seventeen actions the Rust handler accepts, plus `symbol`, `path`, `root`, `limit`, `kind`, `max_depth`, `direction`, `through_ambiguous` and `language` with the action each one belongs to. `callers`, `callees` and `impact` take the same schema, because they are the same `code_symbols::handle` body under a verb that preselects the action, so a lane no longer has to guess `{"symbol": ...}` for them either. `codesearch`'s declared `output` enum gains `content`, which the wasm now parses as `compact`. `BUNDLE_VERSION` moves to 0.2.55.

## 0.2.52 - release bridge settles its state once per run

src/release-bridge.js stamps one timestamp per run and builds the pending signal into a single settled state value before the one write that closes the run. The on-disk keys and the checked-recently return are unchanged; a dry run with the interval set large returns checked-recently and keeps last_checked_ts and marker. `BUNDLE_VERSION` moves to 0.2.52.

## 0.2.51 - ci_log reads a CI step's printed text through the spool

The verb table gains `ci_log` (runner spelling `ci-log`, `hyphen: true`) with a declared body schema, so `gm.list()` and `gm.describe()` name it and its fields and a lane stops falling through to `bash` plus `gh run view --log` plus a temp file to read what a step printed. `response-compact.js` returns `CI_LOG_TEXT_KEYS` for it, so a matched line's `text` reaches the caller whole instead of at `LONG_TEXT_FIELD_TRUNCATE_AT` (400 chars), which is what made the fallback worth writing: the truncation pointer sent the caller to the spool out-file anyway. The wasm caps the reply at `max_lines` and `max_chars` before it is ever serialized, so widening the inline cap cannot widen a dispatch. Each returned row carries a 1-based `n`, which also keeps `dropDuplicateRows` from collapsing the repeated lines a CI log is full of. `BUNDLE_VERSION` moves to 0.2.51.

## 0.2.43 - exec_js takes a typed timeoutMs field

The exec-family budget can be given as a `timeoutMs` field on the body object (`{code, timeoutMs}`) as well as by the leading `timeoutMs=<ms>` line of the raw body. `runDispatch` folds the field into that line (`foldTypedTimeoutMs`), so the daemon, the poll budget and the ceiling check see one spelling. Sending both spellings is refused. Before this change a typed `timeoutMs: 1000` on a 5 s busy child ran to completion (dispatch 1791954507602-500-58b60f39766a06e9, duration_ms 5046, timed_out false). `BUNDLE_VERSION` moves to 0.2.43.

## 0.2.40 - a stale server says restart required, with the command

A stale process was reporting `bundle_stale` in the reply, but its restart instruction went to stderr,
which the agent never reads, and the reply carried no command. `bundleStalenessLine` now names
`restart required` and the exact launch command (`node "<installed bundle>"`) whenever the reload is
refused. `bundleStalenessNotice` is no longer deduplicated, so every dispatch reply of a stale process
carries the line; the stderr announcement keeps its once-per-bundle dedupe as `bundleStalenessAnnouncement`.
Measured before on 0.2.39 served with `GM_MCP_BUNDLE_DRIFT_RELOAD=0` and 0.2.40 installed: the reply had
`bundle_stale: true` and no restart text. A current server's reply has no staleness fields.

## Unreleased - the initialize reply names the served surface

A session that connected before the single `gm_codemode` surface kept its cached per-verb tool
list, and after a reconnect saw one tool with nothing saying why. `createServer` now passes
`instructions` to `McpServer`, so every `initialize` reply states that only `gm_codemode` is
registered, that verbs are reached as `gm.<verb>(args)`, and that a client holding a cached list
must re-fetch `tools/list`. Measured on the rebuilt bundle: a fresh `--http --port 8799` instance
answers `initialize` with an `instructions` field and `tools/list` with `gm_codemode` only, while
the shared server on 8787 (the build before this change) answers without `instructions`.

## Unreleased - one notice per stale bundle, and a refusal that names what replaces it

A drift the watch could reload printed its staleness line twice: once by the watch, then again by
the handover that watch started. `handOverStdioToRefreshedBundle` and `handOverToRefreshedBundle`
now print through `bundleStalenessNotice`, the same one-per-installed-bundle dedupe the watch uses,
so a session is told once instead of on every handover. A refusal ended at its own reason --
`a stdio server cannot replace itself without detaching its client` -- which says why nothing will
happen and not what would: the line now ends with `-- to serve it, restart this server process:
a running gm-mcp cannot replace itself, so only a fresh start picks up new code`. Measured on the
rebuilt bundle with `GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS=2`: two notices before this change, one
after, handover still completing (`stdio handed to pid`, the relayed `tools/list` answered).

## Unreleased - a dispatch-wait row is quoted as the snapshot it is, and a lane wait naming no lane says so

`dispatch_wait` was presented as a reading of what the daemon is doing with a dispatch at that
instant. It is a row from `.dispatch-wait.json`, and the daemon rewrites that ledger only when a
dispatch changes stage and on a few answer paths, never on a timer -- so a row can outlive the stage
it names by as long as the dispatch it describes. The row was then read as live truth, which sent a
`C:/dev/needle` caller hunting for a serial lane:

    dispatch_wait.row.state: claimed_waiting_for_serial_lane
    dispatch_wait.row.lane: null

Those two cannot describe one live moment. `dispatch_serial_lane` answers a lane for every verb
except the unserialized set (`bash`, `sh`, `fs_read`, `phase-status`, ...), and
`GmFairnessGuard::acquire_within` returns immediately when the lane is `None`, so a verb with no lane
never queues on one: the row is the stage recorded at the instant of the claim, published because
`note_dispatch_stage` ran, after which the stage advanced to `WaitingForToolQueue` inside the
ledger's 250 ms republish window and that rewrite was dropped. A bare `date` therefore reported
"waiting for this project serial lane" for the whole of a 40-130 s wait it spent somewhere else
entirely.

Two disclosures replace the bare row. `row.snapshot_stale` and a `note` appear once the ledger is
older than 5000 ms, saying the row is a snapshot from then and that `row.stage_age_ms` was measured
at that same moment, so neither number says how long the dispatch has been doing what it is doing
now. And `claimed_waiting_for_serial_lane` with `lane: null` now carries the reason: the daemon
writes a null lane for a verb with no project serial lane, and such a verb is admitted without
waiting for one. Neither changes what is dispatched -- both change what a timed-out reply claims.

Six cases in `test/dispatch-wait-row.test.mjs`: the null-lane caveat, a named lane keeping the plain
state meaning, the caveat not attaching to a stage that is not a lane wait, a fresh ledger reported
as current, a stale one reported as a snapshot, and a ledger with no `ts` not being claimed as one.

## Unreleased - a `timeoutMs` above 900000 is refused with the reason it cannot be bought

`agentplug-host` clamps an exec `timeoutMs` to `HARD_CEILING_MS = 900000` and says nothing. gm-mcp made that silence unrecoverable in two places, and the second one is the same class as the poll-ceiling bug fixed in `c9af05e`: a hard limit that quietly does the wrong thing instead of reporting it.

Validation asked whether `milliseconds > MAX_EXEC_TIMEOUT_MS` (`2147483647 - 5000`), a bound no caller reaches, so `timeoutMs=1800000` passed, was forwarded verbatim, and was clamped to 900000 by the daemon. The timed-out reply then reported `595000` -- a number matching neither the request nor what the daemon enforced. `timeoutInputDiagnostic` now rejects an over-ceiling prefix with `timeoutMs must not exceed 900000 milliseconds: agentplug-host clamps a larger value to that ceiling in silence, so a longer child budget cannot be bought; split the work or resume with resume_task`.

`execLimitMs` had the same ceiling but no return for it: `milliseconds <= EXEC_HARD_CEILING_MS` fell through to the poll-derived default, so the `exec_limit_ms` a pending reply reported was the fall-through figure whenever validation was bypassed. It now answers `Math.min(milliseconds, EXEC_HARD_CEILING_MS)`, so a reported `exec_limit_ms` is what the daemon will actually enforce. Measured on `execLimitMs('bash', 'timeoutMs=1800000\necho ok', 999)`: `595000` before, `900000` after.

## Unreleased - `timeout_seconds` above 240 s is honoured, and a timeout no longer implies the child survives

Two things were true of a long `bash`/`python`/`exec_js` dispatch and neither was visible to the caller. The poll was capped at `MCP_POLL_TIMEOUT_CEILING_MS = 240000`, so `timeout_seconds: 1500` was answered at 240 s with `requested_poll_timeout_ms: 1500000, poll_timeout_capped: true`. And the exec child's own budget was pinned at `EXEC_DEFAULT_LIMIT_SECONDS * 1000 = 300000` no matter what the caller asked for, so the reply could say `claimed_still_in_flight` for work the daemon had already killed at 300 s -- measured on a 300 s python writer: the out-file landed with `{"elapsed_ms":300402,"error_code":"exec_timeout","killed":true,"limit_ms":300000}` while the 240 s reply was still saying "it is still running, not lost". A caller that asked for 400 s got neither the wait nor the work.

The ceiling is now 600000 -- the harness tool-call maximum -- and is read from `GM_MCP_POLL_TIMEOUT_CEILING_MS` per call, so a host with a shorter transport deadline sets it down rather than having 240 s imposed. The cap is no longer a bare boolean: `poll_timeout_capped` is joined by `poll_timeout_ceiling_ms` and `poll_timeout_cap_reason`, a sentence that distinguishes "gm stopped waiting at its ceiling" from "the caller's own budget ran out".

`withTimeoutMsPrefix` now takes `timeout_seconds` and writes the caller's poll budget minus `POLL_MARGIN_PAST_EXEC_TIMEOUT_MS`, floored at `EXEC_DEFAULT_LIMIT_MS` and capped at `EXEC_HARD_CEILING_MS` (900000, agentplug-host's `HARD_CEILING_MS`, above which a `timeoutMs` is clamped in silence). So a 400 s poll buys a 395000 ms child instead of 300000 ms, a short poll still never shortens a child's life, and a body carrying its own `timeoutMs=<ms>` line is still sent unchanged. For exec verbs a pending reply now carries `exec_limit_ms`, `child_reaped_at_exec_limit: true` and an `exec_child` sentence: that gm did not kill the child, that the daemon reaps it at that budget, roughly how long is left, and to resume with a `timeout_seconds` that outlasts it.

## Unreleased - a running server now picks up a newer installed bundle between dispatches

A bundle installed over `~/.gm-tools/gm-mcp-server.mjs` by a lane build, by `dev-sync` or by hand never reached a long-lived server: the only refresh path, `refreshStaleDeployedBundle`, compares the deployed file against a URL, so it answers `current` whenever those two agree, whatever bytes the running process started from. A process runs the bytes it was started from and nothing re-reads them, so the singleton stayed on 0.2.31 while 0.2.32 sat on disk, and no verb said so.

`src/bundle-drift.js` closes that: every 30s the server hashes the file it launched from against the installed one (size+mtime gate first, so the 1 MB hash is taken only when the file moved) and answers `stale` plus `reloadable`. Staleness is now reported three ways -- a `bundle` block on `/health` (and `gm-mcp http-status`), one line on every dispatch reply that is not file content, and one stderr line -- because a silent mismatch is the actual defect: the lane that published 0.2.32 had no way to see it was still talking to 0.2.31. `fs_read`, `result` and `gm_result` are excluded from that line, since their replies are returned byte for byte.

An HTTP server then replaces itself instead of waiting for a reconnect: `handOverToRefreshedBundle` spawns the new bundle with an IPC channel and sends it the listening socket, so both processes hold it and the port is never unbound -- measured over 50s of continuous probing across a handover, 42056 requests, 0 refused, one transition `0.2.34/36660 -> 0.2.35/32508`. The old close-then-bind shape stays as the fallback when the child never reports ready, and `takePortBack` re-listens if the replacement never answers `/health`.

Nothing reloads mid-dispatch. The handover defers while `inflightDispatchCount() > 0` (`bundle-handover-deferred`, retried on the next tick) and the outgoing process drains before `process.exit(0)`, so a reply already being written is finished, not truncated. Measured with a 40s dispatch: a newer bundle installed 4s in, `/health` `stale: true` with the pid unchanged, the dispatch complete at 42.3s carrying the notice, the server on the new bundle only afterwards. `no-downgrade`, `installed-version-unknown`, `running-not-a-bundle` and `transport-stdio` report and refuse rather than reload; a stdio server names the mismatch and asks for a reconnect.

## Unreleased - a verb body field named `body` no longer collides with the dispatch envelope

`foldVerbArgs` sorts a `gm.<verb>({...})` call into the dispatch envelope and the verb body by key: a key the tool schema declares stays at the top level, anything else moves into `body`. `body` is declared by every verb tool, because it is the dispatch envelope's body -- and `prd-add` also names its row prose `body`. So `gm.prd_add({id, subject, body, session_id})` put the prose in the envelope's `body`, and when that string did not decode as JSON the fold gave up and returned the envelope alone: `id` and `subject` were dropped, and the prose itself became the request body. `normalizedObjectBody` writes a string body that does not open with `{` out as literal raw text, so the spool file held `Grass near LOD is picked per 32 m chunk by an 8 m stride.` at byte 0 and the runner refused it before `prd-add` ever ran.

The fold now asks the same question `normalizedObjectBody` asks -- does this string open with `{` -- and treats anything that does not as the verb's own field, so it lands as `body:{id, subject, body}` exactly as `gm.gm({verb:'prd-add', body:{id, subject, body}})` sends it. A string that does open with `{` keeps the dispatch-body path, including the repair hint a malformed JSON body gets.

Measured by driving the real tool over a real MCP session -- a server started from the built bundle, `initialize`, `notifications/initialized`, then `tools/call` on `gm_codemode` -- against `C:/dev/spoint`, before and after:

| call inside `gm_codemode` | before | after |
| --- | --- | --- |
| `gm.prd_add({id, subject, body, session_id})` | `error_code: failed`, `body_parse_error: true`, `body_parse_error_offset: 0`, `executed: false` | `ok:true, verb: prd-add, added: GM-VERB-BODY-SHAPE-TEST-7391` |
| `gm['prd-add']({id, subject, body, session_id})` | same refusal | `ok:true, verb: prd-add, added: GM-VERB-BODY-SHAPE-TEST-7391-H` |
| `gm.gm({verb:'prd-add', body:{id, subject, body, session_id}})` | `ok:true` (the workaround) | `ok:true, verb: prd-add, added: GM-VERB-BODY-SHAPE-TEST-7391-ENV` |

The row is the non-vacuity proof: `prd_list {id:'GM-VERB-BODY-SHAPE-TEST-7391'}` answers `body: Grass near LOD is picked per 32 m chunk by an 8 m stride.`, so the prose reached the row and not only the request.


## Unreleased - a search reply that lists no hits now says whether that zero is a finding

`codesearch` returning nothing and `codesearch` proving the needle is absent were the same bytes on the
wire: `{ok: true, matches: []}`. An agent searching for a symbol, getting that back, concludes the code
does not exist and writes a fix against a phantom. The scan already reported the difference --
`budget_exhausted`, `files_truncated`, `listing_incomplete`, `matches_truncated`, `partial`,
`exhaustive: false` -- but those sat beside `matches: []` at the same depth as it, so nothing
distinguished "I looked everywhere" from "I looked at some of it" or from "I looked at nothing".

`withSearchIncompleteness` now runs on every search reply (`codesearch`, `grep`, `codeinsight`,
`code_index`, `callers`, `callees`, `impact`) before it is cleaned, and annotates exactly the ambiguous
shape:

| reply | before | after |
| --- | --- | --- |
| `files_scanned: 0`, no matches | `ok:true, matches: []` | `searched_zero_files: true` plus `zero_hits_is_not_a_finding: "the scan searched 0 files, so this empty result is a scanner failure and NOT a finding..." |
| no matches, `exhaustive: false` | `ok:true, matches: []` | `zero_hits_is_not_a_finding: "0 hits shown, but the scan was INCOMPLETE (exhaustive:false), so this zero is UNPROVEN and NOT a finding..." |
| no matches, `budget_exhausted: true` | `ok:true, matches: []` | same banner, naming `budget_exhausted` |
| no matches, `exhaustive: true` | `ok:true, matches: []` | untouched -- that zero is a finding |
| matches found, `exhaustive: false` | unchanged | untouched -- a non-empty result is not ambiguous |

Both keys are placed first in the reply so they are the first line read, and both are in
`NEVER_TRUNCATE_KEYS` so a reply cut at a small `max_chars` keeps the sentence instead of an ellipsis.
The annotation is deliberately silent whenever the scan was complete or the result is non-empty: an
unscoped scan over a large tree is `exhaustive: false` by exclusion rule alone, so flagging every such
call would bury the one that matters. `test/response-compact.test.mjs` pins all five rows, including
that the banner survives `cleanResponse` at `inlineMax` 40 and survives `compactWireResponse`.
## Unreleased - a landed spool file is refused as a link before its target is resolved

Two defects in the landed-result read, both found by `verify` running on linux and macos for the first time (run 38224832255, head 4081582c; windows-latest passed because it skips both of them):

- `validateSpoolFile` resolved the spool path before it looked at what the path names, so a link was refused by the containment check as `spool file resolves outside the .gm/exec-spool/out directory that names it: <...>/out/instruction-escape.json` rather than as a non-regular file. That containment message is not the message `test/landed-output.test.mjs` pinned, so the assertion held only on the platform that skipped the test: on linux and macos -- where the test ran -- it failed, even though both refusals refuse and neither reads the target. A link is now refused by `lstat` before `realpath` touches it, so the answer is `spool file must be an unlinked regular spool file` whether the link escapes the spool or not, and the target is never resolved at all.

- `openSpoolRegularFile` asked `/dev/fd/<fd>` (darwin) or `/proc/self/fd/<fd>` (linux) for the open file's path and compared it with the realpath of the spool out directory. On darwin that entry does not resolve to the open file, so `path.relative` walked up out of the out directory and every landed result in the project was refused as `spool file is outside the GM output spool`, which is the `reply.ok === undefined` at `test/landed-output.test.mjs:42` on macos-latest; windows has no descriptor root and skipped the check entirely, and linux escaped it only because `/tmp` is not a symlink. The descriptor root is gone: the question is now asked of the path the descriptor was opened from, by device and inode, after the open -- which is the window a descriptor path could only guess at -- and it is the same code on every platform, so the platform that runs it is not the platform that decides it.

Measured on a Windows box with `node test/landed-output.test.mjs`, before and after. The link fixtures are junctions on win32 and symlinks elsewhere -- a junction needs no privilege, so the link class is witnessed on every platform instead of only on the three that skipped it -- and each link target carries a secret that must not appear in the refusal:

| landed file | before | after |
| --- | --- | --- |
| regular file | read | read (unchanged) |
| hardlink to a file outside the spool | `spool file must be an unlinked regular spool file` | unchanged |
| link inside the spool | `spool file must be an unlinked regular spool file` | unchanged |
| link escaping the spool | `spool file resolves outside the .gm/exec-spool/out directory that names it: <...>/out/instruction-escape.json` | `spool file must be an unlinked regular spool file` |
| out directory that is a link elsewhere | `spool file resolves outside the .gm/exec-spool/out directory that names it` | unchanged |
| darwin, regular file (CI macos-latest) | `reply.ok` undefined, every landed result refused | the windows path, which reads it |

The escaping-link row is the non-vacuity proof: that case fails on this box before the change and passes after, so the fix is witnessed here and not only on a darwin runner. The darwin row is the one row this box cannot measure, which is why the descriptor check had to stop being darwin-shaped: with the check gone from `/dev/fd`, darwin runs exactly the code windows runs. `landed-output.test.mjs` goes from 2 passed on windows to 5, and the whole `npm test` set passes.

`bin/gm-mcp-server.js` was stale at 2928aaa -- committed 936154 bytes against a fresh build of 937062 -- which is why `verify` failed at its first step on all four platforms and never reached the contracts; it is rebuilt in this commit, as `check-bin-drift` requires.

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

`src/release-bridge.js` upgrades the installed `agentplug-runner` from `AnEntrypoint/agentplug-bin` and the `gm` guest (`gm.wasm`) from `AnEntrypoint/plugkit-bin` on server start, at most once per 10 minutes. Verification is the release's `.sha256` sidecar. Each swap keeps the replaced file as a backup, and a successful swap signals the daemon of this `AGENTPLUG_HOME` so the next dispatch respawns the new build. `BUNDLE_VERSION` moves to 0.2.12.

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
