# ADR 0005 — A gate must be able to fail

Status: accepted
Date: 2026-07-13

## Context

Four separate controls in this project were implemented correctly, tested thoroughly, and had **no
effect whatsoever**, because nothing actually invoked them. Each one read as green.

1. **`pnpm test:migrations` matched zero test files.** The vitest project globbed
   `packages/*/test/migrations/**` and no such directory existed. `pnpm check` composed the project,
   so the release gate was asserting nothing about the schema — while looking like schema coverage.
2. **`pnpm test:performance` matched zero test files**, identically. The checkpoint-00 spike had
   *measured* the TUI performance numbers under a real PTY and never committed them as a test, so
   nothing guarded them.
3. **The managed policy ceiling never reached a run.** `createHarnessRuntime` built its
   `PolicyContext` with `NO_MANAGED_RESTRICTIONS` hard-coded. Every policy-engine unit test passed;
   the engine was never handed the administrator's policy. `/etc/qwen-harness/managed.json` bounded
   what `doctor` *printed* and nothing about what the model could do.
4. **`pnpm build` never built the whole product.** Root `build` was `tsc --build`, which skips
   `tool-worker`'s esbuild step. A clean clone had no `worker.bundle.mjs` and 13 integration tests
   failed — invisible on any machine where the bundle survived from an earlier manual build.

The common shape: **the mechanism was right and the wiring was absent.** A component test cannot see
this, because a component test constructs the component itself. Only executing the real artifact,
from a clean state, reveals it.

Two of these were security controls. One (3) would have shown an operator a ceiling that did not
exist.

## Decision

1. **A gate that runs nothing fails.** A test project that matches no files is a failure, not a
   pass. We do not add `--passWithNoTests` to any project in `pnpm check`.
2. **A security control is not "done" until something executes it end to end.** The proof of a
   ceiling is a real run that the ceiling stops — not a unit test of the clamping function. See
   `apps/cli/test/security/managed-ceiling.test.ts`.
3. **Every optimization that replaces a readable implementation with a faster one is pinned to the
   original by an equivalence test.** A fast path is a second implementation and therefore a second
   chance to be wrong. This is not theoretical: the `stringWidth` fast path shipped a real bug
   (`x<ZWJ>y` measured 2 cells instead of 1) that only the equivalence test caught.
4. **Verify negative claims with a control.** A test asserting "the write was blocked" is worthless
   if the write was never attempted. The managed-ceiling suite pairs every denial with a control
   proving the same action *does* land when the ceiling is removed. The first version of that test
   passed vacuously — it emitted a provider event type the runtime ignored, so nothing ever tried to
   write, and it reported a security property it had not tested.
5. **Run the shipped artifact.** Five bugs in this project were found only by executing the real
   binary after every component test was green (three in the CLI, two in the TUI — including a
   startup `ZodError` that crashed the compiled bundle before it rendered a byte).

## Consequences

`pnpm check` is slower and more annoying, and it is the only thing that has ever told the truth
about this repository. The performance suite asserts on CPU time rather than wall-clock, because a
contended host measures the scheduler rather than the code — but the thresholds themselves are
unchanged, and moving a threshold to meet the code is forbidden: `acceptance.md` already says an ADR
must justify a bound *before* implementation, not after a failure.
