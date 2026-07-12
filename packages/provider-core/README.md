# @qwen-harness/provider-core

The normalized, provider-neutral model contract. **Layer 1, pure.**

Nothing in this package knows which vendor is on the other end of the socket. No vendor wire type
may appear here, and none may escape the adapter that produced it (task.md boundary 6).
`pnpm architecture` enforces the purity half of that: no host module, no `Date.now()`, no
`Math.random()`, no `process.env`.

## What it exposes

| Export                                                        | Purpose                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ModelRequest`, `ModelInputItem`, `ToolDefinition`            | The request. Instructions are sent every call; a `function-call` pairs to its `function-output` by `callId`.  |
| `ProviderStreamEvent`                                         | The only thing a provider may emit.                                                                           |
| `NormalizedUsage`                                             | Every count is `number \| null`. Unknown stays null.                                                          |
| `ProviderCapabilities`, `freezeCapabilities`                  | A frozen table, not a negotiation.                                                                            |
| `ModelProvider`                                               | `capabilities` + `stream(request)`.                                                                           |
| `RetryPolicy`, `decideRetry`, `fullJitterDelayMs`             | Bounded retry with exponential full jitter.                                                                   |

## Three decisions worth explaining

### 1. `reasoning-summary-*` and `reasoning-status` are different events, and that is a security boundary

A reasoning **summary** is model-authored, renderable, and persistable. Raw private chain-of-thought
is none of those things (PV-04). The Chat transport receives raw reasoning and must discard it — so
the event it emits instead, `reasoning-status`, carries a flag and a token count and **has no field
that could hold text**. The type system, not a code review, is what prevents raw reasoning from
being relabeled as a summary: there is nowhere to put it.

### 2. Unknown usage stays `null`, never `0`

Coercing a missing token count to zero makes a budget silently under-report, and a budget that
under-reports is worse than one that admits it does not know. `addUsage` preserves this:
`null + null` is `null`; `null + 5` is `5`.

### 3. The RNG is a parameter

`decideRetry(error, state, rng, policy)` takes `rng: () => number`. This package is pure, so
`Math.random()` is not available to it — but the real reason is that a backoff distribution you
cannot seed is a backoff distribution you cannot test, and the whole runtime has to stay replayable
(RT-08).

Full jitter is `random(0, min(cap, base * 2^attempt))` — the **whole** interval, not the exponential
value plus noise. Equal jitter still clusters a fleet in the upper half of the window; full jitter is
what actually spreads it out. Defaults are frozen in `docs/product/defaults.md`: 10 attempts bounded
by 5 minutes, 500 ms base, 30 s cap, server hints honored.

`decideRetry` also refuses for reasons that are not budgets. `visible-output-emitted` means a retry
stream would be concatenated onto text the user has already read (PV-11); `side-effect-uncertain`
means we may already have caused something we cannot un-cause. Both are correctness refusals, and
they are reported separately from "you ran out of attempts" so a turn can explain itself.

## Failure contract

Implementations emit a terminal `{ type: 'error' }` event **and** throw the same `HarnessError`.
Emitting alone lets a careless consumer mistake a failed turn for an empty one; throwing alone hides
the failure from an event-sourced projection. An abort rejects with the signal's reason — cancelling
is not a provider failure and must not be classified or counted against a retry budget.
