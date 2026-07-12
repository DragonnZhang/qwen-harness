# Active plan

This file is project state. It must survive context compaction and agent replacement.
On restart: read this file and `git log`, not chat history.

Snapshot: 2026-07-12

## Where we are

| Checkpoint | State |
|---|---|
| 00 preflight and contract probes | **PASSED** — `docs/execution/checkpoints/00-preflight-and-contract-probes.md` |
| 01 workspace, protocol, storage, testkit | **PASSED** — commit `e2376a7`, evidence in `checkpoints/01-*.md` |
| 02 safe vertical loop (worker, policy, sandbox, provider, tools) | **IN PROGRESS** |
| 03 policy, sandbox, approvals, hooks | not started |
| 04 sessions, recovery, CLI, TUI slice | not started |
| 05 instructions, skills, context, memory | not started |
| 06 todo, tasks, background, Cron, worktrees | not started |
| 07 subagents, teams, protocols, autonomy | not started |
| 08 MCP and external extension | not started |
| 09 product completeness and release hardening | not started |
| 10 final integrated and live acceptance | not started |

Live evidence lane: **`LIVE_AVAILABLE`** — `DASHSCOPE_API_KEY` present; Responses/Chat/error
contracts confirmed against the real service at checkpoint 00 and captured as fixtures.

## Settled — do not re-litigate

- Target host: Ubuntu 26.10, kernel 7.0, x86_64, 2 vCPU / 3.4 GiB, root. Only claimed platform.
- Sandbox backend: **bubblewrap**, every control class proven on the host (ADR 0003).
- TUI: **Ink 7 + React 19**, spike passed under PTY (ADR 0004).
- TypeScript pinned to **5.9.3**, not 7.x (ADR 0002).
- The TUI/CLI **must ship compiled** — an in-process transpiler measured 520 MiB and blew the
  512 MiB RSS gate; the same code bundled measured 481 MiB (ADR 0004).
- `background=false` is confirmed *by the live server* (HTTP 400 `InvalidParameter`), not assumed.
- Chat `reasoning_content` is RAW reasoning: discard it. Only Responses `summary_text` is a summary.
- Chat `delta.tool_calls` must be assembled by `index`; `id`/`name` appear only on the first fragment.
- pnpm 11 reads build approval from `allowBuilds:` in `pnpm-workspace.yaml` (NOT
  `onlyBuiltDependencies`, NOT `package.json`). `node-pty` + `better-sqlite3` compile from source,
  so `build-essential` is a real clean-host prerequisite (feeds `PK-01`).
- This Node build has **no native TS stripping** — scripts run under `tsx`, never
  `node --experimental-strip-types`.
- Prettier must NOT touch `docs/` or `*.md`: the specification is frozen and reflowing its tables
  churns the source of truth. Enforced via `.prettierignore`.
- Security-test canaries are **assembled at runtime** (`packages/testkit/src/canaries.ts`) so no
  source file contains a literal that looks like a credential. `pnpm secrets:scan` therefore stays
  strict with **no allowlist** — an allowlist in a secret scanner is what later hides a real leak.
- `testkit` depends on `protocol` ALONE. It is a devDependency of every other package, so any
  further dependency would create a workspace cycle.

## Checkpoint 02 — in progress

Vertical outcome: **the fake model edits a disposable fixture repo, runs its tests, and returns a
durable result — through deny-by-default policy and a REAL bubblewrap sandbox worker — and file
and shell attacks cannot escape.**

Done so far:

- `packages/protocol/src/sanitize.ts` + tests (40 passing). The single `UntrustedText → SafeText`
  sanitizer (TL-11/TL-14). Neutralizes OSC 52 clipboard exfiltration, OSC 8 lying hyperlinks,
  forged approval dialogs, CSI cursor/screen control, DCS/APC, bidi Trojan Source, and zero-width
  hiding — from **every** origin (model, repo, tool, hook, MCP, web, provider, markdown-link).
  `SafeText` is nominal, so a renderer that accepts only `SafeText` is *statically guaranteed*
  sanitized input.
- `packages/tools-core` (pure): tool contract, registry, and the concurrency planner (12 tests).
  Registry holds DEFINITIONS only, never handlers — which is *why* a main-process `fs` call cannot
  implement a model tool. Batching is derived from actual argument footprints, not tool names.

Remaining for 02:

1. `packages/policy` + `packages/sandbox-linux` — delegated, in flight.
2. `packages/provider-core` + `packages/provider-dashscope` — delegated, in flight.
3. `packages/tool-worker` — capability-scoped RPC; the ONLY place model-initiated file/shell/Git
   I/O executes. Runs inside the bubblewrap sandbox.
4. `packages/tools-builtin` — list/glob/grep/read/write/edit/apply-patch/shell/git handlers.
5. `packages/runtime` — the turn state machine, stream normalization, budgets, cancellation,
   basic recovery. Coordinates interfaces; performs no direct host I/O.
6. E2E: fake model drives a real edit+test loop in a `FixtureRepo` through the whole pipeline.
7. Security: file/shell/symlink/network escape attempts against the real sandbox.

Gate: the deterministic minimal coding loop completes through deny-by-default policy and the real
sandbox worker; sandbox attack tests pass. Then commit `checkpoint 02`.

## Standing rules

- Never mark a matrix row `VERIFIED` from types, routes, or mock-only tests.
- Never weaken or skip a failing test to make a gate pass.
- Commit only after the checkpoint gate passes; name it `checkpoint NN: <outcome>`.
- Never print, persist, or commit the API key. Fixtures are scrubbed and scanned.
