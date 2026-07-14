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
| **VERIFIED** | 38 | **84** |
| IN_PROGRESS | 83 | 53 |
| REQUIRED | 57 | 41 |

At the audit, **38 of 178 rows** were verified. Since then the count has been driven to **69** with
real committed evidence — never relabeling: +10 from generative property tests (fast-check) closing
the `P` gap; +3 from the installation/packaging guide closing `D` on PK-01/02/04; +5 near-misses
(ER-07 orphan-process + recovery-secret, PS-03 grant expiry/revocation, MC-04 annotation property,
BG-01 classifier, AG-10 shutdown-releases-in-flight); +1 (ER-03, the audit had missed the committed
live retry test); +3 live tests (CX-03, CX-04, MC-01). The TUI is now a real streaming session.

**UI-04 (the `/`, `@`, `!` completion/action surface) is now VERIFIED** — the last additions built
three real editor surfaces with U/S/T/E evidence, not relabeling: a slash-command registry (`/`) with
a component-level nav test and a compiled-bundle PTY test; `@` file completion confined to the
workspace with inert `SafeText` display (unit + PTY); and a `!` DIRECT USER SHELL ACTION that runs
through the real sandboxed pipeline with the user as policy actor and NO model turn. The `!` path
added `HarnessRuntime.runUserShell` (reusing the wired pipeline/policy/worker), proven against the
REAL bubblewrap sandbox in `apps/cli/test/integration/user-shell.test.ts`: it runs a command, audits
a redacted `user-shell` item as the user, is stopped by a managed shell-deny, and never streams the
model; the shipped bundle is exercised over a real PTY in `apps/tui/test/pty/shell-action.test.ts`.
Two more real races were found and fixed while making the PTY tests deterministic (a menu ROW renders
in the unfiltered `/` menu, so an executing Enter must gate on the editor's echoed buffer line, not a
row's presence — otherwise Enter fired on the wrong command).

**The live tests found a product-breaking bug** (fixed at `54ec115`): `TurnEngine.#drive` fed the
model the assistant's text but never its function-CALL items, so any multi-round task requiring the
model to CONSUME a tool result (read a file then edit, grep then fix, call an MCP tool then use the
answer) looped until budget-exhausted. Every prior test passed only because none required consuming
a result. This is the seventh and most severe "correct-looking but broken" defect this project
surfaced by running the real thing rather than trusting green unit suites.

**TL-03 and TL-04 (file tools; edits/diffs) are now VERIFIED** — their only remaining gap was a unit
(`U`) class, and TL-04 a `P` class, over already-WIRED code in `packages/tool-worker/src/handlers.ts`
(the real sandboxed file-tool path). Added `packages/tool-worker/test/unit/handlers.test.ts` (pure
`isBinary`/`detectLineEnding`/`digest`/`unifiedDiff`) and `unified-diff.property.test.ts` (a 2000-run
round-trip: applying the emitted diff to `before` reconstructs `after` for arbitrary edits). Their
other classes were already real: I (`sandboxed-tools.test.ts` pagination + edit), F (stale-edit
refused with `stale-file`), S (`path-escape`), P-escape (`resolve-scoped.property.test.ts`), E
(`evals/e2e/coding-loop.test.ts` lands a real `edit_file` on disk).

An 8th "loaded but not wired" case was found and then FIXED, and **TL-08 is now VERIFIED**. The
tool-call SCHEDULER (`packages/tools-core/src/scheduler.ts` `planBatches`/`conflicts`) was fully
unit-tested but NEVER called — the turn engine ran tool calls serially. It is now wired: `ToolExecutor`
gained an optional `planBatches` (the tools layer owns the footprint/conflict analysis, so the runtime
delegates rather than depending on `tools-core`), and `TurnEngine.#runToolCalls` runs the returned
groups — `#runOneCall` for single-call/mutation batches (the serial path, unchanged) and a new
`#runParallelBatch` that overlaps ONLY the tool executions while recording every durable event in call
order (phase 1 all intents, phase 3 all results), so the log stays deterministic and call↔result
pairing exact. Evidence: U (`scheduler.test.ts`), P (`scheduler.property.test.ts` — 1500-run
order/safety/isolation/width invariants), I (`runtime/test/integration/parallel-batch.test.ts` — a
barrier proves two reads run concurrently and it stays serial without `planBatches`), F (a failing call
in a batch leaves siblings correctly paired). A fake executor without `planBatches` keeps the serial
path, so no existing test changed, and the full `pnpm check` plus all 10 golden paths pass.

**TL-07 (the no-bypass tool pipeline) is now VERIFIED** — its gap was `U`+`P` over the already-wired
`ToolPipeline.decide`. Added `packages/tools-builtin/src/pipeline.test.ts`: unit tests prove a
schema-invalid or unknown-tool call is rejected BEFORE the policy engine (a spy) is ever consulted,
and that deny/ask/allow verdicts surface as denied/needs-approval/approved with the approved action
built from the VALIDATED arguments; a 1500-run property asserts policy is consulted IFF validation
passed — no bypass in either direction. Its other classes were real: I (`cli-run.test.ts` drives
read→edit→shell through the whole chain onto disk), S (the two alternate paths are both gated —
`hooks/test/security/hook-escalation.test.ts` a hook cannot flip a policy deny to allow;
`mcp/test/security/malicious-tool.test.ts` an MCP tool cannot bypass a managed deny).

**SS-06 (JSONL export / deterministic replay) is now VERIFIED** — its only gap was `U` over the
already-wired `packages/storage/src/export.ts`. Added `packages/storage/test/unit/export.test.ts`
covering the export FORMAT contract (one header line + one JSON event per line), unit-level round-trip
identity, replay into a fresh store rebuilding the identical projection, and `importJsonl`'s
validation branches (missing header, foreign format, too-new version, event-count mismatch). Its other
classes were already real: P (`export-unknown-roundtrip.property.test.ts`), I (`event-store.test.ts`
"deterministic projection rebuild (SS-01, SS-06)"), S (`redaction.test.ts` — a secret never reaches
SQLite or the JSONL export), E (`recovery.test.ts` / `fresh-install.test.ts`).

**OB-02 (observability readable via CLI/JSON) is now VERIFIED.** Its `U`/`S` were real
(`telemetry.test.ts` opt-in + retention; `telemetry-redaction.test.ts` canary) but the core
"readable via CLI/JSON" claim was untested and the docs still said telemetry was unwired. Added
`apps/cli/test/integration/trace-cli.test.ts` (the `trace` command prints the JSONL human-readably and
as one JSON record per line, warns on a corrupt line, and explains how to opt in when disabled) for
`I`, and corrected `docs/guide/operations.md`'s Telemetry section — it wrongly claimed "nothing emits
telemetry today," which is stale since telemetry is wired (`apps/cli/src/main.ts` `openTelemetry` →
tracer). The section now documents opt-in, `level`, `retentionDays`, the `trace`/`trace --json`
commands, and redaction, with runnable examples (`D`). Also note: PV-02 (`U`) and PV-10 (`P`) and
MM-02 (`P`) now have complete DETERMINISTIC evidence and are flippable once their remaining live/e2e
class lands.

**MM-02 (memory retrieval) is now VERIFIED** — its P was added earlier and its last gap was E. Added
`evals/e2e/memory.test.ts`: a deterministic golden task that stores two memories through the real
`memory add` command, then runs a real turn (only the model is a capturing scripted provider) and
asserts the RELEVANT memory reaches the model's composed instructions while the unrelated one is kept
out by budgeted side-selection — the full production path (store → memory surface → prompt composer →
engine). Its other classes were already real: U (`retrieval.test.ts`), P
(`retrieval.property.test.ts`), I/F (`memory/test/integration/store.test.ts` — retrieval + unreadable
isolation).

**IN-06 (repository instructions) is now VERIFIED** via the same reusable e2e pattern. Added
`packages/instructions/src/resolution.property.test.ts` (`P` — resolution is deterministic, orders
least-specific-first/most-specific-last, loses/duplicates nothing, and composes `rootText` from
exactly the always-on instructions) and `evals/e2e/instructions.test.ts` (`E` — a repo-root `AGENTS.md`
is authored, a real turn runs, and the convention reaches the model's composed instructions; the file
is also visible with its `repo-root` provenance via the `instructions` command). U/I were already real
(`resolution.test.ts`, `instructions-prompt.test.ts`).

The in-process `main()` + capturing-provider e2e pattern (introduced for MM-02, reused for IN-06) is
the general lever for the remaining "only E" rows: seed real state through the CLI, run a real turn,
and assert what reaches the model.

**OB-01 (local structured trace) is now VERIFIED** — its only gap was E, and telemetry is wired (see
OB-02). Added `evals/e2e/telemetry.test.ts`: telemetry is opted in via config, a real turn runs
(scripted provider), and the JSONL trace is read back and shown to record the turn lifecycle
(`turn.started`/`turn.ended`), the model parameters (`provider.request` with model + offered tools),
the user's items at debug verbosity, and usage — the production tracer/sink/decorators, not a mock.
U/I/S were already real (`trace.test.ts`/`telemetry.test.ts`, `file-sink.test.ts`,
`telemetry-redaction.test.ts`).

**MM-04 (memory consolidation) is now VERIFIED** — the loaded-but-not-wired case recorded above is
FIXED. `consolidateMemories` was implemented and unit-tested but never triggerable; added a real
`memory consolidate` CLI command (`apps/cli/src/memory.ts` surface method + `apps/cli/src/main.ts`
subcommand) that runs the mechanical pass over every stored memory and DELETES the superseded files
(exact duplicates, conflict losers, retired), reporting kept/conflicts/retired/removed. Evidence: P
(`consolidation.property.test.ts` — idempotence, each name kept once = the distinct input names,
kept `updatedAt` is the max for its name) and E (`evals/e2e/memory-consolidate.test.ts` — two files
share a `name`, `memory consolidate` resolves the conflict newer-wins and deletes the loser, and the
store then lists exactly one). U/I/F were already real (`consolidation.test.ts`, `dream.test.ts`).
The full `pnpm check` passes with this feature.

**AG-07 (team protocol message set) is now VERIFIED.** Its gap was a `U` proving the message SET is
complete — `protocol.test.ts` covers the AG-08 correlation tracker, not the set. Added
`packages/teams/src/protocol-messages.test.ts`: every one of the 15 required message types parses, the
union has exactly those members (none missing, none extra), unknown types and a request missing its
correlation id are rejected, and the request/response messages carry a correlation id. I (the protocol
machinery — tracker/inbox) and E (`evals/e2e/team.test.ts` golden path 5: 3 real teammate processes
round-trip plan-approval, permission, task-assignment, and shutdown messages, asserted at lines
171-181) were already real.

**IN-01 and IN-04 (skills two-level loading + strict frontmatter validation) are now VERIFIED** — the
skills engine was fully implemented and wired (`apps/cli/src/skills.ts`, the `skills` command,
`run --skill`) but had NO CLI-level I/E tests. Two shared tests flip both: `apps/cli/test/integration/
skills.test.ts` (I — `main(['skills','--json'])` catalogs a valid skill by frontmatter and REPORTS an
invalid one instead of silently dropping it) and `evals/e2e/skills.test.ts` (E — the catalog is built
from frontmatter alone, then `run --skill` loads the skill BODY and feeds it to the model, proving the
two levels; an invalid skill is reported). U/S were already real (`catalog.test.ts`/`registry.test.ts`/
`frontmatter.test.ts`, `untrusted-skill.test.ts`).

**PS-07 (config provenance + doctor explains every winning value) is now VERIFIED** — its only gap was
`I`: `doctor` had zero tests. Added `apps/cli/test/integration/doctor.test.ts` — `main(['doctor'])`
reports each winning config value WITH the scope it came from (a project-overridden `model` is
attributed to that scope; an un-overridden value to `builtin`), plus the platform/sandbox/config
sections. The other classes were already real: U + P (`config/src/resolve.test.ts` — provenance,
builtin fallback, and a combinatorial scope-winner boundary test over many scope combinations), S
(`managed-ceiling.test.ts` — a deny from a lower scope survives), D (`configuration.md`/`permissions.md`).

**SS-03 (fork identity/lineage + stable export schema) is now VERIFIED** — gaps were U and E. Added
`apps/cli/test/unit/sessions-fork.test.ts` (U — fork records lineage and copies history while the
original stays untouched, a fork-of-a-fork chains lineage, and export is the typed-event JSONL schema:
a header then one event per line) and `evals/e2e/sessions.test.ts` (E — a real turn creates a session,
`fork` reports a new id and the listing shows its `(forked from …)` lineage while the original has
none, then `export` emits the stable public JSONL). P is covered by the export round-trip property
(`export-unknown-roundtrip.property.test.ts` — export is stable/independent of internal tables); I
(`sessions.test.ts` integration) and D (`cli.md`) were already real.

The remaining 94 rows are still genuinely not verifiable today — a required evidence class is absent
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
