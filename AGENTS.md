# AGENTS.md

Facts about `src/dispatch.js` that structure and naming cannot fully carry.
The exec-family `timeoutMs` prefix and the `raw_body`/plain-text-verb contract
are documented in README.md ("Exec-family timeout prefix"); this file covers
what README does not.

- **The stdio transport outlives every failure it can absorb.** `src/index.js`
  installs `installStdioGuards()` from `src/transport-guard.js` before
  `server.connect`, and that module is the only place allowed to touch process
  fatal handlers. Three rules, each measured by `.scratch/mcp-dropout/drive-*.mjs`
  against the real bundle: (1) `uncaughtException`, `unhandledRejection`,
  `stdin 'error'` and `stderr 'error'` are logged to stderr and absorbed -- never
  `process.exit`. Before this, one stray async failure anywhere in the process
  took the whole JSON-RPC session down, and a stdio MCP server that exits is
  never respawned by the client: the caller sees the pipe close as ECONNRESET
  and `mcp__gm__gm` is gone for the rest of the session, which is how a dropped
  upstream API connection cost this project its gm tool twice. Witnessed on the
  pre-fix bundle: destroying the client's stdout read end made the next
  `StdioServerTransport.send` emit EPIPE on `process.stdout`, with no `error`
  listener that became an uncaughtException and `process.exit(1)` -- the same
  exit path any unrelated async error reached. (2) `reserveStdoutForJsonRpc`
  owns `process.stdout.write` and `console.log`/`console.info`: stdout is a
  newline-delimited JSON-RPC channel, so a chunk that is not a parseable JSON
  object is diverted to stderr instead of corrupting framing, and every
  diagnostic in this file must therefore use `console.error`. (3) A *broken*
  stdout pipe is the one unrecoverable case -- the client cannot read another
  byte and cannot reconnect to a live stdio process -- so `exitWhenClientGone`
  turns it into `process.exit(0)` instead of a crash, which also keeps a dead
  session from leaking an orphan server into the next one. A *failed dispatch*
  is the opposite case and must never reach it: both `gm` and `gm_instruction`
  wrap `gmDispatch` and return `failedDispatchResult` (`isError: true`) so a
  throwing dispatch keeps the transport serving.
- **Runner recovery.** The daemon exits on purpose and depends on this file to
  bring it back: it self-recycles when idle or over its wasm memory ceiling
  (`self-recycling after 3600000ms fully idle ... next real dispatch spawns a
  fresh process` in `~/.agentplug/daemon.log`), and it hands off to a freshly
  downloaded runner build. A recycle under load therefore happens every few
  minutes, and a cold start costs tens of seconds of wasm compile before the
  first ticket is claimed. Every dead daemon is recovered by
  `ensureSpoolRunnerRunning`, so the only thing between a recycle and a working
  dispatch is how fast this process notices the daemon is gone -- judging that
  from the heartbeat age alone is what let a dead daemon sit undetected for
  `SWEEPER_HEARTBEAT_TRUSTED_MS` (120 s, now gone): `liveDaemonSweepsProject`
  probes `status.json`'s `pid` with `process.kill(pid, 0)` and
  `daemonBootGraceActive` covers the window where a fresh `daemon_boot_ts` in
  `~/.agentplug/daemon-status.json` has not swept any project yet. The ensure
  spawn is idempotent -- a runner started against a live daemon only registers
  the project and exits -- so keep `ENSURE_INTERVAL_MS`/`ENSURE_LEASE_MS` small;
  making them large re-creates the 2-minute dead window in which every dispatch
  writes its ticket, sits `queued_not_yet_claimed` and times out. Recovery used
  to wait for the next dispatch, which cost that one caller its whole poll
  budget, so `startRunnerWatchdog` re-checks every root on a timer (opt out
  with `GM_MCP_RUNNER_WATCHDOG=0`). A project with no `status.json` is never
  "already swept": that is the registration path, not a liveness verdict.
- **Dead-daemon pre-flight.** Liveness is reported long before it is acted on,
  and a ticket written into a dead project's spool stays
  `queued_not_yet_claimed` until the caller's poll budget runs out -- the spool
  cannot answer "nobody is listening". `daemonNotRunning` therefore runs before
  `publishSpoolRequest`: a stale heartbeat gets one `ensureSpoolRunnerRunning`
  plus `DAEMON_START_GRACE_MS` (15 s) to recover, and only then does the call
  return `error: daemon-not-running` unwritten. It deliberately does NOT fire
  on a project with no `status.json` (registration, not death), inside
  `daemonBootGraceActive`, or during `runner_update_in_progress` -- in all three
  a stale heartbeat is expected and the dispatch must still go through. Cold
  start is tens of seconds of wasm compile, so the grace is generous rather
  than tight; the point is that it is bounded and reported, not 120 s of
  silence. `GM_MCP_DAEMON_PREFLIGHT=0` bypasses it.
- **Glob filters are validated here and forwarded untouched.** `codesearch`/`grep`/`codegraph` read `glob`, `path_glob`, `include`, `exclude_glob` and `exclude_globs` as a string or an array of strings in the wasm itself: a leading `!` entry excludes, `{a,b}` brace lists work inside any entry, and every alias is merged rather than dropped. `withGlobFiltersCoerced` therefore only trims entries and fails loudly on what the wasm would silently ignore: a non-string/non-array value, an empty string, an empty array or a blank entry. Never join an array into one brace glob here -- that rewrote entries that already carried `,`/`{`/`}` and refused `!`, the very forms the verb documents. The wasm echoes the applied glob as `path_glob` plus `files_matching_glob`, and sets `glob_matched_no_files: true` when it admits nothing.
- **A dispatch that waited discloses it.** A reply that landed after `DISPATCH_WAIT_DISCLOSED_AT_MS` (5 s) carries `dispatch_waited_ms`, so queue time behind the shared daemon is visible on success and not only on a `timed_out` reply. `codesearch` `timeout_ms` is a scan wall-clock budget (regex default 20000) enforced in the wasm; its overrun reply is `timed_out: true`, `exhaustive: false`, `budget_ms`.
- `TIMEOUT_MS_PREFIX_LINE` mirrors gm/rs-plugkit's own
  `strip_timeout_ms_prefix_directive`: skip leading whitespace, then the first
  line must start with `timeoutMs=` or `timeout_ms=`. Keep the two in sync if
  either changes.
- `deliveredInstructionHashByOwner` caches, per `(project root, session_id)`,
  the hash of the `instruction` prose this process last actually returned to
  that caller. `withAssertedInstructionHash` asserts it on that owner's next
  `instruction` dispatch so gm can reply `instruction_unchanged: true` and
  skip resending tens of kilobytes of prose. The cache is process-lifetime
  only and keyed on session as well as root: a restarted server (a new agent
  session) must see the prose again rather than inherit an assertion it
  cannot honor.
- `pollTimeoutMs` is how long the wrapper polls, not what the daemon enforces.
  An explicit `timeout_seconds` wins; otherwise an exec-family body that starts
  with `timeoutMs=<ms>` is awaited for that value plus 5 s (never less than 120 s),
  because the daemon enforces `timeoutMs` as a wall-clock limit and kills the
  child tree at expiry, answering with `exec_timeout` at that point. The prefix the
  wrapper injects when the body has none is 300000 (`EXEC_DEFAULT_LIMIT_SECONDS`),
  the daemon default, while the poll without a prefix stays 120 s. A `resume_task` poll sends no body, so it only has
  `timeout_seconds` to go on.
- `unpackExecOutputEnvelope` parses the exec family's `data` JSON string into an
  object before cleaning, so `stdout`, `stderr` and `result` keep their own
  16000-character cap (`EXEC_OUTPUT_FIELD_TRUNCATE_AT`) instead of sharing the
  400-character cap of the packed string. The truncation marker names the
  daemon's `result_file` (a plain-text sibling of the out-file, written when a field
  exceeds 2000 characters) and, for a daemon that predates it, the out-file with a
  note that the value sits inside its `data` string. A structured `result` is
  capped by its compact JSON length only when `result_file` is present.
- `src/self-update.js` only replaces the file it is itself running from, and only when that file is the deployed `gm-mcp-server.mjs` under `GM_TOOLS_DIR`/`~/.gm-tools` -- a dev checkout or `src/` run reports `not-deployed-copy` and is never overwritten. The fetch runs after `server.connect` so it can never delay the 30s connect window; the new bundle is served from the next connect, not the current process. `bin/gm-mcp-server.js` on `main` is therefore the live release channel: pushing a drifted bundle publishes it to every deployed copy within an hour.
- **That channel is a bare file swap, so a release that loses a fix silently undoes it** -- the 2026-10-04 08:57 build shipped with `windowsHide: true` on only 1 of 3 child-spawn sites, two releases after those sites were added to `src/`. Three guards now gate `replaceDeployedBundle`, mirroring the runner's own: a freeze (`GM_MCP_NO_SELF_UPDATE` set to anything but `0`/`false`/`no`/`off`, or `gm-mcp-server.no-self-update` in `$AGENTPLUG_HOME` else `~/.agentplug`) checked before the fetch; a local-build pin (`gm-mcp-server.local-build.json`, sha256 + path + version + ts, refused while the installed bundle's sha256 matches) written and cleared by the `pin-local-build`/`unpin-local-build` subcommands in `src/cli.js`; and a strict no-downgrade on `BUNDLE_VERSION` (`src/bundle-version.js`, compared numerically per component, so 0.10.0 beats 0.9.0). Each refusal returns `outcome: 'refused'` with a `code` and logs one stderr line naming the reason, because the check runs in the background where a silent refusal is indistinguishable from a quiet channel. Bumping `BUNDLE_VERSION` is therefore part of every deploy: a release that keeps the installed version is refused by every deployed copy, and the version is read out of the candidate's bytes, so it must survive the bundle -- keep the `BUNDLE_VERSION = "x.y.z"` assignment recognizable to `BUNDLE_VERSION_ASSIGNMENT`.
- `src/response-compact.js` splits the response in two stages. `cleanResponse`
  is lossless housekeeping (strip opaque ids, drop empties, truncate prose with
  a pointer). The pointer's threshold is `LONG_TEXT_FIELD_TRUNCATE_AT`, 400
  chars by default, except for a plain-text-body verb (`isPlainText` in
  `dispatch.js`, already computed for the `raw_body` contract) whose whole
  response gets `PLAIN_TEXT_OUTPUT_INLINE_MAX` -- 32768, read once from the
  env at server start. That verb's response *is* the script's output, so the
  generic cap forced a file read on nearly every `exec_js` call; raising the
  generic cap instead would have un-truncated `instruction`'s prose too, which
  the wire-size measurements below are tuned against. `fs_read` is the third
  case (`FILE_READ_INLINE_MAX`, 65536): at 400 chars every whole-file read came
  back as a pointer and callers gave up on the verb and reached for a host
  file-read tool instead, and `fs_read`'s own daemon-side `offset`/`limit`/
  `max_bytes` were never the cause -- they were being cut down again on the way
  out. `max_chars` is the per-dispatch override of all three and `full_response:
  true` lifts the cap to `LONG_TEXT_INLINE_MAX_CEILING` (1048576), so "every
  field verbatim" in the tool description stays true. An exec-family field
  (`stdout`/`stderr`/`result`) otherwise keeps its own
  `EXEC_OUTPUT_FIELD_TRUNCATE_AT` budget and its `result_file` pointer, so a
  plain dispatch still reads as it did before any of these budgets existed.
  `compactWireResponse` is the lossy stage and is
  the one callers can opt out of with `full_response: true`, which must stay
  byte-identical to the `cleanResponse` output alone -- that identity is the
  regression test, so any new compaction rule has to keep it. Compaction runs
  only when the response carries no failure: a payload with `error`,
  `timed_out`, or `ok: false` is returned whole, because a caller debugging a
  failure needs every field.

- Which fields compact, and why, is a judgment the code cannot restate:
  dropped outright are `route_hint`, `reply_hash`, `orient_nouns` (pure
  routing/telemetry nobody dispatches on), `supply_chain_scan` when it reports
  no findings (kept whole when it has any, and then its `warnings` list is
  capped at 8 with a `warningsOmitted` count beside `warnCount`), and
  `session_owner_before_this_dispatch` unless `session_mismatch` is true.
  Collapsed to counts are `codeinsight_overview` (the `by_kind`/`by_language`/
  `largest_files` breakdowns), `codeinsight_start` (to `{ready: true}` -- kept
  whole when not ready, since that is when it is actionable),
  `config_changed` (newest transition only, 3 keys), `dream_rsi_strategy` and
  `dream_rsi_replay` (evidence/replay rows to counts). Row prose in
  `ready_wave`/`prd_items`/`mutables_pending` and hit prose in
  `recall_hits`/`bm25_hits`/`vector_hits` are excerpted, with `id`/`key`/
  `status`/`session_id`/`verb` exempt so a row stays addressable; `recall_hits`
  also caps at the top 4. Deliberately left whole: `instruction`, `phase`,
  `ok`, `session_id`, `instruction_hash` and `policy_hash` (both are
  assert-protocol inputs the caller resends), `discipline_policies` (emitted
  only when the policy hash moved, and then it is the thing to read), and every
  count field, because a count is already the smallest honest form.

- Measured on real `instruction` out-files (`scripts/measure-wire-size.mjs`):
  7839 -> 3737, 8766 -> 5306, 9507 -> 4959 bytes, and one payload left
  byte-identical because it had nothing worth compacting. Live on this repo's
  own session, back to back: 8815 -> 5355 bytes.
- **Cold project is not a git-root problem.** A cwd that is not a git repo is
  rooted on itself (`projectRootFor` falls back to the directory) and the daemon
  registers and sweeps it like any other: measured 2026-10-05, a fresh non-git
  dir and a fresh `git init` dir both waited 85-110 s for the first claim,
  because the shared daemon (100+ registered projects) serves a cold project
  only after its other work (`queue_wait_ms` 40-90 s). Non-git cwds need no
  `git_root_override`; the timed-out note says so and points at `resume_task`.
