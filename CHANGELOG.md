# Changelog

## Unreleased - a timed-out dispatch now reports what it is waiting on

An `instruction` dispatch on `C:\dev\mc-420` (2026-10-06) timed out at 120 s and
again at 300 s with no answer and no clue why. The cause was a cold
codeinsight pass, not a hang: the daemon's own log shows
`codeinsight_symbols_synced` running 63 765 ms with `files_deferred: 179` and
`complete: false`, and once that index warms the same verb answers in 5.6 s.
Nothing told the caller any of this.

A timed-out dispatch already carried `dispatch_state` (claimed vs queued) and
`daemon` liveness, but no stage, so the only message available was "still
running". The timeout reply now also carries `progress`:
`readDispatchWaitProgress()` reads the daemon's `.dispatch-wait.json` and
returns the row for this task -- `state`, `stage_age_ms`, `file_age_ms`, the
serial `lane`, and the admission gate -- with a note saying to resume rather
than re-dispatch. When the daemon has published no ledger the field says so
instead of going missing, so the caller can tell "no finer-grained progress
exists" from "this dispatch is stuck".

On the daemon side `refresh_dispatch_wait_ledger()` no longer deletes a ledger
another live daemon published: it only removes the file when the `daemon_pid`
inside it is this process or its `ts` is older than
`DISPATCH_WAIT_LEDGER_STALE_MS`. Several runners share one spool, and each was
deleting the ledger the others had just written, so the file was absent exactly
when a caller needed it.

## Unreleased - gm-mcp also serves streamable HTTP, so a lost connection is no longer permanent

A Claude Code session lost its `gm` MCP connection mid-session (2026-10-05, cwd
`C:\dev\mc-420`): `mcp__gm__gm` answered "No such tool available ... Its MCP
server 'gm' has disconnected" for the rest of the session. The server was not
at fault -- a fresh stdio session ran initialize, two real `git_status`
dispatches and a 45 s idle hold without a hiccup. The defect is structural:
`gm` is registered as a user-scope **stdio** server, so the client owns one
child process on one pipe, and when that pipe goes the tool is gone with no way
to re-attach -- not by the server, and not by the client until it is restarted.

Two changes. `src/transport-guard.js` no longer treats a dead pipe as a reason
to die: `exitWhenClientGone()` is replaced by `surviveClientGone()`, which logs
the EPIPE once per error kind and keeps serving, and `logSignalExits()` names
the signal on the way out so a SIGTERM kill is distinguishable from a crash.
Exiting could only ever turn a recoverable stall into a guaranteed disconnect.

`src/http-transport.js` adds a **streamable HTTP** transport (stateless: no
session id, one request per call) on `127.0.0.1:8787/mcp`, with `/health`.
`src/singleton.js` keeps exactly one per machine -- health probe first, spawn
detached only when nothing answers -- and a stdio server seeds it on startup so
the durable transport is already up before anything asks for it. `ensure-http`
and `http-status` are new CLI commands. Switching the registration over is a
one-liner that needs nothing installed:

    claude mcp remove gm -s user && claude mcp add --transport http gm http://127.0.0.1:8787/mcp -s user

A first cut held one shared stateless transport across requests: it answered its
first request and then 500'd every later one, a worse failure than the drop it
replaced, so a fresh server and transport are now built per request.

## Unreleased - the MCP shim survives an async fault, and no gm-mcp server signals another process

A Claude Code session lost its `gm` MCP connection mid-session (2026-10-05, cwd
`C:\dev\train`): two parallel `codesearch` dispatches answered "No such tool available:
mcp__gm__gm. Its MCP server 'gm' has disconnected" while the server process was still
alive and idle, and the only record of what happened went to stderr, which the host
discards. Two defects made that possible and neither is recoverable by hand.

`main()` installed `uncaughtException`/`unhandledRejection` handlers that called
`process.exit(1)`, so any async fault anywhere in the process took the whole stdio
transport down with it. `src/transport-guard.js` now absorbs those into a log line and
keeps serving, and defers even the one legitimate exit -- a broken stdout pipe, i.e. a
client that is really gone -- until no dispatch is in flight.

`claimGlobalLauncher()` in `src/dispatch.js` killed the pid named in the shared
`~/.agentplug/spool-launch.lock` once that lock was older than
`ENSURE_CHILD_MAX_AGE_MS`, with no check that the pid was the runner it had spawned. The
lock is written with the claiming server's own pid first and only overwritten with the
child's pid afterwards, so a contended write or pid reuse leaves another session's live
gm-mcp server in it -- and that session loses its MCP connection. The lock now records a
`role` (`server` or `runner`) and is only ever stolen, never signalled; a wedged runner
is already bounded by the max-age rule and the per-root in-flight guard.

Every event above is appended to `~/.gm-tools/gm-mcp-server.log` (one JSON line each,
4 MB cap, `GM_MCP_LOG_PATH` to move it), so the next drop names its own cause instead of
leaving a dead connection and a discarded stderr.

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
