# Changelog

## Unreleased - a POST naming one Accept type is answered, not refused with 406

Measured 2026-10-07 against the shared server on 8787: a POST whose `Accept`
names only `application/json`, only `text/event-stream`, or nothing at all is
answered `406` with the JSON-RPC body `{"code":-32000,"message":"Not Acceptable:
Client must accept both application/json and text/event-stream"}`. That is the
same shape as the `-32700` this transport already refuses to send -- a non-200
carrying a JSON-RPC error object, which an MCP client may read as fatal and turn
into a whole-session disconnect. `gm-mcp-http-8787.log` at
2026-10-07T16:52:08.448Z is one real request it answered that way, raised as
`http-transport-error` by the bundled SDK's `handlePostRequest`.

- `serveMcpRequest` rewrites `Accept` to `application/json, text/event-stream`
  when the request's own does not name both types, in `headers` and in
  `rawHeaders` alike, the way `mcp-protocol-version` is already normalized. A
  client that asks for one type, or names none, is asking for whatever the
  server has, not for the session to end.
- every rewrite is recorded as `http-accept-normalized` with the requested and
  served values.

A server that cannot bind its port now names why on stderr -- `gm-mcp 0.2.8:
cannot serve http://127.0.0.1:8899/mcp -- another process already holds
127.0.0.1:8899, so the shared server on that port is serving /mcp without this
one` -- instead of exiting on a bare `EADDRINUSE` stack, so a held port never
reads as gm-mcp dying for no reason.

BUNDLE_VERSION 0.2.8, deployed to `~/.gm-tools/gm-mcp-server.mjs` (sha256
cabbe94e79b1674f6ba1c0a6888b4866747d7386602b743bc9455b2e5d13ffe3) and pinned as
a local build there.

## Unreleased - the supervisor is started by Task Scheduler, not by the session that asked

Measured 2026-10-07 on 8787: three supervisor + server pairs started inside a
caller's process tree (`http-singleton-started` at 18:40:18, 18:49:56 and
18:50:17) were all gone within ten minutes, each with no `exit` record and
nothing on stderr -- killed, not crashed -- while the pair Task Scheduler
started at 18:55:53, whose parent is `svchost.exe`, is the one still serving.
`ensureHttpSupervisor` spawned the supervisor as a child of whatever asked for
it: a stdio server seeding the singleton, a `--http` server, or a CLI run.
`detached: true` makes a child outlive its parent's console, not its parent's
tree, so one teardown took the supervisor and the server it had started, and
the port stayed empty until the next task tick.

- `ensureHttpSupervisor` starts the supervisor through its own scheduled task
  (`schtasks /run /tn gm-mcp-http-supervise-<port>`) on Windows, creating the
  task first when it is missing, so the scheduler host parents it and no
  session exit can reach it. Off Windows, and with
  `GM_MCP_HTTP_AUTOSTART_TASK=0`, it still spawns the detached child. A `/run`
  that refuses is reported as `task-already-running`: an instance of that task
  *is* `http-supervise`, so the refusal is itself proof a supervisor holds the
  port (measured 0x80070420 while one was up) and spawning anyway would race it.
- the task interval is 1 minute instead of 5. A supervisor started through the
  task *is* the task's instance, so the scheduler does not fire again while it
  lives and the short interval costs no extra process in steady state; it is
  only the bound on the window after one kill takes both processes.

BUNDLE_VERSION 0.2.8, deployed to `~/.gm-tools/gm-mcp-server.mjs`.

## Unreleased - a supervisor that stopped running is replaced, not trusted

Measured 2026-10-07: the shared server on 8787 (pid 18824) stopped logging at
16:35:10 with no `exit` record, and nothing replaced it for the rest of the
session -- every `mcp__gm__gm` call answered "MCP server gm is not connected"
while the port sat empty. The supervisor that was supposed to replace it was
itself gone, and the server's own 5-minute re-arm had been reporting
`already-running` the whole time: it trusted `pidAlive` on a pid written hours
earlier, and Windows hands a freed pid to an unrelated process within minutes,
so "that pid is taken" was read as "the supervisor is up".

Witnessed before and after on a scratch port with one state file naming a live
but unrelated pid and a 10-minute-stale `ts`: 0.2.6 answers
`supervisor already-running (pid 7528)` and spawns nothing; 0.2.7 answers
`supervisor spawned (pid 22684)`.

- supervisor state is a heartbeat: refreshed every 15 s, trusted within 60 s.
- a supervisor that finds another pid owning its port exits instead of running
  in duplicate.
- one throwing probe used to leave the supervision loop, return from
  `runHttpSupervisor` and exit the process -- supervision ended because a single
  fetch rejected. A failed round is now logged and repeated.
- the detached server's stdout/stderr goes to `gm-mcp-http-<port>.log` instead
  of `stdio: 'ignore'`. That is why this death had no cause on record: a V8
  abort skips every exit handler and writes only to stderr.
- `ensure-http` installs a per-user 5-minute task running `http-supervise`.
  The logon autostart covers a reboot, not a kill: when a parent teardown takes
  server and supervisor together, a task is the one restarter outside both.
  Remove it with `schtasks /delete /tn gm-mcp-http-supervise-8787 /f`, or never
  install it with `GM_MCP_HTTP_AUTOSTART_TASK=0`.

BUNDLE_VERSION 0.2.7, deployed to `~/.gm-tools/gm-mcp-server.mjs` and pinned.

## Unreleased - the HTTP transport never drops a client it can still serve

Measured 2026-10-07: a session in `C:\dev\train` called `mcp__gm__gm` at
23:29, then every call from 04:07 on answered "Its MCP server 'gm' has
disconnected" for the remaining four hours while port 8787 answered a fresh
client fine. Two things set that up.

The shared HTTP server was not running. pid 8396 took the port at 22:30 and
pid 21940 had to be started again at 04:07:02 -- both gone with no `exit`
diagnostic, so killed, not crashed -- and nothing was watching the port
until 04:32. `WaitForMcpServers` then reported `Failed to connect: gm` at
04:07:49 with the server already 47 s old, and the server logged no request
at all in that window: the client did not retry, it reported a connection it
had already memoized as failed, and it keeps that verdict for the life of the
session. That half is Claude Code's, not ours -- no server-side reply can
make a client re-connect. What is ours is the window in which the server was
down, so the server is now harder to lose and more forgiving to come back to:

- `startHttpServer` sets `keepAliveTimeout` 300 s and `headersTimeout` 310 s
  (node defaults 5 s and 60 s). A client holds one keep-alive socket for a
  whole session; the old 5 s default closed it underneath a client about to
  reuse it, and a POST lost that way is unrecoverable. `test/http-session-resume.mjs`
  holds one socket idle 12 s and then serves a request on it.
- An empty POST is answered `202` with an empty body and logged as
  `http-empty-body-ignored`, instead of the SDK's `400 Parse error: Invalid
  JSON`. 400 is the one status an MCP client may read as fatal; 202 is what
  the SDK's own client reads as "accepted, nothing to read". 39 of these had
  been served as 400.
- `GET` carries `Allow: GET, POST, DELETE`, so a client that opens a stream
  can tell "no stream here" from a dead server. No session is ever issued, so
  there is no session id to expire and none to reap: an unknown
  `mcp-session-id` on `DELETE` is answered, not 404'd.
- The `--http` server re-asserts its supervisor every 5 min
  (`GM_MCP_HTTP_SUPERVISOR_REARM_SECONDS`) instead of arming it once. The
  supervisor is the only thing that restarts a dead server and it is just
  another detached process: killed, it stayed dead, and the gap before 04:32
  was long enough to strand a session permanently. Re-arming is a no-op while
  its pid is alive -- measured one spawned pid across ten re-arm attempts.

## Unreleased - `dispatch <verb>` runs a verb with no MCP client involved

A running agent host cannot gain the `mcp__gm__*` tools: Claude Code fixes its
tool list at startup, `reload_plugins` and `mcp_reconnect` both answer `Server
not found` for a server added after startup, and no file watcher re-reads
`mcpServers`. So a session that predates the registration has no way in, and
the same is true of any shell. `dispatch` closes that: it runs the identical
`runDispatch` path the `gm` MCP tool runs and prints the reply.

    node gm-mcp-server.js dispatch grep --body {"pattern":"foo","output_mode":"content"} --cwd C:/dev/proj
    node gm-mcp-server.js dispatch codesearch '{"query":"chunk merger"}' --cwd C:/dev/proj
    node gm-mcp-server.js dispatch fetch --raw https://example.com

`--body` takes JSON inline, `@path`, or `-` for stdin; `--raw` takes plain text
for the serp/browser/cdp verbs; a bare argument is read as JSON when it starts
with `{` and as raw text otherwise, so `--cwd` and friends are never mistaken
for a payload. Exit status is 1 when the reply starts with `error:`. Diagnostics
still land in `~/.gm-tools/gm-mcp-server.log` but no longer echo to stderr
(`GM_MCP_LOG_STDERR=0`), because a CLI subcommand owns its stderr while a stdio
server's stderr is the only channel the host keeps. `gm dispatch ...` and
`gm mcp-status` in the parent repo wrap this and the health probe.

## Unreleased - the shared HTTP server is supervised, so a dead one comes back instead of stranding every session

On 2026-10-07 the shared HTTP singleton (pid 8396) stopped serving in the same
host-memory window that stack-overflowed the daemon's `update-poll` thread, and
nothing brought it back: port 8787 answered nothing for 84 minutes (04:43 ->
06:07 local), and it only returned because some other process happened to run
`ensure-http`. A session registered with `{"type":"http","url":"..."}` runs no
gm process of its own, so nothing on that path can start the server -- and a
client that connected once and lost the pipe does not reconnect on its own, so
its `mcp__gm__gm` reads "has disconnected" for the rest of the session. The
daemon has a guard that restarts it; the durable transport had none.

A `--http` server now arms a detached supervisor once the listen succeeds:
`runHttpSupervisor` polls `/health` every 15 s (`GM_MCP_HTTP_SUPERVISOR_INTERVAL_SECONDS`)
and calls `ensureHttpSingleton` when the port stops answering, logging
`http-supervisor-restarted` or `http-supervisor-restart-failed`. `gm-mcp
http-supervise [--port N] [--interval S]` runs one by hand, which is how an
already-running server gets supervised without a restart. One supervisor per
port, recorded in `~/.agentplug/gm-mcp-http-supervisor-<port>.json` and
re-spawned only when that pid is gone; `GM_MCP_HTTP_SUPERVISOR=0` disables it,
and the supervisor passes that down to everything it spawns so a restarted
server does not seed a second supervisor that would race it.

Measured on a throwaway port: killing a supervised server brought it back in
17 s with the next tick, and the restarted server spawned no supervisor of its
own.

## Unreleased - an unsupported `mcp-protocol-version` is answered, not refused

Current Claude Code advertises protocol version `2026-07-28`. The bundled SDK
exempts `initialize` from its `mcp-protocol-version` check but rejects every
other POST outright when the header names a version newer than it knows, so a
client connected and then had `notifications/initialized`, `tools/list` and
every `tools/call` answered `400 Bad Request: Unsupported protocol version`.
Nothing but a fresh `initialize` ever worked, which is why one dispatch
succeeded and the next failed with `ECONNRESET` while the server stayed up and
logged nothing.

MCP says a server that cannot serve the version a client asks for answers in
the version it does, so `serveMcpRequest` now rewrites an unsupported
`mcp-protocol-version` to the newest one `SUPPORTED_PROTOCOL_VERSIONS` lists
before the SDK sees the request. Both `req.headers` and `req.rawHeaders` are
rewritten: the web Request the SDK reads is materialised from `rawHeaders`, so
patching only the parsed map had no effect. A supported version is left alone
and the rewrite is recorded as `http-protocol-version-normalized`.

## Unreleased - an explicit `timeout_seconds` is honoured instead of clipped to 60 s

A `mutable-add` dispatch on `C:\dev\mc-420` (2026-10-06, session `eac6e6be`)
was sent with `timeout_seconds: 240` and answered "timed out" after 61.5 s,
while its reply landed in the spool 82.8 s after dispatch and sat there
unread. The poll budget had been clamped: `applyClientDeadline` cut every
request down to `GM_MCP_CLIENT_DEADLINE_SECONDS` (default 60) minus
`CLIENT_DEADLINE_MARGIN_MS`, so 240 s became 58.5 s. That 60 s was a
measurement of one client, and this client plainly waited longer -- it
received gm's reply at 61.5 s -- so the clamp turned a dispatch that was
always going to succeed into a timeout that then needed `resume_task`.

A caller that names `timeout_seconds` is stating how long *it* will wait for
*this* call, so an explicit value is no longer clamped. The ceiling still
bounds the budget nobody named (the 120 s default and the exec-family
`timeoutMs` prefix), and a `GM_MCP_CLIENT_DEADLINE_SECONDS` that an operator
set explicitly still caps everything, since then it is a fact about the
client rather than a default guess. `poll_budget` now carries
`caller_timeout_explicit`, and its `reason` no longer advises `resume_task`
over a longer `timeout_seconds` when the caller did name one.

The deadline re-check also reads before it sleeps rather than after, and
returns the abort reply instead of a timeout when the caller's signal fires
inside the window: a reply that is already on disk always beats reporting a
timeout.

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
