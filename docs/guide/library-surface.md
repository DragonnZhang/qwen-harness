# Library surface and current gaps

This page exists because the alternative is lying to you.

The repository contains 32 packages and applications. Most of the domain logic the specification
calls for is implemented, tested, and correct — MCP, memory, repository instructions, hooks,
subagents, teams, the task graph, background work, cron, worktrees, the network broker, telemetry,
context compaction, the secret store. **Almost none of it is reachable from a command.**

`apps/cli` is the only application with a real composition root. It wires: the DashScope provider,
the turn engine, the built-in tools, the policy engine, the sandboxed tool worker, and the event
store. Everything listed below is a workspace package that no application imports.

If you are a **user**: the features below do not exist for you yet. Use [the CLI](cli.md).

If you are an **operator**: do not build a control on top of any of them. See the explicit warnings
in the [operator guide](operations.md).

If you are **embedding the harness** as a library: they are real, they are tested, and the summaries
below tell you what you are getting.

## Not wired into any application

| Package | What it implements | Reachable? |
|---|---|---|
| `@qwen-harness/mcp` | full MCP client: JSON-RPC, stdio/HTTP/SSE/ide-sse transports, OAuth 2.0 + PKCE with constant-time state comparison, tool namespacing (`mcp__<server>__<tool>`), deferred schemas, result offload | **no** — and there is no MCP config *file*; servers are configured programmatically |
| `@qwen-harness/instructions` | `AGENTS.md` discovery and precedence (global → user → ancestor → repo-root → nested), path-scoped instructions, system-prompt composition with cache keys | **no** — the CLI hardcodes its system prompt as a string literal |
| `@qwen-harness/memory` | `MEMORY.md` index + topic files, four memory scopes, retrieval budgets, extraction that **rejects** any candidate containing a secret, and Dream consolidation with a lease | **no** — there is no `/memory` command |
| `@qwen-harness/hooks` | 30 hook events, five handler kinds, typed outcomes, a 30 s default timeout, a Stop re-entry guard, and the rule that a hook may restrict but **never** elevate | **no** — no hook config key exists, no event is ever emitted |
| `@qwen-harness/agents` | subagent supervisor: authority intersection, depth 2 / 4 active / 16 total limits, `authority-widened` refusal | **no** |
| `@qwen-harness/teams` | teammate loop, durable inbox, 15 protocol message types, incarnation recovery after runtime loss | **no** |
| `@qwen-harness/tasks` | turn-local todo list, and a durable task graph with a legal-transition table, cycle detection, and atomic claim | **no** |
| `@qwen-harness/background` | background job manager, notification priority queue with anti-starvation, 30 s input watchdog, output warn (10 MiB) and hard stop (5 GiB) | **no** — and no concrete process runner ships |
| `@qwen-harness/scheduler` | five-field cron with Vixie DOM/DOW-OR semantics, deterministic jitter, 50 jobs/owner, missed instants recorded but **never replayed** | **no** |
| `@qwen-harness/worktrees` | `git worktree` lifecycle under `<repo>/.qh-worktrees/<slug>` on branch `qh/<slug>`, refusing to remove a dirty or unmerged tree without `discard` | **no** |
| `@qwen-harness/network` | the outbound broker: scheme allowlist, host allow/deny, SSRF and metadata-endpoint guards, redirect re-checking, 5 MiB download cap | **no** — used only by `mcp`. The DashScope provider does its own `fetch` and does not route through it. |
| `@qwen-harness/telemetry` | tracer, spans, JSONL file sink, injected redaction | **no** — zero call sites anywhere |
| `@qwen-harness/context` | 15% response reserve, proactive compaction at 85% of the usable budget, pair-preserving reduction | **no** — no compaction ever runs; the turn engine has no compaction path |
| `@qwen-harness/secret-store` | libsecret → encrypted-file (0600, separate master key) → in-memory, refusing to persist OAuth tokens when neither secure option exists | **no** — used only by `mcp` |
| `@qwen-harness/skills` | `SKILL.md` discovery under `.qwen-harness/skills/`, two-level loading, symlink-escape defence — **under active construction as this was written** | **no** — no application imports it |

## Applications with no entry point

- **`apps/remote-worker`** declares `bin: qwen-harness-remote-worker`, but there is **no `bin.ts` and
  no `dist/bin.js`** — it cannot be launched. It contains the remote envelope schema, 15 message
  types, heartbeat (15 s) and disconnect (45 s) constants, and resume from the last acknowledged
  sequence, but **no transport is implemented**, so there is no second process to talk to.
- **`apps/tui`** builds and runs, but renders a scripted demo — no provider, no runtime, no storage.
  See [the TUI guide](tui.md).

`apps/daemon` **is** launchable (`--workspace`, `--socket`, `--lease`, `--state`, `--profile`,
`--model`) and runs the same composition as the CLI, with the single-writer lease and socket-mediated
approvals. See the [operator guide](operations.md#the-daemon). What it lacks is a *client*: nothing in
this repository attaches to the socket, so today the daemon is an operator-facing server with no
shipped consumer.

## Gaps inside the wired path

These are defects in code that *is* reachable, and they matter more than the unwired packages:

1. **The CLI does not consume configuration.** `run` and `resume` take the profile and model from
   flags and use built-in defaults for everything else. `model`, `baseUrl`, `reasoningEffort`,
   `transport`, `budgets.*`, `toolOutput.*`, and `telemetry.enabled` from a config file are reported
   by `doctor` and ignored by a run. See [Configuration](configuration.md#read-this-first-what-actually-consumes-configuration-today).
2. **The CLI does not load managed policy.** The policy engine is constructed with
   `NO_MANAGED_RESTRICTIONS` and an empty rule/grant list, so `/etc/qwen-harness/managed.json`
   constrains `doctor`'s report and not a run. The ceiling logic itself is correct and tested; it is
   simply not fed. See the [operator guide](operations.md#-the-gap-you-must-know-about).
3. **The TUI has no runtime.** The CLI and the daemon both have working approval channels; the TUI's
   `ApprovalDialog` is real, tested, and unreachable, because the shipped TUI binary renders a demo
   transcript instead of driving a turn.
4. **`yolo` still runs sandboxed.** The CLI maps `yolo` to `disabled` isolation and then passes
   `workspace-write` to the worker anyway. The practical effect is safer than advertised, but the
   advertised and actual behavior differ, and that is worth knowing before you rely on either.
5. **Interrupted side effects are never promoted.** `recoverInterrupted()` and `listIndeterminate()`
   exist in storage and are called by nothing. `in-flight` rows are refused by `mayExecute` exactly as
   `indeterminate` rows are, so the *safety* property holds — but there is no way to list or clear
   them. See [Troubleshooting](troubleshooting.md#a-side-effect-is-stuck-indeterminate).
6. **No Git write tool exists.** Policy models a `git-write` action; no built-in tool produces one.
   The agent can change files; it cannot commit, push, or rewrite history.
7. **The storage migrator has no future-version guard.** An older binary opening a database written by
   a newer build applies nothing and proceeds, where the config layer would refuse.
8. **The daemon has no shipped client.** It listens, streams events, and mediates approvals over the
   socket, but nothing in this repository connects to it.

## Why this page exists

The specification this product is built against forbids claiming a capability that a type, a mock, or
a happy-path unit test merely suggests. The same standard applies to its documentation. A feature
that exists as a well-tested package but that no user can invoke is not a feature yet — it is a
promise with good foundations, and it should be described as exactly that.
