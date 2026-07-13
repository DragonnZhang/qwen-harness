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
| 06 todo, tasks, background, Cron, worktrees                      | **done** — tasks/background/cron wired; golden path 6 green (`686432e`)   |
| 07 subagents, teams, protocols, autonomy                         | **done** — teams wired; golden path 5 green (`59d58f9`)                   |
| 08 MCP and external extension                                    | **done** — mcp wired into CLI, shares policy ceiling (`a558f3e`)         |
| 09 product completeness and release hardening                    | **PASSED** — `pnpm check` green from clean tree (`dd44dc1`), 1537 tests   |
| 10 final integrated and live acceptance                          | golden paths 1,2,3,4,5,6,10 done; **7,8,9 remain**; final audit not started |

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

**Golden paths done: 1, 2, 3, 4, 5, 6, 10 (seven of ten).** Open:

1. **Path 7 — MCP end to end.** Local stdio MCP already works and is wired. The full path needs the
   HTTP/SSE transport and OAuth-against-a-fixture-issuer. HTTP MCP needs a POST-with-body egress
   primitive the GET-only `@qwen-harness/network` broker does not expose — **a real package gap**,
   not just wiring. Both the HTTP transport and HTTP hooks are currently REJECTED at the schema
   (honest), so closing this means extending the broker first.
2. **Path 8 — TUI over PTY.** The UI-13 restoration gate already drives the compiled bundle under a
   real PTY. The golden path is a full task: multiline Unicode input, resize, diff approval,
   background panels, interrupt, session resume, restoration. Needs a driver connecting the TUI to a
   live turn under node-pty.
3. **Path 9 — Live model.** `qwen3.7-max` streams text+reasoning, multiple tools, survives a
   retryable fault, reports usage, edits a fixture and passes its tests. Needs credentials
   (`LIVE_AVAILABLE`); three live smoke tests already pass, so the lane works — this is the fuller
   scripted live golden path.
4. **The final audit (checkpoint 10).** Flip matrix rows to `VERIFIED` only where the declared
   evidence exists. Produce the final report: exact commands, durations, evidence, commit IDs.

`config.baseUrl` plumbing (found by path 10) is FIXED at `9774105`.

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
