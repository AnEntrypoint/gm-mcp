# gm-mcp

MCP server exposing gm's spool dispatch cycle (write, poll, cleaned response) to any MCP client.

## What it does

Wraps the whole gm spool write-then-poll-for-response dispatch cycle into a single MCP tool call named `gm`, instead of a caller writing the input file, polling for the output file, and reading it as three separate steps.

- Writes `.gm/exec-spool/in/<verb>/<N>.txt`
- Polls `.gm/exec-spool/out/<verb>-<N>.json` until it appears (or a timeout elapses)
- Returns the response as flat YAML text, auto-cleaned for readability:
  - opaque internal ids (`dispatch_id`, `request_fingerprint`) stripped
  - the redundant `response`/`data` nesting levels flattened to the top (unless a field name would collide)
  - long text fields (e.g. `instruction`'s full phase prose) truncated with a pointer naming the on-disk file to read for the full text
  - hit-array ranking internals (`cos`/`score`/`recency` in `recall_hits`/`bm25_hits`/`vector_hits`) dropped
  - empty/null fields removed at every level
- A successful response omits the spool file paths entirely (the caller already knows verb/cwd); they only appear on timeout/abort/error, to say where to look
- Supports plain-text-body verbs (`exec_js` and every language stem it backs, `serp`, `browser`, `cdp`) via a `raw_body` string parameter, since these verbs reject a JSON-object body outright
- Adds a `timeoutMs=<ms>` first line to an exec-family `raw_body` that has none, derived from `timeout_seconds` (see "Exec-family timeout prefix" below)

## Usage

Not published to npm -- `gm-mcp` is an unrelated package on the npm
registry. Run it straight from this repo:

```bash
npx -y github:AnEntrypoint/gm-mcp
```

The shipped `bin/gm-mcp-server.js` is a pre-bundled, dependency-free file (see
Development below) -- `npx` only needs to fetch the repo and run `node` on it,
no separate `npm install` of transitive dependencies is required at launch.

`npx -y github:AnEntrypoint/gm-mcp` run bare in a terminal with no MCP client
attached stays running until stdin closes or the process is killed; a stdin
close alone no longer exits the process (`gm-mcp: stdin ended (client
disconnected or platform pipe quirk) -- server stays up` on stderr), since an
MCP stdio client can legitimately half-close stdin without ending the session.
`gm-mcp: connected, serving on stdio` on stderr confirms the server started.

Add it to your MCP client's server config, e.g.:

```json
{
  "mcpServers": {
    "gm": {
      "command": "npx",
      "args": ["-y", "github:AnEntrypoint/gm-mcp"]
    }
  }
}
```

## Development

`bin/gm-mcp-server.js` is a committed build artifact, not hand-edited source --
edit `src/index.js`/`src/dispatch.js`/`src/cli.js` instead, then rebuild:

```bash
npm install   # pulls the real deps into devDependencies for the build only
npm run build # bundles src/cli.js -> bin/gm-mcp-server.js, no runtime deps left
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
| `timeout_seconds` | number | no | Give up and return `timed_out:true` after this many seconds (default 120) |
| `poll_interval_seconds` | number | no | Fallback response check interval when filesystem events are unavailable (default 0.25) |
| `include_timing` | boolean | no | Include MCP submission-to-response timing and the last response wakeup source |
| `resume_task` | string | no | The `task` field from a previous `timed_out`/aborted response -- keep polling that SAME dispatch instead of writing a new one |

### Exec-family timeout prefix

gm rejects an exec-family body that carries no `timeoutMs=<ms>` line. The
error is `invalid_args: missing timeoutMs`. That answer costs one round trip
and does no work. The exec family is `exec_js` (aliases `nodejs`, `javascript`, `node`, `js`,
`typescript`) and every language stem: `bash`, `sh`, `shell`, `zsh`,
`python`, `py`, `powershell`, `ps1`, `ssh`, `go`, `rust`, `c`, `cpp`,
`java`, `deno`.

For these verbs the server adds the line itself when `raw_body` lacks one:

- the value is `timeout_seconds * 1000` (default 120000), floored at 100
- a `raw_body` that already starts with `timeoutMs=<ms>` or `timeout_ms=<ms>`
  (leading whitespace allowed) is sent unchanged -- an explicit line wins
- `serp`, `browser` and `cdp` are not touched; they take a `timeout=<ms>`
  line and carry their own default

The daemon tails a task for 30 s of wall clock and then returns a partial
result with its `task_id`. A `timeoutMs` above that window is still correct:
the task keeps running and the response says how to continue it.

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
