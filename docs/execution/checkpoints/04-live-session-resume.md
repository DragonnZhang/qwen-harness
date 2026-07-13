# Live evidence - Multi-turn session resume (SS-02)

Status: LIVE_VERIFIED (session continuity)
Date: 2026-07-13
Model: qwen3.7-max

## What ran

Two turns against the same session, via the compiled CLI in a disposable workspace:

1. `qwen-harness run --profile plan "Remember the number 42. Just acknowledge it briefly."`
   → session `thr_...`, reply: "Got it—42 noted."
2. `qwen-harness resume <thr_...> --profile plan "What number did I ask you to remember? Answer with just the number."`
   → reply: **"42"**

`qwen-harness sessions` then shows the thread with `turns=2`.

## Why this matters

Turn 2 ran in a fresh process. The model recalled `42` only because the harness reconstructed the
prior conversation FROM THE DURABLE LOG (`reconstructHistory`) and fed it back — local history is
authoritative (PV-08), and no remote `previous_response_id` was used. This is genuine multi-turn
session continuity, verified against the real model, not a fixture.

Deterministic counterpart: `apps/cli/test/integration/sessions.test.ts` proves list / history
reconstruction / fork-with-lineage / JSONL export over `:memory:` storage.
