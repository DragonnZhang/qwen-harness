# Live evidence - Provider smoke (bonus, checkpoint 02)

Status: LIVE_VERIFIED (provider path only; the full live gate is checkpoint 10)
Date: 2026-07-13
Model: qwen3.7-max
Endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1 (Responses transport)

## What ran

`evals/live/provider-smoke.test.ts`, driven by `pnpm test:live`, exercises the REAL
`provider-dashscope` adapter (not curl, not a fixture) and folds its stream through the runtime
`normalizeRound`.

Command: `pnpm test:live` — 2 tests passed.

## Verified against the real service

- The real model **called the `add` tool**, and the adapter preserved the exact `call_…` ID and
  parsed arguments `{a: 21, b: 21}` — proving PV-05/PV-06 through the actual wire, not a fixture.
- **Usage** was normalized with a positive total including billable reasoning tokens (PV-09).
- A **request ID** was captured for support/audit (PV-10/PV-12).
- Reasoning was accounted for as a summary/status, never as raw private chain-of-thought (PV-04).
- **No secret** appears in any normalized field (`JSON.stringify(round)` contains no `sk-…`).

## Fail-closed behavior (acceptance.md)

`pnpm test:live` runs `scripts/test-live.sh`, which exits **non-zero with a concise message** when
`DASHSCOPE_API_KEY` is absent — verified by unsetting the key and confirming exit code 1. The key
is loaded from `.env` without being echoed, and is never printed, logged, or committed.

## Scope

This is a budgeted smoke that de-risks the eventual full live gate. It does NOT yet cover the whole
checkpoint-10 live suite (interruption/recovery, edit+test+diff end to end under the live model,
retryable/non-retryable classification, subagent/team/MCP/compaction smokes). Those remain required
for final completion.
