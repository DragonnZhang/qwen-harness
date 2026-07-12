# Live evidence - End-to-end coding loop through the CLI (checkpoint 04 groundwork)

Status: LIVE_VERIFIED (coding-loop path)
Date: 2026-07-13
Model: qwen3.7-max via the Responses transport

## What ran

`qwen-harness run --profile yolo "The test math.test.mjs fails because multiply adds instead of
multiplies. Read math.mjs, fix it with edit_file, then run 'node math.test.mjs' with run_shell to
confirm PASS."` in a disposable Git fixture, through the compiled CLI.

## Result (verbatim, redacted)

```json
{
  "threadId": "thr_...",
  "state": "completed",
  "reason": "natural-completion",
  "finalText": "The test passes. ... `math.mjs` now correctly has `return a * b;` ... Output: PASS ✅",
  "detail": null
}
```

The real model, through the harness:
1. called `read_file` to inspect `math.mjs`;
2. called `edit_file` to change `a + b` to `a * b` — applied inside the bubblewrap sandbox, landing
   on the real host file;
3. called `run_shell` to execute `node math.test.mjs` inside the sandbox;
4. observed `PASS` and reported `state: completed`.

Independent verification after the run: `node math.test.mjs` prints `PASS`. The fix is real.

## What this exercises

The whole vertical stack at once, live: config → DashScope adapter (Responses) → runtime turn
engine → tool pipeline (schema → policy → sandbox worker) → SQLite event store. Every model-initiated
file and shell operation ran in the separate bubblewrap worker over capability-scoped RPC (SB-04).
The persisted event log records the turn, the tool calls, the side-effect intent/started/settled
ordering, and the completion.

## Deterministic counterpart

`apps/cli/test/integration/cli-run.test.ts` drives the same loop with a scripted provider (no live
latency) through the same real sandbox and pipeline, so this path is reproducible in `pnpm check`
without spending live budget.

## Scope

This complements the checkpoint-02 provider smoke: that proved the adapter's stream normalization;
this proves the whole loop drives real edits and verification to completion. The full checkpoint-10
live suite (interruption/recovery mid-turn, retryable-fault classification, subagent/team/MCP/
compaction smokes) is still required for final completion.
