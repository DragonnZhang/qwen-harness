# Active plan

This file is project state. It must survive context compaction and agent replacement.
On restart: read this file and `git log`, not chat history.

Snapshot: 2026-07-12

## Where we are

| Checkpoint                                                       | State                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 00 preflight and contract probes                                 | **PASSED** — evidence: `docs/execution/checkpoints/00-preflight-and-contract-probes.md` |
| 01 workspace, protocol, storage, testkit                         | **IN PROGRESS**                                                                         |
| 02 safe vertical loop (worker, policy, sandbox, provider, tools) | not started                                                                             |
| 03 policy, sandbox, approvals, hooks                             | not started                                                                             |
| 04 sessions, recovery, CLI, TUI slice                            | not started                                                                             |
| 05 instructions, skills, context, memory                         | not started                                                                             |
| 06 todo, tasks, background, Cron, worktrees                      | not started                                                                             |
| 07 subagents, teams, protocols, autonomy                         | not started                                                                             |
| 08 MCP and external extension                                    | not started                                                                             |
| 09 product completeness and release hardening                    | not started                                                                             |
| 10 final integrated and live acceptance                          | not started                                                                             |

Live evidence lane: **`LIVE_AVAILABLE`** — `DASHSCOPE_API_KEY` is present on the target host and
the Responses, Chat, and error contracts were confirmed against the real service at checkpoint 00.

## Settled at checkpoint 00 (do not re-litigate)

- Target host: Ubuntu 26.10, kernel 7.0, x86_64, 2 vCPU / 3.4 GiB, root. This is the only claimed platform.
- Sandbox backend: **bubblewrap**, all control classes proven on the host (ADR 0003).
- TUI: **Ink 7 + React 19**, spike passed under PTY (ADR 0004).
- Toolchain frozen, TypeScript pinned to **5.9.3** not 7.x (ADR 0002).
- The TUI/CLI **must ship compiled**; an in-process transpiler blew the RSS gate (ADR 0004).
- `background=false` is confirmed _by the live server_ (HTTP 400 `InvalidParameter`), not assumed.
- Chat `reasoning_content` is raw reasoning: discard it. Only Responses `summary_text` is a summary.
- Chat `delta.tool_calls` must be assembled by `index`; `id`/`name` appear only on the first fragment.
- pnpm 11 reads `onlyBuiltDependencies` from `pnpm-workspace.yaml`, not `package.json`.
  `node-pty` has no prebuild here and compiles from source, so `build-essential` is a real
  clean-host prerequisite (feeds `PK-01`).

## Next action

Checkpoint 01. Vertical outcome: **a complete fake turn can be persisted, exported, and replayed
into an identical projection, including across an injected crash at every durable boundary.**

Steps:

1. pnpm workspace + all `apps/*` and `packages/*` shells with real exports and TS project references.
2. Root command contract (`format:check`, `lint`, `typecheck`, `test`, `architecture`, `build`, `check`, …)
   wired so every one exits non-zero on failure from day one.
3. `packages/protocol`: versioned Thread/Turn/Item/Event schemas + command protocol. Zero I/O —
   enforced by an architecture test, not by convention.
4. `packages/storage`: SQLite WAL append-only event store, transactional projections, migrations,
   JSONL export/replay, redaction, failure injection.
5. `packages/testkit`: deterministic fake provider, fake tools, clock, ID source, storage,
   fixture repositories.
6. Architecture gate: dependency direction, no package imports an app, `protocol` opens no host
   capability, no cycles.

Gate: state-machine and crash-boundary tests replay a complete fake turn identically.

## Standing rules

- Do not mark a matrix row `VERIFIED` from types, routes, or mock-only tests.
- Never weaken or skip a failing test to make a gate pass.
- Commit only after the checkpoint gate passes; name it `checkpoint NN: <outcome>`.
- Never print, persist, or commit the API key. Fixtures are scrubbed and scanned.
