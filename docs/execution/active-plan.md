# Active plan

This file is project state. It must survive context compaction and agent replacement.
On restart: read this file and `git log`, not chat history.

Snapshot: 2026-07-13 (evening)

## Where we are

| Checkpoint                                                       | State                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 00 preflight and contract probes                                 | **PASSED** — `checkpoints/00-preflight-and-contract-probes.md`           |
| 01 workspace, protocol, storage, testkit                         | **PASSED** — `checkpoints/01-*.md`                                       |
| 02 safe vertical loop (worker, policy, sandbox, provider, tools) | **PASSED** — `checkpoints/02-safe-vertical-loop.md`; E2E gate green      |
| 03 policy, sandbox, approvals, hooks                             | **done** — approvals pause/resume the same turn; hooks fire on the turn  |
| 04 sessions, recovery, CLI, TUI slice                            | **done** — CLI + TUI; UI-13 PTY restoration gate green (`3a60b6d`)       |
| 05 instructions, skills, context, memory                         | **done** — skills+prompt modes (`a558f3e`); instructions/context wired   |
| 06 todo, tasks, background, Cron, worktrees                      | packages done; **NOT wired into any app** (blocks golden path 6)         |
| 07 subagents, teams, protocols, autonomy                         | packages done; **NOT wired into any app** (blocks golden path 5)         |
| 08 MCP and external extension                                    | **done** — mcp wired into CLI, shares policy ceiling (`a558f3e`)         |
| 09 product completeness and release hardening                    | packaging PK-01/02/04 done; docs done; `pnpm check` green being verified |
| 10 final integrated and live acceptance                          | golden paths 1-3 done; 4-10 remain; final audit not started              |

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

1. **Wire `teams`/`background`/`scheduler`/`worktrees`/`agents`/`tasks` into an app.** They are
   built and tested but reachable from no application, so golden paths 5 (team execution) and 6
   (scheduling) cannot exist yet, and their matrix rows cannot be verified. This is the largest
   remaining gap.
2. **Golden paths 4–10.** Done: 1 (coding loop), 2 (recovery), 3 (permissions). Remaining: 4 (long
   context/compaction — context is wired, needs the E2E), 5 (teams), 6 (scheduling), 7 (MCP end to
   end incl. HTTP transport, which needs a POST-with-body egress the network broker lacks), 8
   (TUI/PTY full task), 9 (live model), 10 (fresh install — packaging exists, needs the E2E).
3. **The final audit (checkpoint 10).** Flip matrix rows to `VERIFIED` only where the declared
   evidence exists. Produce the final report with commands, durations, evidence, commit IDs.

## Known honest gaps (do not paper over)

- HTTP/SSE MCP transports and HTTP/prompt hooks are REJECTED at the schema (not silently ignored) —
  they need a POST-with-body egress primitive `@qwen-harness/network`'s GET-only broker lacks.
- Automatic post-turn memory extraction is not wired (no proposal source without a second model
  call). `memory add` reaches the real gates; the automatic turn-end path does not.
- `yolo` maps to `disabled` isolation honestly now, but the daemon run path has less of the
  instructions/hooks/skills/memory/MCP wiring the CLI run path has.
- The real-OS-keyring secret-store test skips on this host (no libsecret) — an honest
  environment-conditional skip, recorded for the final audit.

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
