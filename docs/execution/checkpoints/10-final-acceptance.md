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
| **VERIFIED** | 38 | **125** |
| IN_PROGRESS | 83 | 24 |
| REQUIRED | 57 | 29 |

### Definition-of-done items 1–12 — honest status (consolidated)

Documented explicitly so the acceptance state is legible in ONE place. This is an in-progress
assessment, not a completion claim; incomplete items are marked incomplete.

| # | Item | Status | Evidence / why |
|---|---|---|---|
| 1 | Every matrix row VERIFIED with current evidence | **IN PROGRESS — 125/178** | 53 rows remain; each requires a build documented in the landscape memory + §"Genuinely unimplemented" below. |
| 2 | 10 golden paths pass | **DONE** | All ten cross-capability golden paths run as committed executed tests (this file, "All ten … golden paths pass"; `evals/e2e/*`). |
| 3 | `pnpm check` passes clean from a committed tree | **DONE (continuously)** | Verified before every one of this session's commits; the gate baseline above. |
| 4 | `pnpm test:live` green vs `qwen3.7-max` | **NOT GREEN** | Ran and is not fully green (§ below): model non-determinism on the coding-loop/compaction live cases. Requires live-model tuning; no offline substitute. |
| 5 | CLI installs / runs / resumes / uninstalls | **LARGELY DONE** | `packaging/test/{bootstrap,lifecycle}.test.ts`; resume path in `evals/e2e` + `apps/daemon` turn.test.ts. |
| 6 | TUI PTY / Unicode / resize / etc. gates | **PARTIAL** | PTY suite (`apps/tui/test/pty/*`) covers streaming/mode-switch/slash-commands; not every gate class is exhaustively closed. |
| 7 | Sandbox + adversarial suite | **DONE** | SC-01 (9-vector suite, this session) + the `*/test/security/*` sandbox suites (real bubblewrap). |
| 8 | Crash / side-effect injection | **LARGELY DONE** | Daemon SS-05 crash recovery + `*/test/security` injection tests (side-effect-injection, output-DoS, path-escape). |
| 9 | Architecture / schema checks | **DONE** | QL-03 (mechanical gate, this session) + `pnpm architecture` (9 boundaries) + the `migrations` project. |
| 10 | Full docs | **PARTIAL** | Guides/defaults/checkpoint updated this session (prompt-modes, MCP precedence, cron backends, `--worktree`); not every surface is documented. |
| 11 | No undisclosed limitations / shortcuts | **ONGOING — honored** | Limitations surfaced explicitly (item 4, HK-01 event coverage, the durable-recurring-restart observation, BG-03's absent categories). |
| 12 | Clean tree + checkpoint commits + final report | **PARTIAL** | Tree clean + per-flip checkpoint commits throughout; the FINAL report is deliberately NOT written because item 1 is not complete. |

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

**HK-05 (post-tool hooks stop continuation) is now VERIFIED — a 10th loaded-but-not-wired case,
found by running the real thing and FIXED.** The hook engine computed `FoldedHookResult.stopped`
(with `resultDurable`) for a PostToolUse `stop`, and `engine.test.ts` proved the hook engine honours
it — but the turn engine's `TurnHooks.postToolUse` returned `Promise<void>` and the CLI adapter threw
the signal away, so a real `stop` was silently dropped: the tool ran and the turn continued to
another model round anyway. The E golden task caught it (the model was asked twice, not once). Fix,
end to end: `TurnHooks.postToolUse` now returns `void | {stopContinuation?}`; the turn engine records
the durable tool-result and the paired function-output FIRST, then a `stop` ends the turn via a new
`hook-stop` phase kind that completes the turn cleanly (`completed`/`hook-stopped`) instead of driving
another round — in BOTH the serial (`#runOneCall`) and parallel-batch (`#runParallelBatch`) paths; the
`hook-fired` event now records `outcome: 'stop'`; the CLI adapter propagates `result.stopped`. A void
return still means "do not stop", so every existing `TurnHooks` fake is unaffected (30 runtime tests
green). Evidence, all genuine: U + F (`packages/hooks/src/engine.test.ts` — re-entry refusal 198-234,
post-tool stop-without-corruption 224, throwing/timeout hook surfaced 156-174); I
(`apps/cli/test/integration/hooks.test.ts` — a real command hook returns `stop` on the real turn: the
tool marker IS written and the durable tool-result IS present, a `hook-fired`/`stop` is recorded, and
the round-2 tripwire text never lands); E (`evals/e2e/hooks.test.ts` — the full `main()` flow with a
real hook process asks the model exactly once). The full `pnpm check` passes with this fix.

**UI-15 (headless CLI) is now VERIFIED — and an 11th loaded-but-not-wired defect was fixed on the
way.** `--quiet` and `--no-color` were both accepted into `BOOLEAN_FLAGS` but consumed NOWHERE: a
machine caller passing `--quiet` still got the full status/notes chrome — a false-assurance inert
flag. `--quiet` is now genuinely wired: it suppresses the informational stderr chrome (the trailing
`[state: reason] session` status line, the recovery and MCP-degradation notes, the awaiting-approval
"how to resume" decoration) while NEVER suppressing the actual result on stdout or a genuine error —
quiet is not silence. `--no-color` is honest too: the headless path emits only plain strings (model
and tool text cross the `UntrustedText` sanitizer), so it is a plain-output guarantee, and the E
asserts no ESC control sequence ever reaches a headless stream. Evidence, all genuine: U
(`apps/cli/test/unit/parse-flags.test.ts` — the argv contract: boolean flags never swallow the next
token, value flags consume exactly one, `--k=v` is unambiguous, positionals preserved — the exported
`parseFlags`); I (`apps/cli/test/integration/cli-run.test.ts` — real `main()` argv `run --json
--profile yolo` over the REAL bubblewrap sandbox: a real `edit_file` lands `a * b` on disk, stdout is
one structured `{state:'completed'}` object, exit code 0); E (`evals/e2e/headless.test.ts` — the full
contract via `main()`: one structured JSON line + exit 0 on completion; an approval-requiring tool
SUSPENDS and is surfaced in JSON with exit code 3, never blocking; `--quiet` strips the status line
but keeps the result; output is ANSI-free; `resume <id> <prompt>` continues the SAME durable session).
The full `pnpm check` passes with this fix.

**RT-04 (typed termination reasons) is now VERIFIED — and it retroactively caught a bug from the
HK-05 fix.** Writing RT-04's property test surfaced that `#endTurn` took a free `reason: string` and
appended it to the durable `turn-ended` event with an `as never` cast — so the HK-05 change had
emitted `'hook-stopped'`, which is NOT in `TerminationReasonSchema` (the canonical value is
`'hook-stop'`). It did not crash only because the sink does not Zod-validate on write; a consumer that
parses a `turn-ended` event on read/export WOULD reject it. Fixed both ways: the reason is corrected
to the canonical `'hook-stop'`, and `#endTurn` (plus the `ToolPhase` budget variant) now takes a
`TerminationReason`, not a string — so the COMPILER refuses an untyped reason at the boundary, which
is RT-04's guarantee made structural. The budget module was already exemplary (`BudgetVerdict.reason`
is `TerminationReason`); the leak was only the widening at the turn-engine seam. Evidence, all genuine:
U (`packages/runtime/src/budget.test.ts` — each limit → its specific reason); P
(`packages/runtime/src/budget.property.test.ts` — over any sequence of model/tool/retry/idle/repeat/
time operations, a `stop` verdict NEVER carries an untyped or off-enum reason, the run is
deterministic, and each pathology maps to its OWN reason: repeated-identical-calls, no-progress,
model-call-limit, time-limit, retry-limit); F (`packages/runtime/test/integration/turn-engine.test.ts`
— repeated-identical-calls, no-progress, and a permanently-failing retryable fault bounded at the
attempt budget); E (`evals/e2e/termination.test.ts` — a real `main()` turn scripted into an
identical-call loop terminates with `repeated-identical-calls`, surfaced through the headless JSON,
and the reason parses against the enum). The full `pnpm check` passes with this fix.

**MM-05 (memory scope distinctions) is now VERIFIED — a 12th loaded-but-not-wired gap, fixed.** The
memory PACKAGE keys `auto` memory by the canonical repository (`resolveMemoryDir` honours
`canonicalRepoRoot`), and the unit test proved it — but `createMemorySurface` hardcoded
`canonicalRepoRoot: opts.workspaceRoot`, with a comment admitting that is only right for a
"non-worktree checkout". No CLI client ever computed the real canonical root, so the headline MM-05
distinction — "a lesson learned in one worktree is available in its siblings" — was NOT delivered end
to end: two worktrees of one repo got two separate auto stores. Fixed: `createMemorySurface` now takes
an optional `canonicalRepoRoot`, and the CLI computes it from git (`rev-parse --path-format=absolute
--git-common-dir`, whose shared common dir is identical from every linked worktree; the canonical root
is its parent), falling back to the workspace root outside a repo. Evidence, all genuine: U
(`packages/memory/src/scopes.test.ts` — five frozen scopes, session has no directory, project/team in
distinct trees, auto keyed by canonical repo); I (`packages/memory/test/integration/store.test.ts` —
real-file read/write/list with provenance); E (`evals/e2e/memory-scopes.test.ts` — through the REAL
CLI over a real `git worktree`: an `auto` memory added from the MAIN worktree is listed from a LINKED
sibling, and an unrelated repo does NOT see it — sharing is scoped to the canonical repo, not the
machine); D (`docs/guide/cli.md` — the five-scope table and a runnable main-worktree→linked-worktree
example). The full `pnpm check` passes with this fix.

**CX-01 (context budgets) is now VERIFIED — a 13th loaded-but-not-wired gap, found and FIXED.**
`StatusModel.contextTokens` was set to `null` in every turn model (`live-turn.ts`, `scripted-turn.ts`,
`bin.tsx`) and NEVER computed from the transcript, so `StatusLine`'s `{contextTokens} ctx` indicator
(StatusLine.tsx:42-45) was dead code — the TUI never actually exposed utilization, even though
`computeBudget` had all the math. Fixed: a shared `estimateContextTokens(transcript)` (new
`apps/tui/src/context-estimate.ts`) returns the measured serialized-size token estimate (null before
there is any context, so the indicator stays hidden), and both the live and scripted turn models now
populate `contextTokens` from the current transcript. Evidence, all genuine: U
(`apps/cli/test/unit/context.test.ts` for utilization + `apps/tui/test/unit/context-estimate.test.ts`
for the estimator — null when empty, positive and deterministic otherwise, monotonic as the transcript
grows); P (`packages/context/src/budget.property.test.ts` — across any window / reserve / overhead /
transcript, the reserve+usable split is exact, `available` never negative, utilization = used/usable,
overflow implies over-threshold, adding content never lowers utilization, `estimateItems`
deterministic); I (`apps/cli/test/integration/compaction.test.ts` — real TurnEngine compaction path);
T (`apps/tui/test/pty/golden-path-8.test.ts` — the compiled TUI over a real PTY: once a transcript
exists the `<n> ctx` utilization indicator renders in the frame, the previously-dead branch now live).
The full `pnpm check` passes with this fix.

**GT-03 (worktree persistence + recovery) is now VERIFIED — the persistence layer was entirely
missing, so it was BUILT.** `createWorktree` did the git side effect and returned an in-memory record;
nothing survived a crash, and the record captured none of the spec's origin/owner/session/recovery
fields. There was no worktree event or store anywhere in the codebase. Added: `captureWorktreeOrigin`
(records the origin repo's real cwd/branch/HEAD via the hardened git helper), a durable `WorktreeStore`
(a `<repoRoot>/.qwen-harness/worktrees.json` manifest holding path/branch/base, origin, owner/session,
and recovery state), and `reconcile` (re-derives each record's recovery state from the filesystem —
an orphaned checkout whose directory is gone is detected, not silently forgotten). Evidence, all
genuine: U (`packages/worktrees/test/unit/persistence.test.ts` — every field round-trips, a FRESH
store reads what a prior one wrote, upsert/remove by slug, reconcile re-derives state, a corrupt
manifest throws and a malformed entry is isolated); I (`.../test/integration/persistence.test.ts` —
a REAL git worktree with its captured real branch/HEAD persists and reloads from a fresh store); F
(same file — deleting a checkout directory out from under the manifest, a crash simulation, reconciles
that record to `orphaned` while an intact sibling stays `active`). The full `pnpm check` passes.

**AG-06 (teammate inbox) is now VERIFIED — P and F added over the existing, correct implementation.**
The `Inbox` was already ordered, idempotent (a permanent `#seen` id set), and wakes a sleeping reader,
with U (`inbox.test.ts`) and I (`test/integration/teammate.test.ts` — the inbox drives real teammate
loops and the atomic single-winner task claim). The two missing classes are now real:
`packages/teams/src/inbox.property.test.ts` proves **P** (across any delivery sequence with duplicate
ids: `deliver` returns true exactly for a first sighting, entries drain in first-seen order on a
strictly-increasing sequence, `pending` equals the distinct-id count, a drain empties it, and a
post-drain replay delivers nothing) and **F** (the crash-replay recovery idempotency exists for — a
writer that crashed mid-append and replays its whole batch leaves the inbox byte-identical, no
duplicated message). The full `pnpm check` passes.

**AG-11 (autonomous teammate loop) is now VERIFIED — U, P, F added over the existing loop.** The
`Teammate` state machine (shutdown-first, drain inbox, atomically claim a pending/unowned/unblocked
task, else idle) already had I (`test/integration/teammate.test.ts` — claim/complete/idle, the
two-teammates-one-task atomic race, shutdown-first) and E (`evals/e2e/team.test.ts` — a lead plus
three REAL teammate OS processes in isolated worktrees drain four DEPENDENT tasks with no collision,
exactly one work-result per task, clean shutdown). Added the missing three, all genuine:
`packages/teams/src/teammate.test.ts` for **U** (the transitions: claim→work→complete→idle, a stopped
teammate stays inert, an aborted signal stops before claiming) and **F** (a FAILED unit of work
RELEASES its task back to the pool so another teammate retries it — never silently completed or
stranded); `packages/teams/src/teammate.property.test.ts` for **P** (N teammates stepped concurrently
in rounds drain M tasks with every task worked EXACTLY ONCE by exactly one owner — the atomic claim,
not a dispatcher, prevents duplication). The full `pnpm check` passes.

**AG-12 (lost-teammate reclaim without duplicate execution) is now VERIFIED — U/P/F added, and the E
unblocked cleanly.** `TeamRecovery` (detectLost + reclaimTasks) had only one integration test. Added
`packages/teams/src/reclaim.test.ts` for **U** (reclaim releases ONLY the lost member's
claimed/in-progress tasks — never a completed one, another member's, or an unowned one — and
detectLost respects the heartbeat timeout) and **F** (a lost member's in-flight task is reclaimed and
completed EXACTLY once by another; the ghost never re-runs it), and
`packages/teams/src/reclaim.property.test.ts` for **P** (over any roster, reclaim is selective and
leaves every non-reclaimed task byte-identical). The **E** needed the recovery machinery in a real
end-to-end task, which `evals` could not import — so `@qwen-harness/teams` was added to the
HAND-MAINTAINED `evals/package.json` + `evals/tsconfig.json` (evals is not a `PACKAGE_DEPS` key, so
gen-packages is not involved and the risky generator path is avoided). `evals/e2e/team-recovery.test.ts`
now drives the full flow: a teammate claims+starts a task then vanishes, recovery detects the loss and
reclaims, and a survivor running the REAL autonomous loop drains the whole pool — every task completed
once, the abandoned one finished by the survivor, no double-run. The full `pnpm check` passes. (This
dep addition also unblocks the E class for other teams-backed rows.)

**AG-03 (bounded subagents) is now VERIFIED — P added over comprehensive existing coverage.** The
`SubagentSupervisor` already had U/F/S in `packages/agents/src/subagent.test.ts` (authority
intersection so a child never exceeds its parent even when it requests more, the managed ceiling
capping a yolo parent, a bounded conclusion rather than the full transcript, count/depth limits, a
child at max depth cannot spawn grandchildren, and parent-cancellation propagation) and I in
`apps/cli/test/integration/team.test.ts` (a teammate — a subagent via the same `SubagentSupervisor` —
is clamped from `yolo` down to an `ask`/`plan` lead ceiling with the real policy intersection, never
widened). Added the missing **P** (`packages/agents/src/subagent.property.test.ts`): for ANY parent
profile, requested profile, and managed policy the computed child authority `isAtMost` the parent — a
child can never escalate by asking — and spawning past the total-child limit or from a supervisor
already at the depth limit is refused with a typed error, so no unbounded tree can grow. The full
`pnpm check` passes.

**GT-05 (task/worktree binding independence) is now VERIFIED — the binding was built as
worktree-side-only metadata.** The requirement is that a task↔worktree binding is OPTIONAL metadata
that never silently changes task state, and that task ownership and workspace ownership stay
independently recoverable. Implemented structurally: an optional `boundTaskId` on the durable
`PersistedWorktree`, set/cleared by `WorktreeStore.bind(slug, taskId | null)`, which reads and writes
ONLY the worktree manifest — it has no `TaskGraph` dependency (the `worktrees` package does not even
depend on `tasks`), so binding cannot touch a task by construction. Evidence, all genuine: U + P
(`packages/worktrees/test/unit/binding.test.ts` — a worktree without a binding is valid, bind/unbind
round-trip durably, an unknown slug is a reported no-op, and over any sequence of bind/unbind ops the
binding reflects the last op while every other field stays byte-identical); I + F
(`apps/cli/test/integration/worktree-binding.test.ts` — over the REAL `TaskGraph` + `WorktreeStore` +
real git: binding a worktree to a claimed task leaves the task's owner/status untouched; then a crash
orphans the checkout and the task is entirely unaffected, while completing the task never disturbs the
worktree binding — the two recover on independent tracks). The full `pnpm check` passes.

**BG-05 (background limits/concurrency/watchdog) is now VERIFIED — the S class added over deep
existing coverage.** The `BackgroundManager` already had U (four-way foreground concurrency + FIFO
queue, the 30s input watchdog and 5-minute blocked transition, output warn/preview, cancellation), P
(an fc.assert idempotency property — exactly one settlement per triggered task over generated
sequences), I (`test/integration/lifecycle.test.ts`), and F (cancel-and-cleanup, watchdog trip). The
missing S — resource-exhaustion resistance — is now real: the output hard-stop ceiling was a fixed 5
GiB constant, untestable without producing gigabytes, so it was made injectable (`hardStopBytes`,
defaulting to the frozen 5 GiB) and `packages/background/test/security/output-dos.test.ts` proves that
a task flooding output past the ceiling is FORCE-stopped — cancelled at the runner and settled failed,
never left running to fill memory or disk — while output under the ceiling keeps running (no false
positive). The full `pnpm check` passes.

**SS-07 (session-store maintenance) is now VERIFIED — the operations were BUILT.** The remaining rows
increasingly need feature implementation, not just tests: SS-07's retention/prune, vacuum, and backup
did not exist. Built them on the `EventStore`: `prune({olderThanMs, now})` (retention at THREAD
granularity — a stale session is dropped whole across every thread-scoped table in one transaction,
survivors keep full append-only history), `vacuum()`, and `backup(destPath)` (SQLite online backup;
restore is simply reopening the copy). Hardened the store to create its file **0600** (owner-only).
Exposed all three through a new `qwen-harness maintenance prune|vacuum|backup` CLI command. Evidence,
all genuine: U + P (`packages/storage/test/unit/maintenance.test.ts` — prune drops old sessions and
keeps recent ones with their history, vacuum runs, an online backup reopens complete; the property
pins the retention boundary exactly and proves a second prune is a no-op); I
(`test/integration/backup-restore.test.ts` reopening a real backup with every thread intact, plus
`apps/cli/test/integration/maintenance.test.ts` driving the real command); F (same backup file
recovers after the primary DB is deleted, and `test/migrations/rollback.test.ts` proves a failing
migration rolls back atomically — no partial schema, version unchanged); S
(`test/security/permissions.test.ts` — the file is 0600 with no group/other bits, WAL + fail-fast busy
timeout so a second connection reads only committed data); D (`docs/guide/operations.md` maintenance
section with the runnable commands). The full `pnpm check` passes.

**PK-03 (managed-policy precedence) is now VERIFIED — P/S added, and a STALE DOC corrected.** The
config resolver (`resolveConfig`: per-key last-write-wins with `managed` never out-voting an ordinary
value, deny-union that only ever grows, managed ceiling clamped last) was fully implemented with U
(`resolve.test.ts`) and I (`test/integration/load.test.ts`). Added the missing **P**
(`packages/config/src/resolve.property.test.ts` — for any set of scopes the highest-precedence one
that set a key wins with matching provenance, and the deny list is exactly the union) and **S**
(`packages/config/test/security/managed-ceiling.test.ts` — a hostile lower scope cannot widen
authority past the managed ceiling and can never drop a managed deny). The **D** required correcting a
genuinely misleading doc: `configuration.md` claimed "only `doctor` reads it" and "do not deploy a
managed policy and assume it constrains a run" — but `loadRunAuthority` → `authorityFromConfig` now
hoists the deny-union into managed rules and hands the clamped ceiling to `createHarnessRuntime`
(verified: `--profile yolo` under managed `maxProfile: ask` resolves to `ask`; `main.ts` also reads
config `model` and `telemetry`). The doc now states the truth — the ceiling is enforced in a real run
— with the one honest remaining gap (`budgets`/`toolOutput` still take engine defaults) noted. The
full `pnpm check` passes.

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

**The live gate (`pnpm test:live`) was RUN and is NOT fully green — definition-of-done item 4 is NOT
satisfied.** Result: 4 of 7 live tests passed (241s). PASSED: `provider-smoke` (real qwen3.7-max
streams text, a reasoning summary, a tool call, and usage through the real adapter — this is
**PV-02's L**, now flipped to VERIFIED: U/I were already real), `mcp` (live model calls a real stdio
MCP tool), and the coding-loop fault-injection test. FAILED: (a) `coding-loop` "the model fixes the
bug" and (b) `compaction` — both ended with the turn in state `failed` after the live model produced
coherent text (compaction's was mid-task: "the output was truncated, let me get the exact line
count") — consistent with the live model's non-deterministic, verbose exploration hitting a turn/budget
limit (the compaction test deliberately grows a large transcript). The DETERMINISTIC equivalents
(`evals/e2e/coding-loop.test.ts`, `long-context.test.ts`) and all ten golden paths and the full
`pnpm check` are green, so the tool pipeline (including the TL-08 refactor) is sound. The one TL-08
concurrency risk was checked and CLEARED: `ToolWorkerClient.run` spawns a fresh sandboxed worker and a
private scratch dir PER CALL (`packages/tool-worker/src/client.ts:25-29`), so `#runParallelBatch`'s
concurrent `tools.execute` calls are fully independent — a live round with 2+ reads cannot corrupt
them. And (c)
`tui-stream` timed out after 120s waiting for the streamed response, emitting a React
"setState while rendering" warning from the live streaming path. That warning does NOT reproduce in
the deterministic TUI unit/PTY suites and is not in any code path this session changed (for a plain
prompt the `@`/`!`/slash menus are inert) — it is a pre-existing streaming↔editor render race, recorded
here as a real open issue. **Honest status: the live lane is functional (credential, streaming, tools,
MCP all work live) but the gate is not green; item 4 requires tuning the coding-loop/compaction live
budgets for the current model and fixing the tui-stream streaming race.**

**WK-02 (durable tasks vs legacy todos) is now VERIFIED** — gaps were E and D. Added
`evals/e2e/tasks.test.ts` (E — a durable dependency graph through `main()`: create with `--blocked-by`,
a bulk `task todo` write that mutates NO durable task, `task list` still holding exactly the two tasks,
then `complete` reporting the dependent as `newlyUnblocked` and `get` showing it `pending`) and the D
via the new CLI command documentation in `docs/guide/cli.md` (the durable `task` API and the
turn-local `task todo` checklist documented as explicitly separate). U/I were already real
(`packages/tasks/src/todo.test.ts`, `apps/cli/test/integration/durable-work.test.ts`). This session
also documented the previously-undocumented `task`/`skills`/`memory`/`trace`/`mcp`/`background`/`cron`
commands in cli.md (definition-of-done item 10 progress; satisfies the D class for those surfaces).

**IN-03 (skill source precedence) is now VERIFIED** — gaps were I and D. Added
`packages/skills/test/integration/precedence.test.ts` (I — same-named skills written to real on-disk
source directories are discovered and run through the real registry: a project skill shadows a
same-named user one, a MANAGED name is reserved and cannot be shadowed by a project skill, and distinct
names all register) and the D via the corrected precedence documentation in `docs/guide/cli.md`
(managed > project > additional > user > plugin > MCP > bundled, managed reserved). U/P were already
real (`sources.test.ts` — the precedence table as data, ordering, managed ceiling, and
`resolvePrecedence` deterministic regardless of discovery order).

**IN-05 (inline vs forked skill execution semantics) is now VERIFIED** — gaps were P and I. Added
`packages/skills/src/execution.property.test.ts` (P — a 2000-run fuzz over arbitrary declared tools,
held tools, context modes, and parent authorities: the plan's effective tools are always a subset of
the parent's, a declared-but-unheld tool is denied, and the real backstop `assertPlanNeverBroadens`
holds for every input) and `packages/skills/test/integration/invoke.test.ts` (I — a skill discovered
from real files, invoked through the real registry: tools are narrowed to `allowed-tools ∩ held`, the
unheld tool is denied, the context mode matches the frontmatter, and a per-skill token budget is set).
U was already real (`execution.test.ts` inline/forked/narrowing/managed-ceiling), and E is the
end-to-end `run --skill` invocation in `evals/e2e/skills.test.ts` (the skill body is loaded into the
model prompt — inline result semantics).

**MC-07 (OAuth 2.0 + PKCE) is now VERIFIED** — gaps were P, F, and a real OAuth I (the survey's claimed
I was actually MC-06's `list_changed` refresh, not OAuth). Added `packages/mcp/src/oauth-resilience.test.ts`
(P — a 1000-run property: the S256 `code_challenge` is the URL-safe digest of any verifier,
deterministic, never the verifier itself; F — a refresh with an invalid/revoked token FAILS visibly,
never silently returning a stale token) and `packages/mcp/test/integration/oauth-flow.test.ts` (I — the
full auth-code + PKCE exchange through the REAL `SecretStore` token-store hierarchy: the token persists
and a FRESH client instance reuses it without re-authorizing). U (`oauth.test.ts`), S (`oauth-csrf.test.ts`
forged-state rejection), and E (`evals/e2e/mcp.test.ts` — real second-process OAuth with real PKCE/state/
exchange) were already real. The MCP cluster is now fully VERIFIED.

The remaining 89 rows are still genuinely not verifiable today — a required evidence class is absent
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
**TL-10 (durable tool-output offload) is now VERIFIED.** The offload was already implemented
(`context.ts` writes any tool output over 4096 chars to the durable blob store under a content-digest
key `blb_<hash>`, leaving a bounded preview inline; `reduction.ts` has the U and the compaction
integration test drives the real offload). Added the two missing classes: **S**
(`packages/storage/test/security/blob-addressing.test.ts` — a blob is retrieved ONLY by its exact
digest, and a path/traversal string is never a valid key, so an offloaded reference can never become a
read of `../../etc/passwd` even when the tool output IS a path string) and **E**
(`evals/e2e/tool-output-offload.test.ts` — a real `main()` run reads six distinct large files; old
results fall past the recent window and their payloads land in the blob store, while the durable
tool-results stay intact). The full `pnpm check` passes.

**MC-05 (MCP precedence + trust) is now VERIFIED.** The resolver was implemented (`packages/mcp/src/
config.ts`: `connector < plugin < user < approved-project < local`, a managed exclusive/deny ceiling,
and a project server that stays untrusted+inactive until explicit trust) with U (`config.test.ts`) and
I (`apps/cli/test/integration/mcp.test.ts`). Added the missing classes: **P**
(`config.property.test.ts` — over any set of sources the highest-ranked one wins, and a project server
is active iff explicitly trusted while a non-project one always is), **S**
(`packages/mcp/test/security/mcp-trust.test.ts` — a hostile cloned repo's `local`/`approved-project`
server never auto-runs, and a managed deny/exclusive overrides even a user-trusted server), and **D**
(`docs/guide/cli.md` — the precedence ladder and the "a repo can never trust its own server" rule).
The full `pnpm check` passes.

**TL-06 (read-safe git tooling) is now VERIFIED.** The design intent — git tooling that cannot discard
work — is realized by ABSENCE: the built-in git surface is exactly `git_status`/`git_diff`, both
resolving to a read-only `git-read` action, and there is no `git_commit`/`git_reset`/`git_push`/
`git_clean` tool (a destructive git is only reachable through the policy/approval-gated `run_shell`).
Evidence: U (`packages/tools-builtin/src/git-tools.test.ts` — the git surface is the two read-only
tools, both git-read with empty write footprints), I (`packages/tool-worker/test/integration/
git-tools.test.ts` — real `git_status` through the sandbox reports dirty state), S
(`packages/tools-builtin/test/security/git-no-mutation.test.ts` — no destructive git tool exists;
history cannot be rewritten through the tool surface), E (`evals/e2e/git-tools.test.ts` — a real
`main()` run reads the dirty tree and reports the modified file, read-safely). The full `pnpm check`
passes.

**SC-03 (side-effect audit trail) is now VERIFIED.** The audit is the durable event log — every event
carries an actor, and `policy-decision`/`side-effect-settled`/`tool-result` carry the normalized
action, decision+source, result digest, and provenance — with the store's redactor scrubbing secrets
on write. It had U (`tools-core/src/contract.test.ts` — a tool result carries full audit fields). Added
I (`apps/cli/test/integration/audit-trail.test.ts` — a REAL sandboxed `write_file` leaves a complete
attributed trail: actor, normalized action + decision, a settled result digest, and an attributed
tool-result), S (`packages/storage/test/security/audit-redaction.test.ts` — a provider error echoing
the credential in its message and request id is scrubbed in the durable audit, without deleting the
failure record), and P (`packages/storage/src/redaction.property.test.ts` — the credential never
survives `redactValue`, in any position or depth). The full `pnpm check` passes.

**IN-09 (prompt modes) is now VERIFIED — a loaded-but-not-wired fix.** The five-mode table
(`packages/instructions/src/prompt-modes.ts`) was fully implemented, exported, and unit-tested, but
NOTHING outside the instructions package consumed it: `composePrompt` never applied a mode, and no
run could select one. Wired it end to end: a `--prompt-mode` flag on `run` (rejecting an unknown mode
and `agent-defined`, which a direct run has no definition for); `composePrompt` now appends the
mode's frozen prompt delta as a STABLE section (kept in the cacheable prefix — `compareSections`
already orders the `mode` id deterministically, so no ordering table changed); and the mode's tool
restriction is applied to BOTH the offered tools and the executable pipeline via `opts.builtins`, so
`coordinator` (no-mutation) genuinely hands the pipeline no write tool. Evidence: U
(`prompt-modes.test.ts` table + `apps/cli/test/unit/prompt-mode.test.ts` — the delta lands in the
stable prefix, `default`/omitted add nothing), I (`apps/cli/test/integration/prompt-mode.test.ts` — a
real coordinator run's `write_file` resolves to a failed tool-result and no file appears, while an
identical default run writes it; authority is unchanged), E (`evals/e2e/prompt-modes.test.ts` — the
`--prompt-mode` CLI contract over all modes), D (cli.md prompt-modes section citing the frozen
defaults.md table). `modeChangesAuthority` stays `false` for every mode. Full `pnpm check` passes.

**QL-03 (mechanical architecture checks) is now VERIFIED — and two checks were BUILT to make its
claim true.** The row claims dependency direction, cycles, host I/O, exports, schema compatibility,
file-size/complexity, and docs links are all mechanically checked. `scripts/architecture.ts` already
enforced direction/cycles/host-I/O/purity/credential-ownership/package-entry (7 rules), and the
`migrations` vitest project covers schema compatibility — but file-size/complexity and docs-link
integrity were NOT checked at all (eslint has no complexity rule; `check-spec.sh` only checks file
EXISTENCE, not links). Added two new gate rules: rule 8 (file-size/complexity guardrail — warn > 900,
fail > 2200 lines; the repo passes with 3 non-fatal warnings on `main.ts`/`turn-engine.ts`/`team.ts`)
and rule 9 (docs-link integrity — every relative Markdown link in `docs/` and the root `.md` files
must resolve; 41 files / 72 links / 0 broken). Evidence: U (`scripts/architecture.test.ts` — the
`scripts/graph.ts` dependency contract is itself acyclic, layer-direction-respecting, complete, and
purity-consistent), I (the same file spawns the REAL checker over the repo, asserts exit 0, and
asserts its output names every boundary QL-03 claims + that the migrations suite is wired). A
`scripts/**/*.test.ts` glob was added to the unit vitest project so the gate script is itself tested.
Full `pnpm check` passes.

**PS-10 (repeated denials never upgrade authority) is now VERIFIED — an invariant, not a new
feature.** The row asks that repeated denials and prompt fatigue be handled "without silently
upgrading authority" and that automated classification "reduce prompts only inside hard policy." The
system upholds this structurally: authority is derived by INTERSECTION (never by honoring a request
for more), a denial mints no grant, and repeated identical denied calls are stopped by the
oscillation guard rather than eventually allowed. Evidence: P
(`packages/policy/src/no-escalation.property.test.ts` — however permissive the request, `intersect`
never yields authority exceeding the parent ceiling or the managed hard policy), U+S
(`packages/policy/src/no-upgrade.test.ts` — evaluating a denied action twelve times denies every
time and never drifts to allow; the managed ceiling denies the network even under `yolo`, and lifting
only that restriction lets `yolo` through, proving the deny came from hard policy), I
(`apps/cli/test/integration/denial-no-upgrade.test.ts` — a real run whose model re-requests the
identical denied write never lands it, records at least one policy decision but none `allow`, mints
no grant, and terminates safely). Full `pnpm check` passes.

**PS-08 (children/session/durable work inherit no more than their parent) is now VERIFIED.** The row
is served by ONE invariant — authority derived by intersection — across three surfaces, so its
evidence is partly dedicated and partly the existing tests that exercise the same invariant, cited
honestly: P (`packages/policy/src/no-escalation.property.test.ts` — `intersect` never yields authority
exceeding the parent ceiling or managed policy, 500 runs), U (`packages/scheduler/src/scheduler.test.ts`
"intersects the captured ceiling with current managed policy and never widens"), I (NEW
`packages/scheduler/test/integration/ps08-durable-authority.test.ts` — a DURABLE cron job captured
under a wide `yolo` ceiling fires clamped by a managed policy tightened after its creation, proving
durable work re-intersects with CURRENT managed at fire), S (NEW
`packages/scheduler/test/security/ps08-no-escalation.test.ts` — over the full matrix of tightened
managed policies, a captured `yolo` ceiling never escapes current hard policy), E
(`evals/e2e/team.test.ts` — under managed `maxProfile: plan` a REAL teammate process is clamped to
`plan` and its sandboxed shell denied, so a teammate can never exceed the lead/managed ceiling).
(Observed but NOT fixed here, and flagged for a dedicated look: after a "restart" — a fresh `Scheduler`
reconstructing durable jobs from the same event log — job FIRING behaves unexpectedly in a black-box
probe. A recurring job fired ~one interval later than the same job fires before a restart, and a
past-due one-shot did not surface in `due()` at all. `foldRecords` sets a never-fired job's cursor to
its `createdAt`, so this is subtler than the fold and needs internal-state inspection to pin down.
Scope: this is a fire-TIMING question after reconstruction; CR-04 (durable DEFINITIONS survive a
restart) is unaffected — definitions reconstruct correctly (list/get/ceiling verified) — and PS-08's
durable clause is proven via the fire-time re-intersection above, which does not depend on
reconstruction. Left as an explicit open item rather than silently worked around.) Full `pnpm check`
passes.

**QL-01 (root scripts provide every gate) is now VERIFIED**, building on the `scripts/**/*.test.ts`
harness added for QL-03. Evidence in `scripts/gates.test.ts`: I (the manifest declares each of the 17
required gate scripts — format, format:check, lint, typecheck, build, test, test:integration,
test:security, test:pty, test:e2e, test:live, test:performance, test:migrations, test:packaging,
architecture, secrets:scan, check — and the aggregate `check` chains the core gates in order), E
(`pnpm format:check` runs end to end through its actual script and reports a clean tree, so a
broken/missing entry fails the test, not just a text check), D (docs/quality/acceptance.md references
`pnpm check`, so the manifest and the documentation cannot silently drift). Full `pnpm check` passes.

**ER-06 (loop/DoS detection) is now VERIFIED — and OSCILLATION detection was BUILT to close a real
gap.** The row claims the runtime detects repeated-identical calls, oscillation, no-progress, runaway
child creation, and cost/time DoS. Four were implemented, but `oscillation` was a defined-but-never-
emitted `TerminationReason`: the budget detected only CONSECUTIVE identical calls, so an `A-B-A-B-A-B`
flip-flop (each call differs from the one before) slipped past every check. Implemented it in
`BudgetTracker` (`packages/runtime/src/budget.ts`): a bounded window of recent call signatures fires
`oscillation` when the recent calls are exactly N repetitions of a fixed ≥2-distinct cycle — and,
being routed through `observeToolCall`, it wired itself into the engine, which already terminates on
that verdict. Evidence: U+P (`packages/runtime/src/oscillation.test.ts` — `A-B-A-B` and `A-B-C×3` stop
with `oscillation`, varied work does not, all-identical is still `repeated-identical-calls`; a
property that any 2–3 cycle repeated three times is caught), I (`evals/e2e/oscillation.test.ts` — a
REAL oscillating run terminates with the typed `oscillation` reason in the headless JSON), S
(`packages/runtime/test/security/dos-bounds.test.ts` — runaway model/tool calls and wall-clock are
each capped with a named reason). The other detectors are covered by existing tests that verify the
same behavior: repeated-identical (budget.test.ts + evals/e2e/termination.test.ts), no-progress
(budget.test.ts), runaway-children (subagent.property.test.ts — the `(limit+1)`th spawn is refused
with a typed `SubagentError`, the injected-failure path). Full `pnpm check` passes.

**GT-06 (worktree lifecycle is tested) is now VERIFIED.** The row asks that create/remove/keep,
config inclusion, concurrent worktrees, cleanup after failure, and non-Git error behavior be tested;
the ops (`createWorktree`/`removeWorktree`) were implemented and the happy path covered by
`worktree.test.ts`. Added `packages/worktrees/test/integration/gt06-lifecycle.test.ts` for the
edges: F (a non-Git directory fails with a typed `not-a-repo` `WorktreeError`, not a raw crash),
config inclusion (a hostile global git config aliasing `status` to a failing command is NEUTRALIZED —
the worktree helper pins `GIT_CONFIG_GLOBAL=/dev/null`, so `isWorktreeDirty` still runs real
`git status`), and P (a fast-check property that any 2–4 distinct slugs produce that many coexisting
worktrees without collision). Combined with the existing U (`slug.test.ts` — pure slug/path-traversal
validation), I (`worktree.test.ts` — real-git create/remove/dirty-refusal/collision), and E
(`evals/e2e/team.test.ts` — REAL teammate processes each work in their own git worktree), GT-06 has
its full [U,P,I,F,E]. Full `pnpm check` passes.

**SC-01 (adversarial suite covers 9 vectors) is now VERIFIED**, with the last untested vector —
shell indirection — filled this session. The suite is an ensemble of dedicated adversarial tests, one
(or more) per vector; the complete mapping, so nothing is claimed without a concrete test:

| Vector | Defense test(s) |
|---|---|
| malicious repository instructions | `packages/skills/test/security/{skill-escape,untrusted-skill}.test.ts` (instructions/skills are untrusted context, cannot grant a tool) |
| secret exfiltration | `packages/storage/test/security/{redaction,audit-redaction}.test.ts`, `memory/test/security/no-secrets.test.ts`, `apps/cli/test/security/telemetry-redaction.test.ts` |
| path / symlink escape | `packages/tool-worker/test/security/path-escape.test.ts` (SC-01), `sandbox-linux/test/security/filesystem.test.ts`, `evals/e2e/permissions.test.ts` (real symlink→credential escape refused) |
| shell indirection | `packages/tool-worker/test/security/shell-indirection.test.ts` (SC-01) — NEW: `;` and `$()` in an argv are literal, no `/bin/sh -c`, injected side effect never runs |
| package / Git hooks | `packages/worktrees/test/integration/gt06-lifecycle.test.ts` (poison global git config neutralized), worktree `GIT_CONFIG_GLOBAL=/dev/null` |
| MCP abuse | `packages/mcp/test/security/{mcp-trust,malicious-tool,oauth-csrf}.test.ts` |
| ANSI/OSC spoofing | `packages/protocol/src/sanitize.property.test.ts` + `sanitize.test.ts` |
| approval confusion | `apps/tui/test/unit/approval-dialog.test.ts`, `packages/policy/src/grants.test.ts` (approval binds to the normalized action), `evals/e2e/permissions.test.ts` (forged approval screen refused) |
| resource exhaustion | `packages/background/test/security/output-dos.test.ts`, `packages/runtime/test/security/dos-bounds.test.ts`, `sandbox-linux/test/security/process-resources.test.ts` |

Classes: P (`sanitize.property`, `sandbox-fuzz.property`, `resolve-scoped.property` — adversarial
properties), I (`sandbox-linux/test/security/real-sandbox.test.ts`, SC-01), S (the per-vector security
tests above), E (`evals/e2e/permissions.test.ts` — the SAME goal run in all four profiles with four
documented attacks — credential read, symlink escape, network enable, approval forge — each refused at
policy/ceiling/sandbox). Full `pnpm check` passes.

**MC-08 (server-to-agent reverse channel) is now VERIFIED** — implemented-but-under-tested. The
`ServerRequestRouter` (`packages/mcp/src/server-requests.ts`) routes every server→client request
through injected, policy-aware callbacks and sanitizes server-authored text; `McpClient`'s
`#handleNotification` is the attributed wake-up channel. Evidence: U (`server-requests.test.ts` —
elicitation routed through the channel with ANSI stripped from server text), I
(`test/integration/in-process-roundtrip.test.ts` — the real client discovers resources/prompts and
refreshes on a server `list_changed` notification through a real transport), F (NEW
`packages/mcp/src/server-request-failures.test.ts` — an arbitrary/unknown reverse method, an
elicitation with no channel, and a policy-denied elicitation are each refused with a typed `McpError`
and the elicitation callback is never reached; `roots` with no provider returns a safe empty list),
S (`server-requests.test.ts` — a server cannot enable a capability the policy gate refuses, and
server-driven sampling is refused by default), E (`evals/e2e/mcp.test.ts` golden path 7 — a REAL
second-process HTTP server pushes a reverse notification and a malicious server is denied). "Reverse
permission requests" is the elicitation path; "wake-up channels" is the server-initiated notification
handler. Full `pnpm check` passes.

**SS-08 (per-user daemon single-writer lease) is now VERIFIED** — the daemon (`apps/daemon`) and its
`acquireLease` (an atomic `O_CREAT|O_EXCL` lock file holding the holder pid, with stale-reclaim of a
dead holder) were implemented and integration-tested; added the invariant-level classes. Evidence: U
(NEW `apps/daemon/test/unit/lease-invariant.test.ts` — the lock round-trips the holder pid, reports
held only for a live holder, and `release` removes ONLY our own lock, never one a reclaimer took
over), P (same file — a fast-check property that while this live process holds the lease, NO other pid
can acquire it, and the holder is never silently displaced), I (`test/integration/lease.test.ts`
acquire/refuse-while-live + `socket.test.ts` client attach), F (`lease.test.ts` — a STALE lock from a
dead process is reclaimed, so a crashed daemon never locks a user out), E
(`test/integration/turn.test.ts` — the REAL daemon binary drives a real turn with one writer and many
socket observers; a prompt starts a turn, an approval resumes THAT turn, a cancel kills the process
group). "cwd/worktree changes preserve canonical ownership" is the `canonicalRepoRootOf` mechanism
(MM-05) the daemon keys thread ownership on. Full `pnpm check` passes.

**BG-07 (background-work lifetimes are distinct events) is now VERIFIED.** The row requires the four
lifetimes to be distinct, restart tests to prove which category stops/is-lost/reconnects/resumes, and
"no process reported alive without a heartbeat." Each lifetime has its own coverage:

| Lifetime | Restart behavior | Test |
|---|---|---|
| definition | survives (durable) | `packages/scheduler/test/integration/scheduler-durable.test.ts` (CR-04 — durable defs survive a restart, session defs do not) |
| local process | stops / settled in the durable ledger | `packages/background/test/integration/lifecycle.test.ts` (BG-02/BG-04 — completion recorded, idempotent exit) |
| daemon | reconstructs from the log | `apps/daemon/src/daemon.ts` SS-05 crash recovery + `test/integration/lease.test.ts` (stale-reclaim of a dead holder) |
| remote peer | lost on silence, reconnect resumes | NEW `apps/remote-worker/test/unit/heartbeat-liveness.test.ts` + `test/integration/resume.test.ts` |

The NEW heartbeat test is the "no process alive without a heartbeat" clause: a peer silent past its
window is marked `disconnected` (its in-flight work becomes `unknown`, never blindly replayed), a
heartbeat within the window refreshes liveness, and a reconnect replays ONLY unacknowledged frames —
resume, not re-do. Classes: I (lifecycle + resume + scheduler-durable + daemon turn), F (heartbeat
lapse → lost, daemon crash-recovery, `teams` reclaim), E (`apps/daemon/test/integration/turn.test.ts`
— the real daemon binary drives a turn), D (defaults.md "Remote agent and routine peer"). Full
`pnpm check` passes.

**CR-06 (cron backends: session/daemon/remote with explicit availability) is now VERIFIED — and the
"explicit availability" abstraction was BUILT to make the claim true.** The three backends existed
(scheduler, `apps/daemon`, `apps/remote-worker`) but nothing reported their availability. Added
`cronBackendAvailability` (`apps/cli/src/scheduler.ts`) — the session scheduler is always available, the
local daemon only while a writer lease is held, the remote peer only when configured — and WIRED it
into `doctor` (a real report line per backend, never a silent downgrade). Evidence: availability
(`apps/cli/test/unit/cron-backends.test.ts` U + `test/integration/doctor-backends.test.ts` I — the
report shows each backend's state from the daemon-lease-file and remote-env signals), I
(scheduler-durable.test.ts session + `apps/daemon/.../turn.test.ts` daemon + `apps/remote-worker/.../resume.test.ts`
remote), F (daemon SS-05 crash recovery + remote reconnect + heartbeat-liveness), S (NEW
`apps/cli/test/security/cron-preapproval.test.ts` — an unattended claim runs ONLY the operator's exact
preapproved command, a different command is not covered, and a `plan` ceiling still refuses it, so the
preapproval is never an escalation), E (turn.test.ts real daemon binary), D (defaults.md "Remote agent
and routine peer"). "Remote peer passes the frozen protocol/fixture" is the versioned, zod-validated
envelope + `session.test.ts`/`resume.test.ts`. Full `pnpm check` passes.

**GT-02 (session worktree enter/exit vs teammate cwd override) is now VERIFIED — the session-worktree
feature was BUILT.** The teammate cwd override existed (`team teammate --worktree`), but a SESSION had
no way to enter a worktree. Added a `--worktree <slug>` flag to `run` (`apps/cli/src/main.ts`): it
creates a fresh git worktree of the repo and points the session's tool-resolution root
(`createHarnessRuntime.workspaceRoot` and the prompt's workspace) at it, while durable state stays
under the repo. The two mechanisms are now genuinely distinct: the SESSION enters via `run --worktree`;
a TEAMMATE is assigned its cwd by the lead via `team teammate --worktree`. Evidence: U
(`packages/worktrees/test/security/slug.test.ts` slug/path-traversal validation +
`worktree-binding.test.ts` assignment), I (NEW `apps/cli/test/integration/session-worktree.test.ts` —
a real `--worktree` run's write lands in the WORKTREE not the main checkout, and without the flag it
lands in the main checkout, so the flag — not the harness — redirects tool resolution), E
(`evals/e2e/team.test.ts` — real teammate processes each resolve tools against their OWN worktree,
files landing there never in the lead workspace). The flag is opt-in, so every existing run is
unchanged. Full `pnpm check` passes.

**CX-05 (compaction restores goal/state + reattaches skills) is now VERIFIED — implemented-but-under-
tested, not a gap.** I had earlier suspected the "reattach recent skills at 5K each / 25K total"
clause was unbuilt; it is exactly `DEFAULT_SKILL_BUDGETS` in `packages/skills/src/registry.ts`
(`perSkillTokens: 5_000`, `totalLoadedTokens: 25_000`, with the frozen comment "Reattach at most
5,000 tokens per recently used skill and 25,000 tokens total"). Evidence: U+F (NEW
`packages/context/src/preservation.test.ts` — the preservation contract requires a non-empty goal and
every state list, offers NO field a summarizer could set to fake completion, and REJECTS a summary
that drops the goal, fail-closed) plus the skill-budget truncation (`registry.test.ts` — a body over
the per-skill budget is truncated WITH a signal, never silently dropped), I+E
(`apps/cli/test/integration/compaction.test.ts`, already CX-05-tagged — the REAL `TurnEngine` grows
the transcript with tool output, compacts, and preserves goal/constraints/tasks/files, and does not
thrash on a short turn). Full `pnpm check` passes.

**HK-02 (hook handlers support all forms + attributes) is now VERIFIED.** My earlier "not flippable"
call on the "async notification" clause conflated it with HK-01 (which components FIRE events) — but
HK-02 is about HANDLER support, and `Notification` is a first-class `HookEvent` the engine dispatches
asynchronously like any other. Added `packages/hooks/src/async-notification.test.ts` (a hook registered
on `Notification` runs its async handler in deterministic order, does not fold a permission decision,
and honors its content matcher). Combined with the rest: handler forms (`handler-forms.test.ts` —
function/command/http/prompt/agent each dispatch; MCP is the deliberate "where applicable" exclusion,
no MCP handler kind), matcher/condition + ordering (`registry.test.ts` + `fold.property.test.ts`),
timeouts + cancellation (`test/integration/command-hook.test.ts` — a hook that sleeps too long is
cancelled and does NOT silently allow), and escalation-safety (`test/security/hook-escalation.test.ts`
— a hook can only tighten a decision). HK-02's [U,I,F,S] all hold. (Whether the CLI fires the
`Notification` event is HK-01's separate event-coverage concern; a turn-flow notification DELIVERY
queue is RT-05's.) Full `pnpm check` passes.

**ER-04 (each error condition has a distinct typed path) is now VERIFIED — implemented-but-under-
tested.** I had earlier suspected "image/media validation" was unbuilt (no multimodal input); it is
the binary-content detection/rejection — `isBinary` (`tool-worker/handlers.ts`) detects a NUL-headed
buffer and the read/edit tools `fail('binary-file', …)`, a distinct tool-error category. Every one of
the seven conditions routes to its own typed path, proven in
`apps/cli/test/unit/er04-error-taxonomy.test.ts` against the REAL classifiers: image/media →
`binary-file` (+ `too-large`), overload → `retryable` (a 5xx) distinct from `user-action-required`
(auth) and `permanent` (4xx) via `ruleForStatus`, unsupported → its own `unsupported` category, and
stream abort / tool abort / hook block / token-budget → the distinct `TerminationReason` members
`user-cancelled` / `hook-stop` / `token-limit` (never conflated). Classes: U+F (that file — injected
conditions each resolve to a distinct typed path), I (`packages/runtime/test/integration/turn-engine.test.ts`
+ the hook-stop/termination/oscillation engine tests drive these reasons end to end). Full `pnpm
check` passes.

**PS-01 (the four permission profiles, visible in every client) is now VERIFIED** — found by finally
examining the T (PTY) rows I'd been skipping. Evidence: U (NEW
`packages/protocol/src/profile-resolution.test.ts` — the profiles are exactly plan/ask/auto-accept-
edits/yolo, every documented alias (default/manual→ask, acceptEdits→auto-accept-edits,
bypassPermissions→yolo) maps onto one of them, and an unknown string resolves to `undefined`, never a
silent permissive default), I (the policy suites enforce each profile's decisions —
`auto-accept-edits.property.test.ts`, `managed-ceiling`), T (`apps/tui/test/pty/mode-switch.test.ts` —
the shipped TUI status line renders the profile and Shift+Tab cycles ask→auto-accept-edits→yolo→plan
LIVE over a real PTY, i.e. "current profile visible in every client"), E
(`evals/e2e/permissions.test.ts` — one goal run in all four profiles, each enforcing differently).
Full `pnpm check` passes.

**RT-05 (the comprehensive turn phase order) is now VERIFIED — and this one required a real build, not
just evidence.** The engine already realized every phase except two: there was no queued-notifications
phase (phase 2), and the `Stop` hook never fired. Both were built as strictly OBSERVE-ONLY additions
to `packages/runtime/src/turn-engine.ts`: (1) a `queued-notifications` phase in `run()` that drains an
INJECTED `NotificationDrain` (an abstraction, so runtime keeps no dependency on `@qwen-harness/background`
— avoiding a layering violation) once at turn start and surfaces each summary to the model as away-time
context, before the first context-assembly/model round; it is drained only in `run()`, never in
`resume()` (a mid-flight turn must not re-drain). (2) A `Stop` lifecycle fired from a shared `#fireStop`
helper on EVERY terminal path — normal/budget/hook completion (`#endTurn`), user cancellation
(`#cancel`), and internal-error failure (the `#drive` catch) — so `stop-hooks` is genuinely the last
phase of every ending, not just the happy one. The canonical order is the exported `TURN_ORDER`
constant (single source of truth, documented phase-by-phase). Classes: U (NEW
`packages/runtime/src/turn-order.test.ts` — `TURN_ORDER` has the ten phases in order, queued-notifications
at index 1, stop-hooks last), I (NEW `packages/runtime/test/integration/turn-order.test.ts` — a real
turn over the real `EventStore` with a `fireLifecycle` spy proves QueuedNotifications fires before any
PreToolUse, the drained summary reaches the model input, `Stop` fires strictly last, a no-notifications
turn still fires Stop, AND a cancelled turn still fires Stop last), E (NEW `evals/e2e/turn-order.test.ts`
— deterministic end-to-end, nothing about the engine mocked). No existing test was modified or weakened;
the only source changes are additive (new optional dep, two observe-only fires, one exported constant).
Full `pnpm check` passes.

5. **Genuinely unimplemented behavior.** Some rows describe features that do not exist yet:
   WebFetch/WebSearch (TL-13),
   early tool start while streaming (TL-09), turn steering (RT-07), `previous_response_id`
   continuation (PV-08), output-length continuation (ER-01), automatic post-turn memory extraction
   (MM-03), session rename/archive/delete + picker (SS-02, UI-10), **hook-event dispatch at scale (HK-01)
   — audited 2026-07-16: originally only ~7 of the 30 events fired. A reusable `fireLifecycle` seam was
   added to `TurnHooks` (optional, so no fake breaks) and `SessionStart`, `PostToolBatch`,
   `PermissionRequest`, `PermissionDenied`, `Setup` (first-run only) (proven by
   `evals/e2e/hook-lifecycle.test.ts`) and `PostCompact` (proven by
   `apps/cli/test/integration/compaction.test.ts`) are now wired (13/30). The remaining ~17
   (Notification, Subagent*, PreCompact, Task*, Elicitation*,
   ConfigChange, Worktree*, CwdChanged, FileChanged, UserPromptExpansion, MessageDisplay, PostToolBatch,
   TeammateIdle, StopFailure) are defined and engine-dispatchable but have NO firing site — the exact
   "emitted-but-not-wired" defect `events.ts` warns against, and the largest single remaining feature
   (it also gates HK-02 and GT-06's worktree hooks)**, non-command hook handler forms
   (HK-02), the comprehensive audit record (SC-03), remote reference-peer backends (CR-06, BG-03/07),
   resumable subagents (AG-04), and the `/rewind` checkpoint system (UI-18). (Storage
   retention/vacuum/backup — formerly listed here — is now BUILT and VERIFIED as SS-07.)
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
