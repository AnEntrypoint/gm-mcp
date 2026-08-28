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
npx github:AnEntrypoint/gm-mcp
```

Or add it to your MCP client's server config, e.g.:

```json
{
  "mcpServers": {
    "gm": {
      "command": "npx",
      "args": ["github:AnEntrypoint/gm-mcp"]
    }
  }
}
```

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
