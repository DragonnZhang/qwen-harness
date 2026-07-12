# Autonomous implementation protocol

This protocol turns one `/goal implement @task.md` invocation into a resumable engineering program. A single user entry does not mean a single generation, one giant patch, or unverified breadth.

## 1. Persistent control files

The implementing agent creates and maintains:

- `docs/execution/active-plan.md` - current checkpoint, ordered steps, commands, failures, and next action;
- `docs/execution/checkpoints/<NN>-<name>.md` - immutable checkpoint evidence after completion;
- `docs/execution/blocked.md` - only real external blockers, with exact reproduction and remediation;
- `docs/decisions/` - ADRs for decisions that change architecture, compatibility, security, or acceptance;
- `docs/product/capability-matrix.md` - current implementation/evidence status.

The active plan must survive context compaction and agent replacement. Do not rely on chat history as project state.

## 2. Checkpoint transaction

For each checkpoint:

1. Inspect repository, current branch, dirty state, active plan, matrix, previous evidence, and environment drift.
2. State the vertical outcome and exact acceptance commands before writing implementation.
3. Add or strengthen tests that fail for the missing behavior.
4. Implement the smallest coherent vertical slice across protocol, runtime, adapter, interface, docs, and observability.
5. Run focused tests continuously; repair root causes rather than adding retries or skips.
6. Run the checkpoint gate and applicable security/failure cases.
7. Exercise the user-visible path, not only internal APIs.
8. Inspect the complete diff and generated files for secrets, placeholders, unrelated changes, and architecture violations.
9. Update matrix rows and evidence links/commands.
10. Write the checkpoint record and update the active plan to the next checkpoint.
11. Create a local Git commit named `checkpoint NN: <outcome>`.

Never force-push, rewrite user commits, delete unrelated work, or push externally unless the execution environment explicitly authorizes it.

## 3. Environment capture

Checkpoint 0 records at least:

```sh
cat /etc/os-release
uname -a
uname -m
getconf LONG_BIT
printf '%s\n' "$SHELL" "$TERM" "$COLORTERM"
node --version
corepack --version
pnpm --version
git --version
command -v bwrap || true
command -v docker || true
command -v podman || true
command -v tmux || true
```

Also record cgroup/user-namespace availability, outbound network policy, filesystem type, available disk/memory/CPU, noninteractive shell behavior, TTY behavior, and whether the runner may install system packages. Never record environment variable values or full process environments.

## 4. Implementation checkpoints

### 00 - Preflight and contract probes

- Fail fast if the execution host is not Linux.
- Capture target Linux environment and toolchain.
- Confirm Git baseline and secret scanning.
- Create a minimal disposable pnpm/TypeScript probe workspace and lockfile before running Node/Ink provider probes; this is probe infrastructure, not product scaffolding.
- Probe DashScope Responses and Chat streaming with a safe request when `DASHSCOPE_API_KEY` exists.
- Capture redacted text, reasoning-summary, usage, tool-call, error, and request-ID fixtures.
- Probe real sandbox backends and choose one through an ADR.
- Run an Ink spike for transcript, stream, diff, input, resize, signals, and PTY restoration.
- Freeze exact Node active LTS, pnpm, TypeScript, Ink/React, SQLite, test, schema, and build versions.

Gate: host, toolchain, sandbox candidate, storage candidate, and TUI dependency are proven on the actual host. If the key is absent, mark the separate live-evidence lane `LIVE_BLOCKED` and continue deterministic work; missing credentials do not block deterministic checkpoints. No product breadth begins on an unproven deterministic foundation.

### 01 - Workspace, protocol, storage, and testkit

- Create pnpm workspace and target package structure.
- Establish format/lint/type/build/test/architecture commands and CI.
- Implement versioned Thread/Turn/Item/Event schemas and command protocol.
- Implement SQLite WAL event store, projection rebuild, migrations, JSONL export/replay, redaction, and failure injection.
- Implement deterministic fake provider, fake tools, clock, IDs, storage, and fixture repositories.

Gate: state-machine and crash-boundary tests can replay a complete fake turn identically.

### 02 - Safe vertical loop: worker, policy, sandbox, provider, and tools

- Implement deny-by-default policy core, capability-scoped tool-worker RPC, and a real Linux sandbox worker before enabling any model-initiated host write or process.
- Implement provider-core and DashScope Responses/Chat adapters.
- Implement explicit turn state machine, stream normalization, budgets, cancellation, and basic recovery.
- Implement registry and safe list/glob/search/read/write/edit/apply-patch/shell/Git tools inside the sandbox worker.
- Complete the deterministic minimal coding loop. When the live lane is available, complete the same loop with the real model only after sandbox attack tests pass.

Gate: the fake model edits a disposable fixture, runs tests, and returns a durable result through the deny-by-default policy and real sandbox worker; file and shell attacks cannot escape. The equivalent real-model result is recorded in the live lane and remains mandatory for final completion.

### 03 - Policy, Linux sandbox, approvals, and hooks

- Implement layered config provenance and four permission profiles.
- Route every model-initiated host side effect through policy and its controlled executor. Provider, storage, daemon socket, and telemetry retain only their declared adapter boundaries.
- Expand Linux isolation, audit, authority ceilings, protected paths, and exact approval grants.
- Implement the hook engine, typed outcomes, and every event owned by domains available through checkpoint 03. Later domain checkpoints add their own real emissions.

Gate: all four modes pass normal and adversarial foundational-tool fixtures; no currently available hook or tool path bypasses isolation. Do not claim MCP/child/domain hook coverage before those domains exist.

### 04 - Sessions, recovery, CLI, and TUI vertical slice

- Implement thread lifecycle, resume/fork/export, crash-safe side-effect states, and compaction-ready persistence.
- Implement headless JSON CLI and Ink TUI projections/editor.
- Add streaming transcript, tools, diff, approvals, modes, status, cancellation, and session picker.
- Pass PTY, SSH, signal, resize, Unicode, performance, and restoration tests.

Gate: a user completes and resumes the golden coding task over a real PTY.

### 05 - Instructions, skills, prompt, context, memory, and recovery

- Implement layered repository guidance and deterministic prompt sections/cache.
- Implement skill discovery, progressive loading, fork/inline semantics, and supporting assets.
- Implement output offload, prune, proactive/reactive compaction, circuit breakers, and context UI.
- Implement memory retrieval/extraction/consolidation/Dream with provenance and locks.
- Finish provider/tool/context recovery and no-progress detection.

Gate: a long-context task compacts and resumes without losing goal, policy, task, file, or agent state.

### 06 - Todo, task graph, background, Cron, and worktrees

- Implement todo compatibility and durable task FSM/dependencies/claiming.
- Implement the unified background lifecycle and the categories whose owners now exist: local shell, local workflow, and Dream/consolidation. Do not create no-op agent/teammate/MCP categories.
- Implement parser/scheduler/session/durable Cron and supervisor behavior.
- Implement safe Git worktree lifecycle, ownership, hooks, and recovery.

Gate: scheduled/background work completes in an isolated worktree, survives supported restart boundaries, and updates the task graph once.

### 07 - Subagents, teams, protocols, and autonomy

- Implement one-shot and resumable subagent modes.
- Implement team config, inbox, protocol FSMs, plan/permission/shutdown flows, task assignment, and UI.
- Implement autonomous idle/claim/work lifecycle, heartbeats, failure recovery, and compaction identity.

Gate: concurrent teammates claim dependent tasks without collision, work in isolated worktrees, report results, and shut down cleanly.

Add and verify local-agent, remote-agent, and in-process-teammate background categories here.

### 08 - MCP and external extension

- Implement transports, discovery, invocation, dynamic refresh, lifecycle, and configuration precedence.
- Implement OAuth/PKCE fixture issuer and secure storage.
- Implement reverse notifications, elicitation, resources/prompts, lazy tool schemas, output limits, and child inheritance.
- Route every MCP action through existing policy/hook/sandbox/audit infrastructure.
- Add and verify MCP-monitor background work here.

Gate: local stdio and HTTP servers plus malicious fixtures pass end-to-end tests.

### 09 - Product completeness and release hardening

- Finish every TUI/headless command and capability panel.
- Run architecture, security, reliability, migration, performance, packaging, clean-install, and support-bundle work.
- Add full documentation, tutorials, configuration reference, troubleshooting, and operator guides.
- Resolve every matrix row; no critical blocked or unverified behavior remains.
- Verify all 30 hook emissions and every background category together now that all owning domains exist.

Gate: `pnpm check` passes from a clean clone on the recorded host.

### 10 - Final integrated and live acceptance

- Run all ten golden paths in `docs/product/capability-matrix.md`.
- Run the full credentialed `qwen3.7-max` suite and inspect traces for secret leakage and duplicate side effects.
- Re-run from a fresh clone and package install.
- Review every requirement against code, tests, UI, docs, and evidence.
- Produce the final report with exact commands, durations, evidence, limitations, and commit IDs.

Gate: the definition of done in `task.md` and the matrix is satisfied without exceptions.

## 5. Deterministic and live evidence lanes

Checkpoint order is deterministic and may proceed without an API key. Live evidence is a parallel lane:

- `LIVE_AVAILABLE`: run the checkpoint's budgeted live smoke after its deterministic and safety gates.
- `LIVE_BLOCKED`: record missing credential/service once, continue deterministic checkpoints, and never print or persist the key.
- `LIVE_FAILED`: preserve request IDs and redacted diagnostics, classify the failure, repair product defects, and retry only when safe.
- `LIVE_VERIFIED`: record exact command, model, endpoint class, capability fixture, usage, trace identity, and checkpoint commit.

The final goal cannot complete until every required `L` evidence row and the integrated live suite are `LIVE_VERIFIED`. A missing key must never force unsafe early execution or prevent unrelated deterministic engineering.

## 6. Autonomy rules

The implementing agent is authorized to make normal in-repository engineering decisions, add dependencies, run tests, install project packages, create local branches/commits, and repair failures. It should not stop for naming, formatting, internal library, or ordinary architectural questions when the specification gives enough direction; choose the most maintainable option and record a material choice as an ADR.

Stop only for a genuinely missing external credential/service, inability to install a required system dependency, an irreversible external action, conflicting authoritative requirements that change product scope, or danger to unrelated user data. Before stopping, exhaust safe diagnostics and alternatives and leave the repository reproducible.

## 7. Anti-shortcut rules

- No TODO, stub, empty handler, `throw new Error("not implemented")`, fake button, or interface-only completion for required behavior.
- No deleting or weakening tests, broad `any`, unsafe type assertion, swallowed error, arbitrary sleep, unbounded retry, or snapshot churn to hide a defect.
- No fixture that bypasses the same schema/policy/storage path used in production.
- No live-provider test replaced by a fake-provider claim.
- No sandbox claim based only on deny strings or path prefix checks.
- No documentation claim without a runnable command or UI path.
- No completion based on LOC, number of tools, or green unit tests alone.

## 8. Final report

The final autonomous response must lead with the usable outcome and include:

- target environment and build artifact;
- feature matrix summary and evidence locations;
- exact deterministic and live commands run with results;
- golden-path results;
- security/sandbox and recovery evidence;
- architecture constraint results;
- clean-install result;
- known non-critical limitations;
- checkpoint and final commit IDs.

If any required gate is not satisfied, the report must say the goal is incomplete and identify the blocking matrix rows.
