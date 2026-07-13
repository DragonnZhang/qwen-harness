# @qwen-harness/cli

The headless composition root. It wires the real provider, sandbox, storage, config, and tool
pipeline into a runnable harness and exposes them as commands.

Apps are the only place allowed to touch every I/O owner at once — every package below reached this
point through its own boundary, and this is where the injected interfaces the runtime speaks become
the concrete DashScope adapter, the bubblewrap sandbox, and the SQLite event store.

It is deliberately **headless** (text / `--json`, stable exit codes): CI and integrations must never
depend on terminal rendering (UI-15). The Ink TUI is a separate client of the same runtime.

## Commands

- `qwen-harness doctor` — reports platform, sandbox availability (with probes), config values and
  their provenance, and whether the credential env var is present. It never reads or prints the
  key's value.
- `qwen-harness run <prompt>` — runs one turn in the current workspace against the model and prints
  the result. `--profile <plan|ask|auto-accept-edits|yolo>`, `--model <name>`, `--json`.

- `qwen-harness resume <id> [prompt]` — continues a session. With **no prompt**, it answers a pending
  approval and finishes the SAME turn.

Exit codes: 0 success, 1 usage error, 2 runtime failure, 3 blocked / missing credential / **a turn
left awaiting an approval nobody could answer**.

## Approvals pause and resume a live turn

When policy says `ask`, the turn does not fail and it does not restart. It moves to
`awaiting-approval`, the request is written to the durable log **before** anyone is asked, and the
prompt shows the exact normalized action policy judged (sanitized, so a tool argument cannot forge a
dialog). Answering resumes the **same turn** into `executing` — an approval is never a new user
message. A refusal is fed back to the model in band, paired to its own call id, so it can adapt.

If there is no one to ask — `--json`, a closed stdin, a killed process — nothing is auto-approved and
nothing is discarded. The turn stays parked in `awaiting-approval`, and `resume <id>` picks it up:
same turn id, no second `turn-started`. A `once` approval authorizes exactly one execution of exactly
that action; an identical call asks again.

## Proven

- **Deterministic** (`test/integration/cli-run.test.ts`): a scripted model drives read → edit → run
  the test through the REAL sandbox; the fix lands on disk and the test passes. Reproducible, no
  terminal, no live latency.
- **Live**: `qwen3.7-max` completed the same task through the harness — read the file, fixed the bug
  with `edit_file`, ran the test with `run_shell` in the bubblewrap sandbox, saw PASS, and reported
  `state: completed`. Independent verification confirmed the test passes.

- **Approvals** (`test/integration/approvals.test.ts`): against the REAL policy engine and the REAL
  sandbox — an approval resumes the same turn (one `turn-started`, `awaiting-approval -> executing`),
  a denial reaches the model in band, no channel parks the turn, and a `once` grant is spent on use.
- **Crash-safe approvals** (`test/integration/approval-resume.test.ts`): process A is **SIGKILLed**
  while the prompt is on screen; a genuinely separate process B resumes the session, answers `y`, and
  the same turn (same turn id) completes and the tool runs. The only thing crossing the gap is the
  event log.

## Known scope

This CLI is the composition root — `apps/daemon` reuses `createHarnessRuntime` rather than forking
it. `session`-scoped grants live for the process: a new process asks again, because a lost grant
costs a prompt while a resurrected one would cost an unapproved side effect. The Ink TUI is separate
work. State is
written under `.qwen-harness/sessions.sqlite` in the workspace so a run is self-contained and
inspectable.
