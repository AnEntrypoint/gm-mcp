# AGENTS.md

Facts about this repo's source that structure and naming cannot fully carry.
The exec-family `timeoutMs` prefix and the `raw_body`/plain-text-verb contract
are documented in README.md ("Exec-family timeout prefix"); this file covers
what README does not.

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
- `pollTimeoutMs` computes the requested poll budget, not what the daemon enforces.
  An explicit `timeout_seconds` wins; otherwise an exec-family body that starts
  with `timeoutMs=<ms>` requests that value plus 5 s (never less than 120 s),
  because the daemon enforces `timeoutMs` as a wall-clock limit and kills the
  child tree at expiry, answering with `exec_timeout` at that point. The prefix the
  wrapper injects when the body has none is 300000 (`EXEC_DEFAULT_LIMIT_SECONDS`),
  the daemon default, while the poll without a prefix stays 120 s. A `resume_task` poll sends no body, so it only has
  `timeout_seconds` to go on. Every initial or resume poll is capped at 240 s,
  leaving time for bounded preflight and final recheck before a 300 s client
  transport deadline. A poll timeout reports requested/applied budgets and the
  original spool task and paths; it neither cancels nor republishes execution.
- `unpackExecOutputEnvelope` parses the exec family's `data` JSON string into an
  object before cleaning, so `stdout`, `stderr` and `result` keep their own
  16000-character cap (`EXEC_OUTPUT_FIELD_TRUNCATE_AT`) instead of sharing the
  400-character cap of the packed string. The truncation marker names the
  daemon's `result_file` (a plain-text sibling of the out-file, written when a field
  exceeds 2000 characters) and, for a daemon that predates it, the out-file with a
  note that the value sits inside its `data` string. A structured `result` is
  capped by its compact JSON length only when `result_file` is present.
- `src/self-update.js` only replaces the file it is itself running from, and only when that file is the deployed `gm-mcp-server.mjs` under `GM_TOOLS_DIR`/`~/.gm-tools` -- a dev checkout or `src/` run reports `not-deployed-copy` and is never overwritten. The fetch runs after `server.connect` so it can never delay the 30s connect window; the new bundle is served from the next connect, not the current process. `bin/gm-mcp-server.js` on `main` is therefore the live release channel: pushing a drifted bundle publishes it to every deployed copy within an hour.
- **That channel is a bare file swap, so a release that loses a fix silently undoes it** -- the 2026-10-04 08:57 build shipped with `windowsHide: true` on only 1 of 3 child-spawn sites, two releases after those sites were added to `src/`. Three guards now gate `replaceDeployedBundle`, mirroring the runner's own: a freeze (`GM_MCP_NO_SELF_UPDATE` set to anything but `0`/`false`/`no`/`off`, or `gm-mcp-server.no-self-update` in `$AGENTPLUG_HOME` else `~/.agentplug`) checked before the fetch; a local-build pin (`gm-mcp-server.local-build.json`, sha256 + path + version + ts, refused while the installed bundle's sha256 matches) written and cleared by the `pin-local-build`/`unpin-local-build` subcommands in `src/cli.js`; and a strict no-downgrade on `BUNDLE_VERSION` (`src/bundle-version.js`, compared numerically per component, so 0.10.0 beats 0.9.0). Each refusal returns `outcome: 'refused'` with a `code` and logs one stderr line naming the reason, because the check runs in the background where a silent refusal is indistinguishable from a quiet channel. Bumping `BUNDLE_VERSION` is therefore part of every deploy: a release that keeps the installed version is refused by every deployed copy, and the version is read out of the candidate's bytes, so it must survive the bundle -- keep the `BUNDLE_VERSION = "x.y.z"` assignment recognizable to `BUNDLE_VERSION_ASSIGNMENT`. `scripts/build.mjs` derives that banner assignment from the source version; `verify-build` checks the updater parser against it before checking byte drift.
- **Release bridge (`src/release-bridge.js`)** runs on every stdio connect and HTTP start, at most once per interval (10 minutes by default; `gm-mcp-release-bridge.json` under `AGENTPLUG_HOME`; `GM_MCP_RELEASE_BRIDGE_INTERVAL_MS` overrides, `GM_MCP_RELEASE_BRIDGE=0` disables). It upgrades the installed `agentplug-runner` and `gm.wasm` from the latest `AnEntrypoint/agentplug-bin` and `plugkit-bin` releases. Integrity is the published `.sha256` sidecar alone: it proves the bytes match what the release published, not who published them. The runner is taken only when its `--build-info` reports a release build at exactly the release tag's version; `gm.version` is written as bare semver. Each swap renames the installed file to a `.bak-<from>-<stamp>` sibling and never deletes one. A freeze (`GM_MCP_NO_SELF_UPDATE`, `AGENTPLUG_NO_SELF_UPDATE`, or either freeze file) and a runner local-build pin are honored; a non-semver `gm.version`, a `gm.local-dev-sideload.json` marker, or a `gm.build.json` whose `origin` is not `"release"` (the bridge and the runner always write `"release"`; `sideload-plugkit.sh` writes no origin) marks a sideload and is never overwritten. After a swap it sends SIGTERM to the daemon named in this `AGENTPLUG_HOME`'s `daemon-status.json` (its owner lock must agree, and on Linux the pid must be an `agentplug-runner` image) unless that daemon already reports the new sha; a dispatch in flight defers the signal into the state file. The gm client's watchdog respawns the runner.
- `src/response-compact.js` splits the response in two stages. `cleanResponse`
  is lossless housekeeping (strip opaque ids, drop empties except the answer lists in
  `EMPTY_LIST_IS_THE_ANSWER_KEYS`, so an empty pool `candidates` or `live_rows` prints
  as `[]` instead of vanishing, truncate prose with
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
  out. `max_chars` overrides the default limits. `full_response: true` bypasses
  cleaning, data flattening, native-envelope decoding and wire compaction, so
  every original guest field and its data layout remain intact. The response
  file is still bounded by the 4 MiB read limit. An exec-family field
  (`stdout`/`stderr`/`result`) otherwise keeps its own
  `EXEC_OUTPUT_FIELD_TRUNCATE_AT` budget and its `result_file` pointer, so a
  plain dispatch still reads as it did before any of these budgets existed.
  Default responses retain actionable `dispatch_id` evidence. The
  `request_fingerprint` is omitted by default and retained in full responses.
  Compaction runs
  only when the response carries no failure. Faults retain diagnostics, except
  that default responses omit `stdout` when it decodes to a nonempty JSON object
  whose every field is present and deeply equal on the containing fault object.
  This removes a repeated serialization without removing unique diagnostics;
  the response names the original spool file. `full_response: true` retains it.

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

- Count-mode wire compaction requires explicit `ok: true`, `exhaustive: true`,
  no failure or partial diagnostics, and same-length exact `path:count` parity
  between `output` and structured `counts`. Only the derived `output` is omitted;
  all count rows, totals and scan metadata remain whole, with the existing
  full-payload pointer and `full_response: true` restoring the received array.

- `phase_history` is historical context, not the current phase or gate decision.
  The wire retains its newest five transitions in source order and records
  retained/total counts with the existing full-payload pointer. Failure responses
  and `full_response: true` bypass this compaction; current phase, session mismatch,
  and pending-work counts remain authoritative and unshortened. Committed
  `git_commit`/`git_finalize` successes retain at most five received `excluded`
  and `excluded_but_dirty` examples; metadata counts received examples, not
  native totals. Count/truncation fields, requested paths, SHA and authors remain
  whole. Full-payload pointers and `full_response: true` recover the received
  arrays, not examples absent from the native receipt. Failures, refusals and
  uncommitted receipts bypass this shortening.

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

- Plain-text ownership uses a byte-zero `gm_session_id=<owner>\n` header before
  the timeout directive. The guest advertises
  `gm_session_header_version: 1`. MCP probes with safe JSON `phase-status` and
  caches only a coherent result bound to project, daemon boot, PID and GM hash;
  every nonempty GM pool slot must agree. A new hash or a mixed pool invalidates
  the result. Legacy or unverified guests receive the original text with
  `owner_transport: legacy-unverified` or `unverified`; no execution is retried.

- **In-flight dispatches.** `inflightDispatchCount()` feeds the exit and signal records, the self-update check (`deferred-dispatch-inflight`) and the runner-swap signal (`dispatch-in-flight`). A process that quits mid-dispatch strands the spool ticket it already wrote, and nothing polls for its reply.
- **Cwd-less dispatch never guesses.** The root comes from the `cwd` argument, then `GM_MCP_DEFAULT_CWD` or `CLAUDE_PROJECT_DIR`, then the server's own cwd only when that is a git toplevel (or `GM_MCP_ALLOW_PROCESS_CWD=1`). Otherwise the reply is `error: cwd-required`. A shared HTTP server launched from $HOME (not a repo) made the old silent fallback write state into $HOME/.gm while the caller's own spool stayed empty.
- **Leases.** `ensureAgentLease` attaches a project to the daemon by writing `<agentplugDir()>/leases/<key>.<pid>.lease` holding the project root, once per project and pid. The daemon-side rule (it watches a project only while a lease exists) is not verifiable in this repo.
- **Dev sync.** `runDevSync` syncs the parent before its submodules, because the parent's `--ff-only` merge moves the submodule pins; a submodule is fast-forwarded only when it is on `main`. `maybeStartDevSync` never blocks a dispatch: the child is detached and unref'd, stamps are written before the spawn, and one sync starts per 10 minutes across all roots. Stamp keys are absolute roots plus `*` (the global throttle), and no absolute path equals `*`.
- **Errors never exit the stdio server.** `keepServingOnAsyncFailure` (uncaught, unhandled, stdin and stderr errors) and `surviveClientGone` (stdout EPIPE, stdin end) record and continue. A dispatch is a spool ticket someone waits on, and exiting on a dead pipe would turn a recoverable stall into "MCP server has disconnected" for the rest of the session. Each stdout error code is recorded once.
- **Signal exits.** `logSignalExits` records SIGINT, SIGTERM, SIGHUP and SIGBREAK, then exits 0, so the exit status does not show the signal; the `exit` record carries it.
- **Stdout guard.** `isJsonRpcFrame` checks the first byte for `{` before parsing, because every stdout write passes through it and a response can be about 1 MB. Anything that is not a JSON object frame is diverted to stderr as `stdout-write-diverted`.
- **Diagnostics.** `appendDiagnostic` writes every record to stderr and, unless repeat suppression holds it, to `logFilePath()` (`gm-mcp-server.log`, rotated to a single `.1` past 2 MB). An identical event and fields within 60 s are counted rather than written (ignoring `ms`, `inflight`, `dispatches_inflight` and `pid`), and the next write of that key is preceded by a `repeat-suppressed` record. The host discards stderr, so the file is the durable record.
- **HTTP singleton.** `GM_MCP_HTTP_SINGLETON=1` seeds a detached HTTP server that outlives the stdio session, which is why it is opt-in. `ensureHttpSingleton` trusts the health probe on the port over the state file (`gm-mcp-http.json`), which is only a hint. The spawned singleton runs the bundle this process was launched from (`launchedEntryPath`), not whichever `gm-mcp` resolves first.
- **HTTP transport is stateless.** No session id is issued, and every POST builds a fresh server and transport (`serveStatelessMcpRequest`). The SDK throws "Stateless transport cannot be reused across requests" on a second request through one transport, so a shared transport fails after its first call. Every non-POST request to `/mcp` gets a 405.
- **Protocol version.** After `initialize`, the SDK answers 400 to a request whose `mcp-protocol-version` names a version outside `SUPPORTED_PROTOCOL_VERSIONS` (SDK 1.30.0, `validateProtocolVersion`); `initialize` negotiates instead. `normalizeProtocolVersion` therefore rewrites that header to `SUPPORTED_PROTOCOL_VERSIONS[0]` (the newest, 2025-11-25) before the SDK reads it. Without the rewrite, a current client's tool calls get 400 and the server looks dead.
- **Release bridge records.** After a swap, `recordRunnerSwap` writes `agentplug-runner.version` and `last-completed-runner-swap.json` (version and sha256). The daemon's runner-parity check reads them, but that reader is in neither this repo nor rs-plugkit, so it is unverified here. `recordGuestBuild` writes `plugins/gm.build.json` with `source_sha` taken from the release body's `source-head:` line. Release assets are accepted only from `https://github.com/<repo>/releases/download/`. Swaps rename the old file aside, which works on Windows for a running image, and never delete it. When the installed gm already matches the release, `reconcileGuestBuildRecord` still names that build in `gm.build.json`, so a build installed by another updater is recorded.
- **Self-update defers during dispatches.** The bundle swap waits while a dispatch is in flight (`deferred-dispatch-inflight`), because a failure during a dispatch looks the same as a network stall.
- **Verb list.** `RUNNER_REGISTRY_VERBS` (`src/verbs.js`) is a static copy of the runner's verb set. Each entry is registered as its own MCP tool, named by `verbToolName` (hyphens become underscores), and dispatched under its registry name. A verb missing from the list has no tool of its own, but the generic `gm` tool still dispatches it.
- **Witness and probe scripts.** `scripts/pool-observe-served-witness.mjs` checks the pool-observe output of the served client against the candidate contract in rs-plugkit `crates/plugkit-core/src/orchestrator/pool_rank.rs`. `test/mcp-http-probe.mjs [port] [idleSeconds]` and `test/http-session-resume.mjs [port] [idleSeconds]` are manual probes, not part of `npm test`; the second defaults to port 8791, leaving the live singleton on 8787 alone.
- **Stale probe expectations.** `test/http-session-resume.mjs` expects a 200 GET heartbeat carrying `retry:` and an `http-empty-body-ignored` event. Current `src/` answers GET with 405 and emits no such event, so those checks do not match this build (not run).

- **The shared HTTP server is supervised from outside this repo.** The singleton on 8787 is spawned detached and `unref`'d, so nothing in this process tree restarts it: once it dies the port stays dead until some other process happens to seed one, and a client that POSTs straight to the port (a shell bridge such as `gmc.py`) gets `ECONNREFUSED` with no dispatch to seed a replacement. Not OOM and not a crash -- a killed singleton leaves no `exit` record, because `logSignalExits` only records signals a handler runs for. `scripts/install-autostart.mjs` is the fix: it writes a managed marker block into `$HOME/beforestart` (boot) and `$HOME/crontab` (`@reboot` plus a minutely `ensure-http` guard), and runs `ensure-http` once so the port is live before it returns. It is idempotent and probes `/health` first, so it never starts a second server. Idempotent reinstall: `node scripts/install-autostart.mjs`; uninstall: `--uninstall`; dry run: `--check`. Manual revive and status: `node ~/.gm-tools/gm-mcp-server.mjs ensure-http` / `http-status`. The guard log is `$HOME/logs/gm-mcp-autostart.log`; the server log is `gm-mcp-server.log`.
