# @qwen-harness/hooks

The hook **engine** plus the typed event/outcome model (HK-01..HK-05).

A hook lets you observe or **steer** the runtime at 30 well-known points — block an action, inject
context, propose an input change, request a stricter permission, annotate MCP output, or stop
continuation. A hook can **never** elevate authority. That is the whole point of this package, and
it is enforced by the engine, not left to the hook author to respect.

This package is a declared I/O owner for `node:child_process` **only** — the controlled command-hook
executor. HTTP hooks go through the injected `NetworkBroker` (the `network` package); model/agent
hooks go through injected runners. All hook **output** is untrusted and crosses protocol's
`sanitize()` before it is used or displayed.

## What's here

- `events.ts` — the 30 hook events (HK-01). A frozen registry of names; each domain wires its real
  emissions. It is deliberately **not** a "no-op emitter" that fires all 30 from nowhere.
- `outcome.ts` — the typed `HookOutcome` discriminated union and its zod boundary schema (HK-03).
- `registry.ts` — registration plus matcher/condition filtering with deterministic ordering (HK-02).
- `executor.ts` — the controlled command executor (minimal env, deadline, visible failure) and the
  HTTP-via-broker shaper.
- `engine.ts` — the fold and the security invariants (HK-04, HK-05).

## The no-elevation invariant (HK-04)

> A hook allow can **never** override a policy deny or ask.

`HookEngine.run(event, input, context)` is **handed the current policy decision** and may only
return one that is equal or **more restrictive**. The mechanism is a single restrictiveness ladder:

```
passthrough = allow  <  ask  <  deny
```

The fold only ever moves **up** this ladder. A hook's `allow` / `passthrough` outcome is not even on
the ladder as a lowering force — it is recorded in `result.ignoredElevations` (attributed to the
hook) and has zero effect on the decision. So:

- policy said `deny` + hook says `allow`  ⇒ **`deny`** (elevation recorded and ignored)
- policy said `ask` + hook says `allow`  ⇒ **`ask`** (elevation recorded and ignored)
- policy said `allow` + hook says `ask`  ⇒ **`ask`** (a hook may always restrict)
- a hook `block` on a pre-action event ⇒ the action is stopped and the decision is `deny`

This composes with the managed ceiling: **managed hard deny dominates every hook outcome** (threat
model, non-bypassable invariant #1). The hook engine never produces an allow that policy did not
already grant, so there is no path for a hook to reach past a managed deny.

Two more parts of HK-04 the engine enforces:

- **Modified input is fully revalidated.** A `modify` outcome becomes a `ModifiedInputProposal`
  flagged `needsRevalidation: true`. The engine never applies it — the caller must re-run the tool
  schema and policy on the proposal. The type makes an un-revalidated proposal unconstructible.
- **Untrusted output is sanitized and attributed.** `context` text crosses `sanitize()` (origin
  `hook`) so an ANSI/OSC injection is rendered inert, and every result carries the `hookId` that
  produced it.

## Stop re-entry protection (HK-05)

A `Stop` hook must not be able to trigger another `Stop` that re-enters the engine — that is an
infinite-loop / denial-of-service vector. The engine tracks that a Stop is in progress:

- A re-entrant `run('Stop')` **while a Stop is being handled** returns immediately with
  `stopReentryRefused: true` and runs no handlers. A Stop hook that recursively calls the engine
  therefore gets a refusal instead of looping.
- A Stop handler that itself returns a `stop` outcome is recorded as a refused re-entry
  (`stopReentryRefused: true`), not acted on.

Separately, **post-tool hooks can stop continuation without corrupting the completed tool result.**
On `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` the tool has already run and its result is
durable. A `stop` (or a `block`, which is downgraded to a stop since you cannot block an action that
already happened) sets `stopped: true` and `resultDurable: true` — it prevents the **next** step and
never touches the result that already exists.

## Visible failures

Timeouts, non-zero exits, transport errors, and malformed output are surfaced in `result.failures`,
attributed to the hook. A failing hook is **never** smoothed into a silent `allow`. Every handler is
time-bound: the engine races it against a deadline drawn from the injected `Clock` and cancels it
(killing a child process with `SIGKILL`) when the deadline fires.

## Secret handling

The command executor builds the child environment from a **safe allowlist** (`PATH`, `HOME`, locale,
`TZ`, `TMPDIR`, plus whatever the hook config explicitly adds). The provider credential is excluded
by construction — the allowlist does not name it, and this package never references the credential
at all.
