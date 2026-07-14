# Checkpoint 10 — Final integrated acceptance and audit

Status: **INCOMPLETE — reported honestly, not called done**
Date: 2026-07-14
Gate baseline: `pnpm check` green from a clean committed tree — unit 1107, integration 227 (+1
skipped: no libsecret on this host), security 144, migrations 9, pty 2, e2e 40, performance 5,
packaging 57 = **1591 tests, 1 skipped**, then secret scan clean.
Live lane: `LIVE_AVAILABLE` — the credentialed `qwen3.7-max` suite (`evals/live/`) passes.

## The honest verdict

The definition of done in `task.md` requires **every** capability-matrix row to reach `VERIFIED`
with reproducible evidence. **That bar is not met.** After a rigorous, conservative, per-row audit
(six independent auditors, each required to cite the specific committed test satisfying *every*
evidence class a row declares, and to mark a row NOT-YET whenever any class lacked a real test):

| Status | Count (at audit) | Count (current) |
| --- | --- | --- |
| **VERIFIED** | 38 | **60** |
| IN_PROGRESS | 83 | 71 |
| REQUIRED | 57 | 47 |

At the audit, **38 of 178 rows** were verified. Since then the count has been driven to **60** with
real committed evidence — never relabeling: +10 from generative property tests (fast-check) closing
the `P` gap; +3 from the installation/packaging guide closing `D` on PK-01/02/04; +5 near-misses
(ER-07 orphan-process + recovery-secret, PS-03 grant expiry/revocation, MC-04 annotation property,
BG-01 classifier, AG-10 shutdown-releases-in-flight); +1 (ER-03, the audit had missed the committed
live retry test); +3 live tests (CX-03, CX-04, MC-01). The TUI is now a real streaming session.

**The live tests found a product-breaking bug** (fixed at `54ec115`): `TurnEngine.#drive` fed the
model the assistant's text but never its function-CALL items, so any multi-round task requiring the
model to CONSUME a tool result (read a file then edit, grep then fix, call an MCP tool then use the
answer) looped until budget-exhausted. Every prior test passed only because none required consuming
a result. This is the seventh and most severe "correct-looking but broken" defect this project
surfaced by running the real thing rather than trusting green unit suites.

The remaining 118 rows are still genuinely not verifiable today — a required evidence class is absent
or the behavior is unimplemented. This document records which, and why, so the gap is a work-list.

## What IS done (not diminished by the above)

- **All ten cross-capability golden paths pass** as real, committed, executed tests: coding loop,
  crash recovery (real SIGKILL, exactly-once), permissions (hostile repo through real bubblewrap in
  all four profiles), long-context compaction, team execution (3 real teammate processes, real
  worktrees, collision-free claim, ceiling denial), scheduling (cron across a real process restart,
  fires once, ceiling-clamped), MCP (real second-process HTTP server, PKCE OAuth, malicious-server
  denial), TUI over a real PTY driving the compiled bundle, live model (real `qwen3.7-max` fixes a
  bug and survives an injected transient fault), and fresh install (build → install → run → export →
  uninstall with no residue).
- `pnpm check` passes end to end — the checkpoint-09 gate.
- The 38 VERIFIED rows rest on real components: the real policy engine, real bubblewrap 0.11.1 with
  actual escape attempts, real SQLite with crash-boundary injection, real separate-process
  concurrency, seeded property tests, and the live model.

### The 38 VERIFIED rows

RT-01, RT-03, RT-08 · PV-01, PV-03, PV-05, PV-06, PV-07, PV-09, PV-11, PV-12, PV-13 · SS-01, SS-04,
SS-05 · PS-02, PS-05, PS-06 · SC-02 · SB-01, SB-03 · MC-03 · IN-02, IN-07 · CX-02 · MM-06 · WK-03,
WK-04, WK-05, WK-06, WK-07 · CR-01, CR-02, CR-03, CR-05, CR-07 · GT-01 · UI-01.

## Why the other 140 are NOT-YET — the root causes

The audit found the gaps cluster into a small number of systemic causes, not 140 unrelated misses:

1. **No property/fuzz tooling** (`fast-check`) exists outside `packages/policy`. The `P` evidence
   class is required on ~20 rows and is satisfied only where an exhaustive-enumeration or
   seeded-PRNG test happens to exist. Adding a property-test harness would unblock the `P` class on
   TL-08/11/14, PS-04/11, SB-02/04, HK-03/04, AG-06/08/12/13, BG-04, MC-06/09, RT-02/04/09, and more.
2. **The live lane is Responses-transport-only.** Two live tests exist (provider smoke, coding
   loop). No live test drives the Chat compatibility transport, provokes a real error/throttle
   class, or exercises MCP/subagents/compaction/instructions live. This is the sole blocker on
   PV-10, MC-01, AG-01/05, CX-03/04, IN-10, ER-03, and the live half of several others.
3. **The TUI surface is narrow.** The shipped Ink app renders the coding loop (transcript, editor,
   approval dialog, status line) and nothing else. There is no slash/`@`/`!` completion, no session
   picker, no background/task/team/cron/worktree/hook/memory panels, no `/btw`, no `/rewind`. Every
   `T`-required row for those surfaces is NOT-YET because the *feature* is absent, not just the test:
   UI-02..UI-18 (most), WK-01/08/09, AG-09/14, BG-02/06, CR-04, GT-04, CX-01/06, MM-01, OB-03.
4. **`tools-builtin` / `tools-core` have essentially no unit tests**, so every tools row's `U` class
   leans on e2e — blocking TL-01/03/04/05/07/12 on `U`.
5. **Genuinely unimplemented behavior.** Some rows describe features that do not exist yet:
   WebFetch/WebSearch (TL-13), a destructive-git tool (TL-06), durable tool-output offload (TL-10),
   early tool start while streaming (TL-09), turn steering (RT-07), `previous_response_id`
   continuation (PV-08), output-length continuation (ER-01), automatic post-turn memory extraction
   (MM-03), session rename/archive/delete + picker (SS-02, UI-10), storage retention/vacuum/backup
   (SS-07), 24 of the 30 hook events actually dispatching (HK-01), non-command hook handler forms
   (HK-02), the comprehensive audit record (SC-03), remote reference-peer backends (CR-06, BG-03/07),
   resumable subagents (AG-04), and the `/rewind` checkpoint system (UI-18).
6. **CI runs only the spec-freeze check**, not the full gate suite (QL-02); the architecture gate
   script itself has no test (QL-03).

## What closing the gap would take

Ranked by leverage: (a) add a property-test harness and backfill `P` across the flagged rows; (b)
build out the TUI surface (panels, picker, completions, rewind) with PTY tests; (c) add live tests
for the Chat transport, error classes, MCP, subagents, and compaction; (d) unit-test `tools-builtin`
and the tool result contract; (e) implement the missing features listed in cause 5; (f) run the
full gate in CI. This is substantial — realistically the bulk of the remaining product work — and it
is not something to paper over by relabeling rows.

## Standing honesty

No row was flipped to `VERIFIED` without a cited, committed, real test for every evidence class it
declares. The six "loaded but not wired" defects found while building (managed ceiling, credential
alias, `config.baseUrl`, the migrations gate, the performance gate, the retry policy) are all closed
and were each caught by running the real thing rather than trusting a green unit suite — which is
the same discipline this audit applied to the matrix.
