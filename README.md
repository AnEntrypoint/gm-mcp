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
- Supports plain-text-body verbs (`exec_js` and every language stem it backs, plus `crawl`) via a `raw_body` string parameter (a string `body`, or a `body` object with exactly one string field among `code`/`script`/`command`/`source`/`text`, is accepted as the same text), since these verbs reject a JSON-object body outright
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
after it connects, at most once per hour — not only a process started from that
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

Every refusal goes to stderr with its reason (`refusing deployed bundle
self-update (<code>) -- <reason>`), so it lands in the daemon log instead of
being swallowed by the background check. The `.prev` backup and the `node
--check` validation of a candidate are unchanged.

### Picking up a newer bundle without a reconnect

The self-update above compares the deployed file against a URL, so it answers
`current` whenever those two agree -- whatever bytes the running process
actually started from. A bundle installed over `~/.gm-tools/gm-mcp-server.mjs`
by any other route (a lane build, `dev-sync`, a manual copy) therefore never
reaches a long-lived server through it, and a process runs the bytes it was
started from. Every 30 seconds the server instead compares the deployed file
against the file it launched from (`launchedEntryPath()`), size+mtime first and
sha256 only when that moved:

- `/health` answers a `bundle` block (`running_version`, `running_sha256`,
  `installed_version`, `installed_sha256`, `stale`, `reloadable`, `refusal`),
  and `gm-mcp http-status` prints it.
- Every dispatch reply carries one line naming both versions, so the mismatch
  is visible without asking. `fs_read`, `result` and `gm_result` are the
  exception: their replies are file content handed back byte for byte, and a
  line appended there is not a note, it is a different file.

An HTTP server then replaces itself: it spawns the new bundle with an IPC
channel, sends it the listening socket, and stops accepting only once the
child answers `gm-mcp-handover-ready`. Both processes hold the socket through
the handover, so nothing is refused -- measured over 50s of continuous probing
across one handover: 42056 requests, 0 refused, one transition
`0.2.34/36660 -> 0.2.35/32508`. If the child never answers, the old
close-then-bind shape runs instead, and if the replacement never answers
`/health` the old process takes the port back.

A reload never cuts work. It does not start while any dispatch is in flight
(`bundle-handover-deferred`, retried on the next tick), and the outgoing
process waits for the in-flight count to reach 0 before exiting, so a reply
already being written is finished rather than truncated. Measured with a 40s
dispatch: the newer bundle was installed 4s in, `/health` went `stale: true`
while the pid stayed put, the dispatch came back complete at 42.3s carrying the
notice, and the server moved to the new bundle only afterwards.

Refusals report staleness and stay on the old bundle: `no-downgrade`,
`installed-version-unknown` and `running-not-a-bundle` (a dev checkout would
otherwise restart on every edit). A stdio server is not exempt -- it stays the
client's process and relays the client's frames to a child running the installed
bundle (`gm-mcp: stdio handed to pid <n>` on stderr), so the session is never
detached and no reconnect is needed; see AGENTS.md. Env: `GM_MCP_BUNDLE_DRIFT_INTERVAL_SECONDS` overrides the
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

## Transport: stdio (default) and streamable HTTP

`gm` is registered in `~/.claude.json` as a user-scope MCP server:

```json
{ "mcpServers": { "gm": { "command": "node", "args": ["C:\\Users\\user\\.gm-tools\\gm-mcp-server.mjs"] } } }
```

That is a **stdio** server: the client owns the child process on a pipe. When
that one connection drops, the tool is gone for the rest of the session and
nothing can re-attach it -- the server cannot reconnect itself and the client
will not re-spawn it. It surfaces as `No such tool available: mcp__gm__gm. Its
MCP server 'gm' has disconnected`, and the only cure is `/mcp` -> gm ->
Reconnect, or restarting the session.

Both transports ship in the same bundle, so the durable one is a one-line
registration change:

```
claude mcp remove gm -s user && claude mcp add --transport http gm http://127.0.0.1:8787/mcp -s user
```

The HTTP side is **stateless** (no session id, one request per call), so a
client that disappears and comes back is just another request, and it binds
`127.0.0.1` only. Manage it with:

```
node C:\Users\user\.gm-tools\gm-mcp-server.mjs ensure-http          # start if nothing answers, arm the supervisor, print the url
node C:\Users\user\.gm-tools\gm-mcp-server.mjs http-status          # is it answering
node C:\Users\user\.gm-tools\gm-mcp-server.mjs --http --port 8787   # run it in the foreground
```

Every stdio start is a relay: it forwards each MCP frame to the shared server
over HTTP and writes the reply to stdout, and starts no watchers of its own. A
stdio start, an HTTP server started on another port and a `dispatch` run all
health-probe the port and spawn the shared server detached when nothing answers
(one spawner per port, see `claimSpawn` in `gm-mcp/AGENTS.md`), so the durable
transport is up before any client asks for it and comes back by itself after a
crash. A stdio start runs a local server with its watchers only when the
singleton is opted out or unreachable. `GM_MCP_NO_HTTP_SINGLETON=1`
(or `GM_MCP_NO_HTTP_SINGLETON=1`) opts out, `GM_MCP_HTTP_PORT` moves the port.
Because no state is carried between requests, a restart of the HTTP server
never loses an in-flight dispatch.

The HTTP transport has its own stranding failure: if the port is empty when a
session's client connects, that client answers `MCP server "gm" is not
connected` for the rest of the session, and no server-side fix re-dials it.
Restoring the port helps every new session; the stranded session needs `/mcp`
reconnect or a restart.

### Across a reboot

Nothing starts the HTTP server at login, so after a reboot the registration points at a dead port until something runs it. `ensure-http` is that something, and it is idempotent: it health-probes the port, starts the shared server only when nothing answers, arms the supervisor, and prints the url either way. Put it wherever your OS runs things at login -- Startup folder, Task Scheduler, a launchd agent, a systemd user unit:

```bash
node ~/.gm-tools/gm-mcp-server.mjs ensure-http                     # Unix
node C:\Users\you\.gm-tools\gm-mcp-server.mjs ensure-http          # Windows
```

The supervisor is the part that has to survive, not the server. It is a detached `http-supervise` sibling that probes `/health` every 15 s (`GM_MCP_HTTP_SUPERVISOR_INTERVAL_SECONDS` moves it) and runs the same start path when the answer stops coming. `ensure-http` arms it on every run, including a run that found the server already up, so a supervisor that was killed comes back on the next `ensure-http` instead of leaving the durable transport unwatched. A `--http` server arms one for itself on start, and `GM_MCP_HTTP_SUPERVISOR=0` opts out of both -- `ensure-http` then prints `supervisor disabled`.

Run the supervisor directly instead when you would rather supervise than probe once:

```bash
node ~/.gm-tools/gm-mcp-server.mjs http-supervise [--port N] [--interval S]
```

It is the same loop in the foreground, so it is also what a service manager wants as its command. Two supervisors never share a port: a second one finds the first one's pid in the state file and exits with `another supervisor owns this port`.

State, both under `~/.agentplug` (`$AGENTPLUG_HOME` moves it): `gm-mcp-http.json` holds the server's pid and url, `gm-mcp-http-supervisor-<port>.json` the supervisor's. The health probe is the authority, so a stale file naming a dead pid never blocks a fresh start.

### Instances are registered, and the registry is swept

A `--http` server also registers itself as `gm-mcp-http-instance-<port>.json`
(pid, bundle version, entry path, supervisor pid). The port is the instance
identity, so a second `GM_MCP_HTTP_PORT`/`--port` is a legitimate second
instance and keeps its own supervisor; the registry is what stops instances from
piling up. `ensure-http` and every supervisor pass sweep it, and:

- a port whose server no longer answers loses all three of its files, so that
  number is reusable instead of the next launch walking to a new one;
- an instance serving a bundle older than the installed one is **replaced in
  place** -- the old server and its supervisor are stopped and a fresh server is
  started on the *same* port, so an attached session reconnects to current code
  instead of losing the port;
- an instance with no live supervisor, a provably dead parent and zero
  established connections is stopped outright. A client still attached is never
  killed, and a parent that cannot be determined is left alone.

`GM_MCP_HTTP_SUPERVISOR=0` still opts an instance out of supervision, and an
instance registered that way is never swept as an orphan.

### Installing that boot hook from the repo

`scripts/install-autostart.mjs` writes the `ensure-http` call into the places this
repository cannot hold itself -- the login/boot hook and the user crontab -- and
then starts the server so the port is live immediately:

```bash
node scripts/install-autostart.mjs          # install, refresh, and ensure one is listening
node scripts/install-autostart.mjs --check  # show what would change
node scripts/install-autostart.mjs --uninstall
```

It is idempotent: every line it writes sits inside a marker block that a later
run replaces wholesale, and it never starts a second server (the `ensure-http`
health probe is the authority). `--hook`, `--cron-file`, `--log` and `--entry`
move the targets; `--no-hook` or `--no-cron` skips one. The crontab it installs
carries a `@reboot` entry and a five-minute entry, so a server that dies between
invocations is back within five minutes even when nothing else runs gm.

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
`gmDispatch` as `undefined`, a fresh task was minted, a new spool entry was
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

`npm test` runs `test/response-compact.test.mjs`, which covers the payload
cleaner and the wire compactor in `src/response-compact.js`.

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
