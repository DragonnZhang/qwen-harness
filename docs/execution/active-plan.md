# Active plan

This file is project state. It must survive context compaction and agent replacement.
On restart: read this file and `git log`, not chat history.

Snapshot: 2026-07-13

## Where we are

| Checkpoint                                                       | State                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 00 preflight and contract probes                                 | **PASSED** — `checkpoints/00-preflight-and-contract-probes.md`          |
| 01 workspace, protocol, storage, testkit                         | **PASSED** — `checkpoints/01-*.md`                                      |
| 02 safe vertical loop (worker, policy, sandbox, provider, tools) | **PASSED** — `checkpoints/02-safe-vertical-loop.md`; E2E gate green     |
| 03 policy, sandbox, approvals, hooks                             | packages done; **approvals composition in progress**                    |
| 04 sessions, recovery, CLI, TUI slice                            | CLI + TUI done; TUI's UI-13 PTY restoration gate green (commit `3a60b6d`) |
| 05 instructions, skills, context, memory                         | instructions/memory done; **`skills` + prompt modes in progress**        |
| 06 todo, tasks, background, Cron, worktrees                      | packages done (`background`, `scheduler`, `worktrees`)                  |
| 07 subagents, teams, protocols, autonomy                         | packages done (`agents`, `teams`, `remote-worker`)                      |
| 08 MCP and external extension                                    | package done (`mcp`, commit `c384f47`)                                  |
| 09 product completeness and release hardening                    | **docs in progress**; packaging (PK-01/02/04) not started               |
| 10 final integrated and live acceptance                          | not started                                                             |

Live lane: **`LIVE_AVAILABLE`**. Three live tests pass against real `qwen3.7-max`: a provider smoke
(streamed tool call + usage + request id, no secret in the trace), a full coding loop (the model
fixed a real bug in a fixture repo and observed the test go green), and a session resume across a
fresh process. `pnpm test:live` fails closed (exit 1) when no key is present.

## The package layer is complete

32 packages and apps, each with real tests — no mock-only claims. ~1300 deterministic tests plus the
3 live tests pass. Every gate is green: format, lint, typecheck, architecture (7 boundaries across
193 source files), and the secret scan.

| Layer      | Packages                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure core  | `protocol`, `provider-core`, `tools-core`, `policy`, `runtime`, `tui-kit`                                                                                    |
| I/O owners | `storage`, `provider-dashscope`, `sandbox-linux`, `tool-worker`, `network`, `secret-store`, `telemetry`, `hooks`, `worktrees`, `config`, `instructions`, `memory`, `mcp`, `testkit` |
| Domain     | `tools-builtin`, `agents`, `teams`, `background`, `scheduler`                                                                                                 |
| Apps       | `cli`, `tui`, `daemon`, `remote-worker`                                                                                                                       |

Security properties are proven by execution, never by string matching: real bubblewrap escape
attempts (path, symlink, hardlink, TOCTOU, process, network, resource), real SSRF attempts including
redirect-to-metadata, a real second process for the single-writer daemon lease, and a real PTY
driving the compiled TUI bundle.

## What remains

1. **Composition** — approvals that pause and resume the _same_ turn through the CLI and across a
   process restart; the daemon socket driving a live `TurnEngine`.
2. **`skills` + prompt modes** — IN-01..IN-05, IN-09.
3. **Documentation set** — tutorial, configuration reference, troubleshooting, operator guide.
4. **Checkpoint 09 packaging** — PK-01 clean-host bootstrap; PK-02 versioned CLI package with
   lockfile, integrity, install/uninstall, config migration, upgrade/rollback, shell completion;
   PK-04 release artifacts, changelog, migration notes, support bundle, SBOM. Then `pnpm check`
   from a clean clone.
5. **Checkpoint 10** — the ten golden paths, the full credentialed live suite, clean-install on the
   recorded host, and the final audit that flips matrix rows to `VERIFIED`.

## Honest status

The goal is **INCOMPLETE**. The capability matrix reads **0 VERIFIED**. That is not pessimism: a row
may only be marked `VERIFIED` when its own declared evidence kinds are actually satisfied, and most
rows require `E` (a deterministic golden path) or `L` (live) evidence that belongs to checkpoint 10.
The subsystems exist and are individually tested; what is missing is end-to-end assembly and the
evidence lanes — not capability.

## Standing rules

- Never mark a matrix row `VERIFIED` from types, routes, or mock-only tests.
- Never weaken, skip, or delete a failing test to make a gate pass. Fix the cause.
- Commit only after the gate passes.
- Never print, persist, or commit the API key. Only the provider boundary reads it, and an
  architecture rule enforces that. Fixtures are scrubbed and scanned.
- Run the real binary. Three CLI bugs and two TUI bugs were caught only by executing the shipped
  artifact after every component test had passed. Component tests are necessary and not sufficient.
