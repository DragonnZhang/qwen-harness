# ADR 0004: Ink behind `tui-kit`, shipped as compiled output

Status: accepted
Date: 2026-07-12
Checkpoint: 00

## Context

`task.md` requires the TUI to be Ink/React behind an internal adapter, **contingent on the
required host spike**, and forbids switching the product runtime to Bun/Rust/Python/FFI merely to
simplify UI work. `docs/quality/acceptance.md` sets the gate: p95 active-frame work < 50 ms,
p95 input echo < 100 ms, peak RSS < 512 MiB, against 10K transcript rows, a 50K-character live
stream, a 2K-line diff, unfinished Markdown, Unicode, and 80x24 <-> 160x50 resize.

## Decision

Ink 7.1.0 + React 19.2.7 is confirmed as the renderer, isolated behind `packages/tui-kit`.
The spike passed on the target host under a real PTY (checkpoint 00 §5): p95 frame work
**0.49 ms**, peak RSS **481 MiB**, resize honored, cursor and screen state restored, exit 0.

The spike also produced a constraint that changes how we ship:

> Running the identical spike through the `tsx` on-the-fly transpiler measured **520 MiB RSS,
> exceeding the 512 MiB gate**. The same code, bundled, measured **481 MiB**.

**Therefore: the TUI and CLI ship as compiled/bundled JavaScript. An in-process transpiler
(`tsx`, `ts-node`, or equivalent) is a development convenience only and is never on the
production start path or the performance-gate path.**

## Consequences

1. `packages/tui-kit` owns renderer-neutral view models and the input editor; Ink components
   consume typed projections and never own agent-loop state. Editor/view-model state is
   independent of renderer components, so it is testable without a terminal.
2. `pnpm build` produces the artifact that `pnpm test:performance` measures. Measuring a
   `tsx`-executed TUI would be measuring the wrong program, and would have failed the RSS gate
   for a reason that has nothing to do with the product.
3. `bin` entry points resolve to built output. The clean-install gate (`PK-02`, golden path 10)
   exercises the compiled artifact.
4. Ink and React versions are pinned exactly (ADR 0002). An Ink major upgrade requires re-running
   the spike, because the gate thresholds are the contract, not the library version.
5. The RSS margin (481 of 512 MiB) is modest, but the fixture is deliberately pessimistic: it
   holds all 10,000 rows in React state at once, whereas the classic view replays the latest 200
   display items and the transcript inspector virtualizes. Real usage sits well below the bound.
   `UI-14` re-measures this on the real renderer rather than trusting the spike.
