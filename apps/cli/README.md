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

Exit codes: 0 success, 1 usage error, 2 runtime failure, 3 blocked / missing credential.

## Proven

- **Deterministic** (`test/integration/cli-run.test.ts`): a scripted model drives read → edit → run
  the test through the REAL sandbox; the fix lands on disk and the test passes. Reproducible, no
  terminal, no live latency.
- **Live**: `qwen3.7-max` completed the same task through the harness — read the file, fixed the bug
  with `edit_file`, ran the test with `run_shell` in the bubblewrap sandbox, saw PASS, and reported
  `state: completed`. Independent verification confirmed the test passes.

## Known scope

This CLI is the one-shot composition root. The per-user supervisor daemon, the Unix-socket protocol,
session resume/fork/export in the CLI surface, and the Ink TUI are checkpoint-04+ work. State is
written under `.qwen-harness/sessions.sqlite` in the workspace so a run is self-contained and
inspectable.
