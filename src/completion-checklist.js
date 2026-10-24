// The completion checklist as a string constant, so the bundle needs no runtime file.
// Mirrors src/completion-checklist.md byte for byte; regenerate this file when that one changes.
export const COMPLETION_CHECKLIST = `1. Do not end a turn on a proposed step. Run the decided step in the same turn.
2. Before any final message, check phase status. Final only at zero pending rows and a terminal phase, with every planned step done.
3. Read gm://prd/next. If a pending row exists, take it. Never stop with a pending row and no recorded blocking fact.
4. A row closes only with a live witness dispatch id from its own run, recorded in the dispatch ledger. After closing, prd_list pending must not list the row.
5. A row that does not close keeps its single blocking fact recorded and is retried on the next route.
6. Commit only explicit paths, and only after scripts/check-staged-secrets.mjs prints RESULT: PASS. The commit body carries Row, Witness and Status lines.
7. Push by full sha. Parent submodule pins follow each submodule's remote main tip.
8. After every push, read CI with ci-status for the full 40-character sha. Pending or failing is not passing. Unknown is reported as unknown.
9. Fix failing jobs as a new commit before reporting success.
10. Main only. No branches, worktrees or stashes. A dirty or diverged tree is a residual to reconcile in the same turn.
11. Relaunch any lane that finished without its row closed.
12. After each drain, run a fresh expansion pass. New findings become rows. Stop only when a pass files nothing.
13. A blocked route is never a stop: call health, then retry through gm_codemode.
14. Never ask the user to narrow scope. Take the most defensible default and state it in one line.
15. Snapshot (commit or push) before any destructive work.
16. The final report cites CI run ids for the full sha and a dispatch id for each witness.
`
