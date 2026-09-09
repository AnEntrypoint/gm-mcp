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
| `poll_interval_seconds` | number | no | How often to check for the response (default 1) |
