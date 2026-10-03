# AGENTS.md

Facts about `src/dispatch.js` that structure and naming cannot fully carry.
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
