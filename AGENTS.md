# AGENTS.md

Facts about `src/dispatch.js` that structure and naming cannot fully carry.
The exec-family `timeoutMs` prefix and the `raw_body`/plain-text-verb contract
are documented in README.md ("Exec-family timeout prefix"); this file covers
what README does not.

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
  because the daemon runs the body for the full `timeoutMs` before it answers with
  a background `task_id`. A `resume_task` poll sends no body, so it only has
  `timeout_seconds` to go on.
- `unpackExecOutputEnvelope` parses the exec family's `data` JSON string into an
  object before cleaning, so `stdout`, `stderr` and `result` keep their own
  16000-character cap (`EXEC_OUTPUT_FIELD_TRUNCATE_AT`) instead of sharing the
  400-character cap of the packed string. The truncation marker names the
  out-file and says the value sits inside its `data` string, because the file
  itself still holds the packed form.
