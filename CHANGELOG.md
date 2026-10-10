# Changelog

## Unreleased - the shared HTTP server is supervised again

`gm-mcp` is registered as `"type": "http"`, so the agent host never starts the server: when the process holding `127.0.0.1:8787` died, nothing brought it back, and every session that connected afterwards had no `mcp__gm__*` tools until something started it by hand -- the 2026-10-10 outage, where the server's log ends mid-dispatch with no exit line and the port stayed empty until a manual restart. `README.md` already documented the part that was missing from the code: `http-supervise` is now a real command, a detached sibling that probes `/health` every 15 s (`GM_MCP_HTTP_SUPERVISOR_INTERVAL_SECONDS` moves it) and runs the same `ensureHttpSingleton` start path when two consecutive probes answer nothing. Two probes, not one, because a single probe that times out during an index pass or a dispatch storm used to spawn a duplicate that died on `EADDRINUSE`. `ensure-http` arms one on every run, including a run that found a server already up, and a `--http` server arms one for itself on start, so the watcher comes back from any start path; `GM_MCP_HTTP_SUPERVISOR=0` opts out of both and `ensure-http` then prints `supervisor disabled`. Two supervisors on one port are harmless rather than fatal: the revival path probes before it spawns, so the loser of a claim race only ever finds a server already up. The supervisor spawns detached and unref'd, because a supervisor parented by a caller dies with that caller's tree, and it hands `GM_MCP_HTTP_SUPERVISOR=0` to every server it starts so a restarted server does not arm a second one. Its state file `gm-mcp-http-supervisor-<port>.json` is a heartbeat, not a pid: a claim older than 60 s (or four intervals, whichever is longer) is stale, so an exited supervisor cannot block a re-arm forever, and the claim is written by atomic rename. Deaths are observable too: `http-supervisor-restarted` names the pid that stopped answering, `http-listen-failed` records a `listen` refusal such as `EADDRINUSE` before it reaches the top level, and the `exit` record now carries `uptime_ms` so two servers exiting with the same code inside the log's one-minute repeat window each leave their own line. `BUNDLE_VERSION` moves to 0.2.24.

## Unreleased - the HTTP singleton is seeded by every entry point and installed at boot

Registering gm as `"type": "http"` means the agent host never starts the server, so a port nothing was listening on left the whole session without gm tools (`Failed to connect: gm`, and every `mcp__gm__*` tool absent) until somebody rescued it by hand. Seeding was gated on `GM_MCP_HTTP_SINGLETON=1` and only ran in the stdio path, so a host that launched HTTP directly, or any start without that variable, left the port empty. Seeding is now opt-out (`GM_MCP_HTTP_SINGLETON=0` or `GM_MCP_NO_HTTP_SINGLETON=1`) and runs from every entry point: a stdio server, an HTTP server listening on a different port, and `dispatch`, which is the command agents keep running anyway. The spawn stays detached and unref'd, and `dispatch` passes `wait: false`, so a short-lived caller neither waits for the server to come up nor keeps the port's startup time. The state file is dropped before a fresh spawn and the health probe remains the authority, so a file naming a dead or unresponsive pid cannot wedge the next start. `scripts/install-autostart.mjs` installs the boot hook and a five-minute crontab guard idempotently (marker blocks replaced wholesale, `--check`/`--uninstall`, `--entry`/`--hook`/`--cron-file`/`--log`), so the port is listening before any session starts and returns within five minutes after a crash. A long-lived HTTP server also picks up a refreshed deployed bundle instead of running stale bytes forever: when the staleness check swaps the bundle, it closes the listening socket, spawns the replacement, and exits only once the replacement answers `/health` -- with a different pid than its own -- taking the port back if the replacement never arrives, and deferring the whole handover while a dispatch is in flight. `BUNDLE_VERSION` moves to 0.2.23.

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
