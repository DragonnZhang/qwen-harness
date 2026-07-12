# Checkpoint 02 - Safe vertical loop

Status: PASSED (deterministic gate)
Date: 2026-07-13
Live lane: available; the live smoke is a bonus, not this gate.

## Vertical outcome

**A scripted model edits a disposable fixture repo, runs its tests, and returns a durable result —
through deny-by-default policy and a REAL bubblewrap sandbox worker — and file, shell, and path
attacks cannot escape.**

This is the protocol's checkpoint-02 gate, and it is met by an executable end-to-end test against a
real sandbox, not by inspection.

## The gate: `evals/e2e/coding-loop.test.ts`

A scripted "model" drives a real coding loop entirely through the production pipeline
(schema → policy → real sandbox worker):

1. reads a failing test to learn the expectation;
2. runs the test and observes a non-zero exit (the bug is real);
3. reads the buggy source;
4. fixes it with a precise `edit_file` (subtraction → addition);
5. re-runs the test and watches it print `PASS` with exit 0;
6. `git_diff` shows exactly the one-line fix and nothing else — the test file is untouched.

Plus two safety assertions in the same file:

- **deny-by-default**: in `plan`, an `edit_file` call is `denied` before it can reach the worker,
  and the file on disk is unchanged.
- **schema rejection**: a `write_file` to an absolute path (`/etc/passwd`) is `rejected` at the
  schema layer, never executed.

Every step runs against real `bwrap`, a real filesystem, and the real policy engine.

## What was built (all committed)

| Package | Role |
|---|---|
| `protocol/sanitize` | the single `UntrustedText → SafeText` sanitizer (TL-11/TL-14) |
| `tools-core` | tool contract, registry, concurrency planner |
| `provider-core` | normalized provider-neutral contracts; retry with injected-RNG full jitter |
| `provider-dashscope` | Responses (primary) + Chat (compatibility) transports, error table |
| `policy` | deny-by-default engine (pure); managed ceiling intersected last |
| `sandbox-linux` | the real bubblewrap backend, `--cap-drop ALL`, fail-closed detection |
| `tool-worker` | capability-scoped RPC + sandboxed handlers + the client that spawns them |
| `tools-builtin` | tool definitions (one tool, three views) + the execution pipeline |
| `runtime` | turn state machine, budgets, stream normalizer |

## Gate results

```
pnpm format:check     PASS
pnpm lint             PASS
pnpm typecheck        PASS (tsc --build --force, whole graph)
pnpm architecture     ✓ PASS: all 7 boundaries hold across 69 source files
pnpm secrets:scan     PASS
pnpm build            PASS
pnpm test              (unit)         — part of the 696
pnpm test:integration                 — part of the 696
pnpm test:security                    — part of the 696
pnpm test:e2e                         — 4 tests, the gate
                       total: 696 deterministic tests, 0 failures
```

## Security evidence against the real sandbox

`packages/sandbox-linux/test/security/real-sandbox.test.ts` and
`packages/tool-worker/test/integration/sandboxed-tools.test.ts`, both executing real `bwrap`:

- cannot see `/root`, a secret outside the workspace, or `~/.ssh` — they are not mounted;
- `workspace-write` writes inside the workspace but not outside; `read-only` makes the workspace
  unwritable while scratch stays writable;
- a parent-process secret env var (provider-key stand-in) is absent from the child;
- the whole process tree is reaped on the deadline — a grandchild sleeper leaves no orphan;
- an output flood is bounded; network is denied by default and grantable against a loopback server;
- `resolveScoped` refuses absolute-path smuggling, `../` traversal, symlink escape, a symlinked
  parent directory, and pre-existing hardlinks, re-checking device+inode after open (TOCTOU);
- a read-only grant refuses a write and a `../../../etc/passwd` read is refused even with a full
  grant.

## Architecture boundary held

`model-initiated file, shell, and Git I/O executes ONLY in the separate sandbox-created worker over
capability-scoped RPC` (SB-04). The runtime holds tool *definitions* and cannot hold a handler —
the handler type does not exist on its side. The worker ships as a self-contained esbuild bundle
because inside the sandbox there is no `node_modules` to import from.

## Honest limitations carried forward

- The turn ENGINE that persists side-effect intent/result to storage around each pipeline call, and
  the full `Thread→Turn` event loop, are not yet wired end-to-end — that is checkpoint 04's session
  work. The pipeline and storage exist and are individually tested; their composition into a
  persisted turn is the next integration.
- No CLI/TUI yet (checkpoint 04). No live smoke recorded yet (bonus; the deterministic E2E is the
  gate).
- Matrix: 0 VERIFIED, 44 IN_PROGRESS, 134 REQUIRED. No row is VERIFIED because VERIFIED requires the
  full evidence set (including `T`/`L` and the cross-capability golden paths) resolved at
  checkpoint 10.

## Next

Checkpoint 03 — layered config provenance, the four permission profiles wired to the runtime, exact
approval grants, protected paths end-to-end, and the hook engine with its checkpoint-03 events.
