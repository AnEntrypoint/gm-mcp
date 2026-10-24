# gm-mcp

MCP server exposing gm's spool dispatch cycle (write, poll, cleaned response) to any MCP client.

## What it does

Wraps the whole gm spool write-then-poll-for-response dispatch cycle into a single MCP tool call (`gm_codemode`, with `gm.<verb>({...})` calls in its code), instead of a caller writing the input file, polling for the output file, and reading it as three separate steps.

- Writes `.gm/exec-spool/in/<verb>/<N>.txt`
- Polls `.gm/exec-spool/out/<verb>-<N>.json` until it appears (or a timeout elapses)
- Returns the response as flat YAML text, auto-cleaned for readability:
  - opaque internal id `request_fingerprint` stripped; `dispatch_id` kept as the reply's actionable evidence (`prd-list`, `prd-resolve`'s `witness_dispatch_id` and `rs-plugkit` `prd.rs` read it from the witness body, and `complete.md` serves that contract to workers)
  - the redundant `response`/`data` nesting levels flattened to the top (unless a field name would collide)
  - long text fields (e.g. `instruction`'s full phase prose) truncated with a pointer naming the on-disk file to read for the full text -- the plain-text-body verbs get a far larger budget so their `stdout` comes back inline (see "Long text inline limits")
  - hit-array ranking internals (`cos`/`recency` in `recall_hits`/`bm25_hits`/`vector_hits`/`commits`) dropped, `score` retained as ranked evidence
  - byte-identical object rows repeated inside one array collapsed to the first copy
  - empty/null/empty-string fields removed at every level, except an empty result list (`edges`, `reachable`, `reached`, `callees`, `functions`, `matches`, `definitions`, `references`), which stays as `[]` so "nothing found" reads as an answer rather than a missing field; and a `false` on a flag whose only meaning is the absence of a problem (`session_mismatch`, `instruction_unchanged`, `instruction_suppressible_by_asserting_hash`, `recall_embed_failed`, `should_residual_scan`, `fsm_graph_rejected`)
- Spool paths appear on timeout/abort/error or when compaction points to the original payload; other successful responses omit them (the caller already knows verb/cwd).
- Supports plain-text-body verbs (`exec_js` and every language stem it backs, plus `browser`) via a `raw_body` string parameter (a string `body`, or a `body` object with exactly one string field among `code`/`script`/`command`/`source`/`text`, is accepted as the same text), since these verbs reject a JSON-object body outright
- Adds a `timeoutMs=<ms>` first line to an exec-family `raw_body` that has none, derived from `timeout_seconds` (see "Exec-family timeout prefix" below)

## Usage

Not published to npm -- `gm-mcp` is an unrelated package on the npm
registry. The shipped `bin/gm-mcp-server.js` is a pre-bundled, dependency-free
file (see Development below); `npx github:AnEntrypoint/gm -g` (the gm
installer) vendors it to `~/.gm-tools/gm-mcp-server.mjs` and registers that
local file with every agent host:

```json
{
  "mcpServers": {
    "gm": {
      "command": "node",
      "args": ["/home/you/.gm-tools/gm-mcp-server.mjs"]
    }
  }
}
```

Never register `npx -y github:AnEntrypoint/gm-mcp` as the server command: npx
re-resolves the git ref over the network and reinstalls on every connect
(8.2s warm cache, 22.2s cold, vs 0.19s launching the bundle from disk), which
trips Claude Code's 30s connect timeout under load.

### Self-updating deployed copy

Any running copy checks the deployed `~/.gm-tools/gm-mcp-server.mjs` (or
`$GM_TOOLS_DIR`) against `bin/gm-mcp-server.js` on `main` in the background
after it connects, at most once per hour, not only a process started from that
file, so a server launched from a repo build keeps the deployment current
instead of leaving it behind upstream. A process that refreshed a deployment it
is not does not hand its own transport over to it; only the deployed copy's own
process reloads into what it installed. On a sha256 mismatch it validates the fresh
bundle (size, shebang, `node --check`), keeps the old one as
`gm-mcp-server.mjs.prev`, atomically swaps the new one in, and prints one
stderr line (`deployed bundle was stale -- refreshed <old> -> <new> ...`); the
refreshed tool schema is served from the next connect, or sooner when the transport hands over in-process (see gm-mcp/AGENTS.md "Bundle drift and handover"). A failed check keeps the
deployed copy and prints one line. Env: `GM_MCP_SELF_UPDATE=0` disables,
`GM_MCP_SELF_UPDATE_DEPLOYED_ONLY` set to anything but `0`/`false`/`no`/`off`
limits refreshing to the deployed copy's own process,
`GM_MCP_BUNDLE_URL` (http(s) or `file:`) overrides the source,
`GM_MCP_SELF_UPDATE_INTERVAL_MS` overrides the throttle. A bundle from before
this feature cannot update itself: run `npx github:AnEntrypoint/gm --mcp-only`
once.

The release channel is a plain file swap, so a release that loses a fix would
silently undo it on the next check (exactly what happened to the
`windowsHide: true` on two child spawns in the 2026-10-04 08:57 build). Three
guards stand between the channel and the deployed file:

- **Freeze.** `GM_MCP_NO_SELF_UPDATE` set to anything other than `0`/`false`/
  `no`/`off`, or a `gm-mcp-server.no-self-update` file in the install dir
  (`$AGENTPLUG_HOME`, else `~/.agentplug`), stops every self-update before any
  network call.
- **Local-build pin.** `gm-mcp-server.local-build.json` in the same dir holds
  the sha256, path, version and ts of a bundle you want to keep: while the
  installed bundle's sha256 matches it, the channel may not overwrite it.
  `gm-mcp pin-local-build [path]` writes it, `gm-mcp unpin-local-build` clears
  it, and `gm-mcp self-update-status` prints the whole picture.
- **No downgrade.** The candidate's version (its `BUNDLE_VERSION` assignment)
  must be strictly greater than the installed one; equal or older is refused,
  and so is a candidate whose version cannot be read at all.

The check runs every `GM_MCP_SELF_UPDATE_INTERVAL_MS` (default 60 seconds). It
probes the GitHub API for the `main` head: a 304 with no body while the head is
unchanged, so an idle check moves no bundle bytes. A changed head is fetched by
its commit-addressed raw URL, and a fix pushed upstream reaches this machine
within one interval. `gm-mcp
self-update-now` runs the same check at once, skipping only that stamp: it
starts no server, binds no port, signals nothing and never hands this process
over to the bundle it installs, and every guard above still stands.

Every refusal goes to stderr with its reason (`refusing deployed bundle
self-update (<code>) -- <reason>`), so it lands in the daemon log instead of
being swallowed by the background check. The `.prev` backup and the `node
--check` validation of a candidate are unchanged.

### Picking up a newer bundle without a reconnect

The self-update above compares the deployed file against a URL, so it answers
`current` whenever those two agree -- whatever bytes the running process
actually started from. A bundle installed over `~/.gm-tools/gm-mcp-server.mjs`
by any other route (a lane build, `dev-sync`, a manual copy) therefore never
reaches a long-lived server through it, and a process runs the bytes it starts
from. Every 30 seconds the server instead compares the deployed file
against the file it launched from (`launchedEntryPath()`), size+mtime first and
sha256 only when that moved:

- `/health` answers a `bundle` block (`running_version`, `running_sha256`,
  `installed_version`, `installed_sha256`, `stale`, `reloadable`, `refusal`),
  and `gm-mcp http-status` prints it.
- Every dispatch reply carries one line naming both versions, so the mismatch
  is visible without asking. `fs_read` and `gm_result` are the
  exception: their replies are file content handed back byte for byte, and a
  line appended there is not a note, it is a different file.

An HTTP server started by hand with `--http` does not replace itself. It keeps
serving the bundle it loaded, reports the mismatch on `/health` and in each
dispatch reply, and picks up the installed bundle only when a human restarts it.
Nothing spawns the newer bundle, hands it the listening socket or takes its port.

A stdio handover does not start while a dispatch is in flight
(`bundle-handover-stdio-deferred`, retried on the next tick). It waits up to
120 s for the in-flight count to reach 0, then proceeds
(`bundle-handover-stdio-deferral-expired`).

Refusals report staleness and stay on the old bundle: `no-downgrade`,
`installed-version-unknown` and `running-not-a-bundle` (a dev checkout would
otherwise restart on every edit). A stdio server is not exempt. It stays the
client's process. When a server started by hand answers on the default port, the
stdio session relays the client's frames to it (`bundle-handover-stdio`, and
`gm: this stdio session now relays to the installed bundle at <url>` on stderr),
so the session is never detached and no reconnect is needed. When none answers,
it announces the staleness and keeps serving its loaded bundle until the client
relaunches; see AGENTS.md. Env: `GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS` overrides the
30s watch, `GM_MCP_BUNDLE_DRIFT_RELOAD=0` turns every reload off and keeps the
reporting.

Run bare in a terminal with no MCP client attached the server stays running
until stdin closes or the process is killed; a stdin close alone does not exit
the process (`gm-mcp: stdin ended (client disconnected or platform pipe quirk)
-- server stays up` on stderr), since an MCP stdio client can legitimately
half-close stdin without ending the session. `gm-mcp: connected, serving on
stdio` on stderr confirms the server started.

### When the daemon is down

The daemon exits on purpose -- it self-recycles when idle or over its wasm
memory ceiling, and it hands off to a freshly downloaded runner build -- so a
dead daemon is normal, not a crash. This server restarts it on demand
(`ensureSpoolRunnerRunning`) and then on a timer per project root
(`startRunnerWatchdog`, every 5 s). Nothing else supervises it: there is no
systemd unit and no long-lived launcher to check.

Restart it by hand for one project with the same command the server uses --
the `spool` launcher detaches `agentplug-runner daemon` for that root:

On Windows:

```powershell
cd C:/dev/mc-420
& "$HOME/.gm-tools/agentplug-runner.exe" spool
```

On Unix:

```bash
cd ~/my/project
~/.gm-tools/agentplug-runner spool
```

A cold start compiles wasm for tens of seconds before it claims its first
ticket. To reinstall the runner entirely: `npx github:AnEntrypoint/gm -g`.

Logs, in the order worth reading:

- `~/.agentplug/daemon.log` -- the daemon's own log (recycles, wasm compiles,
  plugin warnings). This is what the liveness notes mean by "daemon log".
- `<project>/.gm/exec-spool/.watcher.log` -- per-project spool events.
- `<project>/.gm/exec-spool/.status.json` -- the heartbeat: `ts`, `pid`,
  `busy_until`. Older than 20 s and its `pid` gone means no one is sweeping.
- `<project>/.gm/exec-spool/in/<verb>/*.txt` -- tickets nobody claimed.

A dispatch to a project whose daemon is gone does **not** wait out the poll
timeout: `gmDispatch` asks for a runner, waits `DAEMON_START_GRACE_MS` (15 s)
for the heartbeat to come back, and only then answers
`error: daemon-not-running` with the heartbeat age, both log paths and the
restart command -- and writes no ticket, so nothing is left queued behind a
daemon that will never claim it. A project with no `.status.json` at all is
the registration path rather than a dead daemon and still dispatches, as does
one mid-handoff (`daemonBootGraceActive`, `runner_update_in_progress`). Opt
out with `GM_MCP_DAEMON_PREFLIGHT=0`.

## Continuation channel

Every dispatch reply ends with a `continuation` block: `state` (`running` or `stopped`), `pending_rows` (from the reply's `prd_pending_count`, `null` until one is seen), `idle_ms` since the previous reply on that session, and `action`. `action` is `continue` while rows are pending (with `max_concurrency`, the pending count capped at 4 workers), `stop` when no rows are pending or the session is stopped, and `none` when the pending count is unknown. A JSON object reply gets `continuation` as a field, a JSON array reply carries none, and file-content replies (`fs_read`, `result`, `gm_result`) stay byte for byte.

`continuation-stop` (dispatched through `gm` with `verb: "continuation-stop"`, or on the session body) marks the session stopped. The next `instruction` dispatch with a non-empty `prompt` resumes it.

The first successful reply of a session that names a `cwd` also carries a `bootstrap` block: `server` (version and transport), `runner` (`alive`, `heartbeat_age_ms`, `heartbeat_stale` from the `status` verb), `pending` (`count` and the first pending row as `next`), `checklist_uri` and `bootstrap_complete`. Its status and next-row reads share one 1500 ms budget. A read that misses it, or fails, is recorded in `bootstrap_error` and the reply is not held back. Refused and error replies, and JSON array replies, leave the bootstrap for a later reply. The skill prompts and `gm-completion` take an optional `cwd` argument that adds the same live state as text.

Push is stdio only, and the server declares `logging`. When pending rows exist and no reply has arrived for `GM_MCP_IDLE_NOTIFY_MS` (default 300000), a `notifications/message` at level `warning` with logger `gm.continuation` carries the same object as `data`, once per idle period. A standalone stdio server emits it through its SDK server. A stdio session that relays to a server started by hand emits from the relay, which observes the continuation blocks in the replies it forwards. Streamable HTTP cannot push, so HTTP clients read `continuation` from the reply.

## Transport: stdio (default) and streamable HTTP

`gm` is registered in `~/.claude.json` as a user-scope MCP server:

```json
{ "mcpServers": { "gm": { "command": "node", "args": ["C:\\Users\\user\\.gm-tools\\gm-mcp-server.mjs"] } } }
```

That is a **stdio** server, and stdio is the default: no flag selects it, and
the server opens no listening port. The client owns the child process on a
pipe. When that one connection drops, the tool is gone for the rest of the
session and nothing can re-attach it. The server cannot reconnect itself, and
the client will not re-spawn it. It surfaces as `No such tool available:
mcp__gm__gm. Its MCP server 'gm' has disconnected`, and the only cure is `/mcp`,
then gm, then Reconnect, or restarting the session.

A stdio start serves the session in-process over the spool: `main` in
`src/index.js` runs `createServer` on stdio, and each dispatch is published to
`.gm/exec-spool` by `dispatch.js`, so no port and no admin rights are needed on
Windows, macOS or Linux. The stdio path starts no HTTP server, singleton,
supervisor, instance registry or boot entry.

The streamable HTTP transport runs only when a human starts it by hand with
`--http` on the command line. `--port N` and `--host H` are optional (defaults
8787 and 127.0.0.1). No environment variable or default enables it, and nothing
starts it for you:

```
node ~/.gm-tools/gm-mcp-server.mjs --http --port 8787   # foreground; serves http://127.0.0.1:8787/mcp until stopped
```

The HTTP side is **stateless** (no session id, one request per call), so a
client that disappears and comes back is just another request, and it binds
`127.0.0.1` only. To register a server you started, run:

```
claude mcp remove gm -s user && claude mcp add --transport http gm http://127.0.0.1:8787/mcp -s user
```

`gm-mcp-server.mjs` is the deployed copy under `~/.gm-tools` (the tree ships
`gm-mcp/bin/gm-mcp-server.js`). `http-status` reports whether a server answers
on the default port and starts nothing.

The HTTP transport has its own stranding failure: if the port is empty when a
session's client connects, that client answers `MCP server "gm" is not
connected` for the rest of the session, and no server-side fix re-dials it.
Restoring the port helps every new session; the stranded session needs `/mcp`
reconnect or a restart.

A stdio server never exits to pick up a newer bundle, because its client holds the pipe. `node ~/.gm-tools/gm-mcp-server.mjs self-update-status` lists each such process under `running_images` with `stale: true` and the version it runs.
Operator action: relaunch the session that owns the process (`/mcp` then gm then Reconnect, or restart the session). The listing clears on relaunch. Killing the pid by hand also clears it, but the owning session loses its gm tools until it reconnects.

### No supervisor, no boot entry

gm starts no supervisor, login or boot hook, crontab entry or service, and no
install script writes one. A server started with `--http` runs until that
process exits, and nothing brings it back after a reboot or a crash. If HTTP
must survive a reboot, define that with your own service manager and have it run
`gm-mcp-server.mjs --http`; gm does not write that definition.

## Leak watch: gm defends itself at runtime

No CI job can see what is running on a developer machine, so the runtime is the
only place a process leak can be caught. Every server runs one leak pass on the
hourly pass of the scheduler it already had (`scheduleStaleDeployedBundleChecks`) and once at
startup, sharing a single host process-table read across the census, the reaper's
unattributed pass and the duplicate-supervisor count:

```bash
gm-mcp-server.js leak-watch            # the same pass, by hand
gm-mcp-server.js leak-watch --json     # the whole report
gm-mcp-server.js reap --apply          # retire what the pass reports
```

A pass that finds nothing prints nothing. A pass that finds something writes a
`leak-watch` diagnostic and one stderr line naming the counts:

```
gm-mcp: leak watch -- 27 gm-mcp process(es) on this host (warn at 8); 19 server(s), 8 supervisor(s); 27 unattributed, 24 retireable; 2 duplicate supervisor(s) -- ABOVE the population warning threshold
```

**The population warning is the early signal.** `gm_processes` counts every
`gm-mcp-server` process alive on the host, servers and supervisors, and
`above_warn` trips at `GM_MCP_LEAK_POPULATION_WARN` (default `8`), long before
the count becomes memory pressure. It is a warning, never a kill: nothing is
refused a start.

**Retiring is opt-in and narrower than the reaper's own `retire` verdict.** By
default the pass reports and stops. `GM_MCP_LEAK_AUTO_APPLY=1` lets it signal,
and then only an unattributed **stdio** server that is also:

- not the pid answering `/health` and not the owner of a registered port's
  listening socket, one shared HTTP server carries every session on the box;
- free of any live MCP-client ancestor (`claude`, `code`, `cursor`, ...), so a
  server a session is driving is never touched;
- free of any live desktop-session ancestor (`selkies`, `xfdesktop`,
  `xfce4-session`, `s6-svscan`, `Xvfb`, ...), those look exactly like multi-day
  orphans and are the live session;
- of a **measured** start time at least 30 minutes old, and at most 3 per pass.

A process whose ancestry or age cannot be read is never signalled: an unmeasured
value is never read as "old". Duplicate `http-supervise --port <N>` supervisors
are counted and reported; retiring them stays with the supervisor sweep
(`GM_MCP_HTTP_SUPERVISOR_DUPE_REAP`).

**Orphans are the leaks the ledger cannot see.** The reaper assesses only pids
the child ledger knows, so a process gm never spawned piles up invisibly, 11
reparented runners held 3367 MB of a 7.8 GB box on 2026-10-15 without one line
from the watch. The same pass now also scans for processes whose `ppid` is `1`
(reparented to init), that no ledger row claims, that are **heavyweight** (RSS at
or above `GM_MCP_LEAK_ORPHAN_RSS_MB`, default 150 MB) and **idle**, CPU seconds
burned divided by seconds alive below `GM_MCP_LEAK_ORPHAN_DUTY` (default `0.02`), after `GM_MCP_LEAK_ORPHAN_MIN_AGE_MS` (default 900000 ms, 15 minutes) alive.
The duty ratio is the discriminator: the 11 real leaks sat near 0.01 while the
one live run of the same binary is still burning CPU.

```
  ORPHAN pid 1860399 -- 292.1 MB RSS, 791s alive, 15.5s cpu (duty 0.0196) -- target/debug/litebox_runner_linux_userland -Z --uid 0 ...
```

An orphan is reported, never signalled: gm did not spawn it, so gm does not
classify whether it may be killed. Detection reads `/proc/<pid>/stat` and
`/proc/<pid>/status` directly, a `ps` on a box loaded enough to grow orphans
can take over 120 s and time out, which is exactly the box this scan exists to
diagnose, so on mac and Windows, which have no `/proc`, the section is simply
empty rather than wrongly quiet about a number it never measured.

| Env var | Effect | Default |
|---|---|---|
| `GM_MCP_LEAK_WATCH` | `0`/`false`/`no`/`off` disables the hourly pass | unset (on) |
| `GM_MCP_LEAK_POPULATION_WARN` | process count at which the pass goes loud | `8` |
| `GM_MCP_LEAK_AUTO_APPLY` | any value but `0`/`false`/`no`/`off` arms auto-retire | unset (report only) |
| `GM_MCP_LEAK_ORPHANS` | `0`/`false`/`no`/`off` disables the orphan scan | unset (on) |
| `GM_MCP_LEAK_ORPHAN_RSS_MB` | RSS floor at which a reparented process is heavyweight | `150` |
| `GM_MCP_LEAK_ORPHAN_DUTY` | CPU-seconds-per-second-alive below which it counts as idle | `0.02` |
| `GM_MCP_LEAK_ORPHAN_MIN_AGE_MS` | age floor, so a starting process is never reported | `900000` |

## Development

`bin/gm-mcp-server.js` is a committed build artifact, not hand-edited source --
edit `src/index.js`/`src/dispatch.js`/`src/cli.js` instead, then rebuild:

Install development dependencies, then bundle `src/cli.js` into the committed
runtime artifact:

```bash
npm install
npm run build
```

Rebuilding is not cosmetic: the bundle carries the tool's `inputSchema`, and
the MCP SDK silently STRIPS arguments the schema does not declare. A committed
bundle older than `src/` therefore ships a server that drops a caller's new
argument without a word -- witnessed at commit `d7f7cb6`, whose `src/` declared
`resume_task` while its bundle did not: `{resume_task}` with no body reached
`gmDispatch` as `undefined`, a fresh task is minted, a new spool entry is
written with an empty body, and the caller got the resumed verb's own
body-validation error (`query required`) with nothing pointing at the stale
bundle. Rebuild in the same commit as any `src/` change.

`npm run build` and `verify-build` share `scripts/build.mjs`, whose version banner
comes from `src/bundle-version.js` and remains readable by the updater after
minification. `verify-build` rebuilds into memory, checks that production parser
against the source version, and fails on committed-bundle byte drift.
`npm install` points this checkout's git hooks at `.githooks/`
(`core.hooksPath`, local to this checkout, never committed) so `pre-push` runs
it automatically and blocks a push carrying a stale bundle.

`scripts/publish-api.mjs` lands files on `main` through the GitHub Git Data API (blobs, a tree on the remote tip, a commit parented on it, then PATCH `refs/heads/main`). When no `push` run appears for the new sha within 60 s, it dispatches each active `workflow_dispatch` workflow on that sha, so a docs-only commit still gets CI. Usage: `node scripts/publish-api.mjs <owner>/<repo> "<message>" <repoPath>=<localFile>...`.

`scripts/prune-scratch.mjs --root <dir> [--cap-hours 24] [--apply]` removes the directories directly under `<dir>` whose name starts with a gm-owned prefix (`gm-agentplug-home-`) and whose mtime is older than the cap. It is a dry run unless `--apply` is given, and `--apply` removes exactly the directories the dry run listed.

Bundling exists because `npx github:...` installs have been observed to
produce a corrupted transitive-dependency install (a `node_modules/ajv`
directory present but missing its `package.json`) on some npm/npx versions,
crashing the server before it can connect (`CONNECTION_CLOSED` on the client
side). Shipping a self-contained bundle with `"dependencies": {}` removes that
failure mode entirely -- there is nothing left for the installer to get wrong
at launch time.

## Tool: `gm`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `verb` | string | yes | gm spool verb name, e.g. `instruction`, `prd-add`, `git_status`, `exec_js` |
| `session_id` | string | yes | gm `SESSION_ID` for this dispatch |
| `body` | object | no | JSON body for the dispatch (not valid for plain-text-body verbs) |
| `raw_body` | string | no | Literal text body for a plain-text-body verb, mutually exclusive with `body` |
| `cwd` | string | no | Project root containing `.gm/exec-spool` -- defaults to `process.cwd()` |
| `timeout_seconds` | number | no | Requested poll budget in seconds. Default 120, or an exec-family `timeoutMs` prefix plus 5 s. Explicit values override that request; every call is capped at 600 s (the harness tool-call max, override with `GM_MCP_POLL_TIMEOUT_CEILING_MS`) and returns a resumable task if still pending. For exec-family verbs it also raises the child's own `timeoutMs` budget to match, so a 400 s poll is not spent waiting on work the daemon reaps at 300 s. |
| `poll_interval_seconds` | number | no | Fallback response check interval when filesystem events are unavailable (default 0.25) |
| `include_timing` | boolean | no | Include MCP submission-to-response timing and the last response wakeup source |
| `resume_task` | string | no | The `task` field from a previous `timed_out`/aborted response -- keep polling that SAME dispatch instead of writing a new one |
| `full_response` | boolean | no | Skip wire compaction and return every field verbatim, with no text field truncated (default: compacted) |
| `max_chars` | number | no | Per-dispatch cap on how many characters of any one text field come back inline, overriding the defaults below (ceiling `1048576`) |

## Verb tools

The server registers one MCP tool, `gm_codemode`. Every registry verb is a function
on `gm` inside its code body. Discover names with `gm.list()` and a verb's schema
with `gm.describe(name)`. Call a verb as `gm.<verb>({...})` or `gm.gm({verb, body})`;
both take the same dispatch path. The registry list lives in `src/verbs.js`
(`RUNNER_REGISTRY_VERBS`). A client holding a cached `tools/list` from an earlier
build must re-fetch it.

A code body runs under a deadline of `GM_CODEMODE_TIMEOUT_MS` milliseconds (default
`600000`; a non-positive or non-numeric value falls back to the default). A body that
awaits a gm call that never returns, or a loop of calls that outlives the budget, fails
with `gm_codemode code did not finish within <ms> ms`; calls already dispatched keep running
in the spool and can be resumed with `resume_task`. The deadline cannot interrupt a
synchronous loop in the body (`while (true) {}`): the body runs on the server's single
thread, so that loop blocks every request until the process is killed. A body must bound
its own synchronous work.

## Wire compaction

Every dispatch response is compacted before it crosses the wire; nothing is
removed from the out-file on disk. A compacted response carries a
`wire_compacted` block naming every field dropped or shortened, the on-disk
file holding the full payload, and the opt-out:

```yaml
wire_compacted:
  omitted: orient_nouns reply_hash route_hint supply_chain_scan
  shortened: >-
    codeinsight_overview codeinsight_start config_changed(1/2)
    prd_items_truncated ready_wave(1/1) recall_hits(4/5)
  full_payload_at: C:/proj/.gm/exec-spool/out/instruction-task-1.json
  full_payload_via: 'dispatch with {"full_response": true}'
```

Long prose is cut to a 160-char excerpt ending in `...+<n>`, so an abbreviated
field always says how much is missing. `full_response: true` returns the
original guest fields and data layout, including `dispatch_id` and
`request_fingerprint`, without cleaning or compaction. MCP wait and resume
metadata remains separate.

`phase_history` retains the newest five transitions in its existing order. The
`wire_compacted.shortened` entry records retained/total counts and points to the
unchanged out-file. Current phase, gate decisions, session mismatch, PRD counts,
and failure payloads are not shortened. Use `full_response: true` for all history.

Committed `git_commit` and `git_finalize` successes retain at most five received
examples in `excluded` and `excluded_but_dirty`. Metadata records received-array
counts, not repository totals: five of 50 examples remains `5/50` even when
`excluded_count` is 193. Native totals, truncation counts, requested paths, commit
SHA and authors stay unchanged. The original out-file and `full_response: true`
recover all received examples; failures, refusals and uncommitted receipts bypass
this shortening.

Successful exhaustive `output_mode: count` replies omit `output` only when every
entry exactly repeats its corresponding structured `counts` row as `path:count`.
All count rows, totals and scan metadata remain unchanged. The original out-file
and `full_response: true` retain the repeated array; incomplete, failed and
nonmatching replies keep it.

### Long text inline limits

Two env vars set how much of a long text field comes back inline before it is
replaced by the `... [N chars total, full text at <out-file> field '<key>']`
pointer. They are read once at server start, so a host must restart its
`gm-mcp-server.mjs` for a change to take effect.

| Env var | Applies to | Default | Ceiling |
|---|---|---|---|
| `GM_MCP_LONG_TEXT_INLINE_MAX` | every long text field, including `instruction`'s phase prose | `400` | `1048576` |
| `GM_MCP_STDOUT_INLINE_MAX` | the whole response of a plain-text-body verb (`exec_js` and every language stem it backs) | `32768` | `1048576` |
| `GM_MCP_FILE_READ_INLINE_MAX` | the file body `fs_read` returns | `65536` | `1048576` |
| `GM_MCP_NO_SELF_UPDATE` | any value but `0`/`false`/`no`/`off` freezes the deployed bundle against every self-update | unset | -- |
| `GM_MCP_SELF_UPDATE_DEPLOYED_ONLY` | any value but `0`/`false`/`no`/`off` limits self-update to a process running from the deployed bundle | unset | -- |

The `fs_read` budget exists because that response *is* the file the caller
asked for: at the 400-char prose cap every whole-file read came back as a
pointer and the caller had to fall back to a host file-read tool. `fs_read`'s
own `max_bytes`/`offset`/`limit` are daemon-side and were never the problem --
they were being cut down again on the way out.

A line range belongs to the `fs_read` request itself:
`{"path":"src/dispatch.js","startLine":1040,"endLine":1100}` -- or
`start`/`end`, `start`/`count`, `from`/`to`, `offset`/`limit`, `line`/`lines`,
at the top level or inside `body` -- returns just those lines, 1-based and
inclusive on both ends, with `total_lines`, `start_line`, `end_line` and a
`next_start_line` to page on. `limit`/`count`/`lines` is a number of lines, not
an end line. A range-looking key that is not one of them is an error naming the
accepted keys, never a silent whole file, and a range that could not be applied
says so with `range_applied: false`. Without any range key the whole file comes
back, unchanged.

The plain-text-body budget exists because that response *is* the script's
output: truncating it at 400 chars meant nearly every `exec_js` call needed a
second round trip (a file read) to see its own `stdout`. Raise or lower either
knob in the `mcpServers.gm` entry:

```json
{ "mcpServers": { "gm": {
  "command": "node",
  "args": ["/home/you/.gm-tools/gm-mcp-server.mjs"],
  "env": { "GM_MCP_STDOUT_INLINE_MAX": "65536" }
} } }
```

Non-numeric, zero or negative values fall back to the default. `max_chars` is
the per-dispatch override of all three: it is an MCP argument, so it never
reaches the verb's own body. `full_response: true` bypasses text caps, cleaning, data flattening and
wire compaction. The original response file remains subject to the bounded
4 MiB read limit.

Measure it against any real dispatch:

```bash
node scripts/measure-wire-size.mjs .gm/exec-spool/out/instruction-*.json
```

### Exec-family timeout prefix

The daemon enforces `timeoutMs=<ms>` as a wall-clock limit on the exec child:
it defaults to 300000 when the line is absent, is clamped to a hard ceiling of
900000 (the reply then carries `limit_clamped_from_ms`), and at expiry the whole
process tree is killed and the reply is `{ok:false, timed_out:true, killed:true,
error_code:"exec_timeout", limit_ms, ...}` with whatever stdout/stderr had been
produced. The exec family is `exec_js` (aliases `nodejs`, `javascript`, `node`, `js`) and every language stem: `bash`, `sh`, `shell`, `zsh`,
`python`, `py`, `powershell`, `ps1`, `ssh`, `go`, `rust`, `c`, `cpp`,
`java`, `deno`.

For these verbs the server adds the line itself when `raw_body` lacks one:

- the value is the caller's own poll budget minus 5 s, floored at 300000
  (`EXEC_DEFAULT_LIMIT_SECONDS`, the daemon default) and capped at 900000
  (agentplug-host's `HARD_CEILING_MS`). A short poll therefore never shortens a
  child's life, and a long one buys the child the time the caller is waiting for
- with no `timeout_seconds` the value stays 300000, the daemon default
- a `raw_body` that already starts with `timeoutMs=<ms>` or `timeout_ms=<ms>`
  (leading whitespace allowed) is sent unchanged -- an explicit line wins

The prefix is the process budget the daemon enforces; `timeout_seconds` requests
the wrapper's poll budget and, for these verbs, raises that process budget to
match. Without an explicit poll value, an exec prefix requests its duration plus
5 s, with a 120 s minimum. Every initial or resume call is capped at 600 s, the
harness tool-call maximum -- set `GM_MCP_POLL_TIMEOUT_CEILING_MS` to move it.
A pending reply reports `poll_timeout_ms`, `requested_poll_timeout_ms`,
`poll_timeout_capped`, `poll_timeout_ceiling_ms` and `poll_timeout_cap_reason`
(a sentence naming why the wait ended, not just a boolean), and for exec verbs
`exec_limit_ms` plus an `exec_child` sentence stating that gm did NOT kill the
child and when the daemon will reap it. It also reports the original `task` and
spool paths. Resume that same task without a body; poll expiration neither stops
execution nor queues another dispatch. The daemon kills the child at `timeoutMs`,
so an abandoned call never leaves a runaway process -- it ends at that limit, and
the reply says so instead of leaving the caller believing the work continues.
An aborted call also withdraws its
request from the spool when the daemon has not claimed it yet
(`request_withdrawn_before_claim`).

Exec-family `stdout`, `stderr` and `result` are shown in full up to 16000
characters each. The out-file wraps them in a JSON string field `data`; the
wrapper unpacks it so the fields print flat. A longer field ends in
`OUTPUT TRUNCATED: showing 16000 of N chars` and names `result_file`, a plain
text `<verb>-<task>.txt` next to the out-file (sections `## result`, `## stdout`,
`## stderr`, un-escaped) that the daemon writes whenever a field exceeds 2000
characters; older daemons name the JSON out-file and its `data` field instead. Other long text fields stay capped at 400 characters with the same
kind of pointer.

### `raw_body` is byte-for-byte -- mind the backslash escapes

The server writes `raw_body` to the spool input file with no escaping at all
(`fs.writeFileSync(temp, body, 'utf8')`). The shell therefore sees exactly the
bytes of the argument. Two escapes still apply before that point, and both
remove one backslash:

1. The MCP client encodes the tool argument as JSON. A backslash in a JSON
   string is an escape, so `\` in your text reaches gm as `\`. Write `\\`
   to make the shell receive `\`.
2. `bash` removes one more backslash inside double quotes, and `\$` is a
   literal dollar sign. So `\"C:\dir\${V}\"` never expands `${V}` -- it is a
   quoted dollar, not an expansion.

A Windows path inside a bash double-quoted string therefore needs four
backslashes per separator in the tool argument:

```
cmd /c "C:\\dev\\proj\\${B}.bat"
```

Forward slashes avoid the problem entirely, and `cmd.exe` accepts them:

```
cmd /c "C:/dev/proj/${B}.bat"
```

If a variable arrives at the shell literally (for example `cmd /c` reports
`'C:\dev\proj${B}.bat' is not recognized`), the cause is one of these two
escapes, not gm. Check the byte count of the backslashes before `$`.

### Resuming a dispatch

A dispatch that outran its `timeout_seconds` is not lost: the daemon keeps
working and still writes its out-file. The `timed_out` response carries the
`task` that names it, plus `dispatch_state` (read from the spool itself:
`claimed_still_in_flight` / `queued_not_yet_claimed` / `no_input_file_left`) and
a project-scoped `daemon` liveness block.

Pass that `task` back as `resume_task` to re-poll the same dispatch:

- a resume sends **no body** -- omit `body`/`raw_body`; the dispatch being
  resumed already carries its own, and nothing new is written to the spool
- `verb` and `cwd` must match the original call exactly; together with the task
  name they are how the dispatch is addressed on disk
- `session_id` is still required by the tool for every call, though a resume
  writes no new spool file with it
- a triple matching no spool artifact returns an immediate error naming the
  three paths checked, rather than polling a task that cannot arrive
- the response carries a `resumed` block stating that this call sent no body,
  wrote no new dispatch, and whether the result predates the resume -- so a
  stored error from the ORIGINAL dispatch is never misread as a verdict on the
  resume call
- `resume_task_supported: true` on a `timed_out` response is the falsifiable
  signal that this server build honours the argument; older builds omit the
  field and silently drop it
