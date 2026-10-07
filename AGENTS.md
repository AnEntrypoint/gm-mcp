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
  throwing dispatch keeps the transport serving. Rule (3) was itself wrong and
  is now reversed: `exitWhenClientGone` is gone, replaced by `surviveClientGone`,
  which logs the EPIPE once per error kind and keeps serving. Exiting cannot
  make a dead pipe live again, and it guarantees the one outcome that is
  unrecoverable -- a session whose `mcp__gm__gm` is gone until it is restarted.
  `logSignalExits()` names SIGINT/SIGTERM/SIGHUP/SIGBREAK on the way out so a
  client-driven kill leaves a record instead of a silent disappearance.
- **The durable transport is stateless HTTP; stdio is the one that can be
  lost.** A stdio MCP server is a child process the client owns on a pipe, and
  when that pipe goes there is nothing to re-attach: not the server, and not
  the client until it restarts. `src/http-transport.js` therefore serves
  streamable HTTP on `127.0.0.1:8787/mcp` with a `/health` route, stateless
  (no session id) so a client that vanishes and returns is just another
  request. `src/singleton.js` keeps one per machine -- health probe first,
  spawn detached only when nothing answers, never by pid alone, since a state
  file naming a live pid says nothing about who holds the port -- and a stdio
  server seeds it on start so the durable transport is up before anything asks
  for it. **One shared stateless transport answers its first request and then
  500s every later one**, so `startHttpServer` builds a fresh `McpServer` and
  `StreamableHTTPServerTransport` per request; do not hoist them back out to
  save a millisecond. Registering it is `claude mcp add --transport http gm
  http://127.0.0.1:8787/mcp -s user`.
- **The supervisor has to be started by Task Scheduler, not by whoever asked
  for it.** `ensureHttpSupervisor` spawning a detached child still makes that
  child part of the caller's tree, and a stdio server seeding the singleton, the
  `--http` server, and the supervisor it arms all die in one teardown -- which
  leaves the port empty until the next task tick. So on Windows the supervisor
  is started with `schtasks /run /tn gm-mcp-http-supervise-<port>`: the
  scheduler host parents it, and no session exit reaches it. Off Windows, and
  with `GM_MCP_HTTP_AUTOSTART_TASK=0`, it falls back to the detached spawn.
- **A 202 on `notifications/initialized` is the dropout.** The SDK's HTTP client
  reads 202 for that one notification as "accepted, I will push to you later" and
  then opens a standalone `GET /mcp` SSE stream (`_startOrAuthSse`) and holds it
  for the life of the session. This server has nothing to push, so that stream is
  a bare heartbeat and is the session's only long-lived connection; every time it
  ends -- a client-side idle timeout, a reaped socket, any abort -- the SDK raises
  `transport.onerror("SSE stream disconnected")` and re-GETs immediately. A host
  that counts those errors exhausts its reconnect budget, marks the server failed,
  and never dials again: every later `mcp__gm__gm` call answers "has disconnected"
  while the server is provably up and still serving *other* clients. That is why
  the failure reads as per-session and lands "after a few dispatches or minutes of
  idle" -- an idle session's stream dies, a busy one keeps replacing it with
  POSTs. Measured on this box: the 0.2.5 bundle opened 1 SSE stream per connect,
  the 0.2.6 bundle opens 0. `src/http-transport.js` therefore answers a JSON-RPC
  **notification** 200 (not 202) by remapping the SDK's status in
  `answerNotificationsWithOk`; the client's `send()` then falls into its
  "no requests in message but got 200 OK" branch, releases the connection and
  opens no stream. Only the status changes, and only for notifications -- a
  request still gets its JSON reply. Do not "restore" the 202 for spec tidiness:
  the standalone stream is pure liability for a server with nothing to push. The
  `GET /mcp` handler stays for clients that open one anyway, and now sends
  `retry:` so a stream that ends is not retried in a hot loop.
- **The supervisor's health probe false-negatives on a busy server.** `probeHealth`
  gives a request 1.5 s; this box runs GPU jobs and index passes that hold a busy
  server past that, and the supervisor reads a null probe as "restart the server",
  spawning a duplicate that then dies on EADDRINUSE and is logged as a restart of
  a server that never went away (`http-supervisor-restarted` at
  2026-10-07T13:52:44 names pid 24552, up the whole time). `ensureHttpSingleton`
  now probes a second time before treating the port as free and logs
  `http-singleton-probe-false-negative` when the first probe was wrong. It does
  not kill the live server -- but it is the "is the supervisor killing it?" answer:
  it never kills, it only spawns noisily.
- **A supervisor is proven alive by its state-file heartbeat, never by `pidAlive`
  on a recorded pid.** `ensureHttpSupervisor` used to return `already-running`
  whenever some process held the pid it had written, so one exited supervisor
  blocked every later re-arm for as long as Windows kept that pid recycled --
  pid 7528, an unrelated HTTP server, is what the 0.2.6 bundle accepted as the
  live supervisor for port 8795 while nothing was supervising it. The state file
  is now refreshed every `SUPERVISOR_STATE_BEAT_MS` (15 s) and trusted only
  within `SUPERVISOR_STATE_STALE_MS` (60 s); a supervisor that finds another pid
  owning its port exits (`http-supervisor-superseded`) rather than supervising
  twice. Consequence: `ensure-http` re-arms a genuinely dead supervisor within
  one server re-arm tick (5 min) instead of never.
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
- **Nothing in this process signals another process.** `claimGlobalLauncher` (`src/dispatch.js`) used to `process.kill()` the pid named in `~/.agentplug/spool-launch.lock` whenever the lock was older than `ENSURE_CHILD_MAX_AGE_MS` and the pid answered a liveness probe. That pid is read back from disk long after it was written, and the lock is written with the claiming server's OWN pid first and only overwritten with the spawned runner's pid afterwards -- so a contended write (two gm-mcp servers on one box) or plain pid reuse leaves a live, innocent pid in it, and another session's server then killed it. Measured 2026-10-05 on this box: a Claude Code session in `C:\dev\train` lost its `gm` MCP connection with the server process still alive and idle (0.73 s CPU over 56 min), and every `mcp__gm__gm` call after that answered "Its MCP server 'gm' has disconnected". The lock is now only ever stolen (unlink plus re-claim) and every steal is logged; a wedged runner is already bounded by `ENSURE_CHILD_MAX_AGE_MS` and `runnerEnsureInFlight`, and a fresh `agentplug-runner spool` against a live daemon only registers the project and exits, so nothing needs the kill.
- **The stdio transport outlives every async fault.** `src/transport-guard.js` absorbs `uncaughtException`, `unhandledRejection` and stdio errors into the log instead of `process.exit(1)` (which is what turned one async fault into a whole-session disconnect), and defers even the one legitimate exit -- a broken stdout pipe -- while `inflightDispatchCount() > 0`, so a dispatch already written to the spool is never abandoned mid-flight.
- **Every drop leaves a record on disk.** `src/server-log.js` appends one JSON line per event (start, exit, dispatch-start, dispatch-end, dispatch-threw, uncaught-exception, unhandled-rejection, stdin-ended, stdout-write-diverted, launcher-lock-stolen, runner-spawn-failed, self-update-*) to `~/.gm-tools/gm-mcp-server.log`, trimming to the last 512 KB past 4 MB. The host discards this process's stderr, so without that file a disconnect is undiagnosable -- which is exactly why the 2026-10-05 drop could only be narrowed from circumstantial evidence and not proven. `GM_MCP_LOG_PATH` overrides the path.
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
  `timeout_seconds` to go on. "Wins" means it also beats the client-deadline
  ceiling: `applyClientDeadline` clamps an unnamed budget to
  `GM_MCP_CLIENT_DEADLINE_SECONDS` (default 60, a measurement of one client)
  minus `CLIENT_DEADLINE_MARGIN_MS`, but never clamps a budget the caller named,
  so `timeout_seconds: 240` really polls for 240 s -- clipping it to 58.5 s is
  what made an 83 s `mutable-add` answer `timed_out` while its reply landed in
  `out_path` 20 s after gm stopped looking. An operator-set
  `GM_MCP_CLIENT_DEADLINE_SECONDS` (set, not defaulted) still caps everything,
  since then it is a fact about the client rather than a guess.
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
