# @qwen-harness/context

Token budgeting and compaction (CX-01, CX-02, CX-03, CX-06).

Pure coordination (`scripts/graph.ts`): this package performs **no direct host I/O**. It uses
`provider-core` item/token types for its estimates and persists compaction boundaries **through** an
injected `storage` port — it never opens a database or a file itself. The expensive, lossy parts
(the summarizer model call, the durable boundary write) are injected, so budgeting, reduction, and
compaction stay deterministic and testable.

## Budget (CX-01)

`computeBudget({ contextWindow, items, ... })` estimates the serialized token cost of the items,
reserves headroom, and reports utilization. Two defaults from `docs/product/defaults.md`:

- reserve **15%** of the context window for response + tool overhead;
- proactive compaction begins at **85%** of the usable input budget (window minus reserve).

The token estimator is injectable and documented: the default is a coarse but deterministic
`~4 chars/token` proxy. A caller with a real tokenizer passes its own `TokenEstimator`. The
breakdown exposes `usableInputBudget`, `usedTokens`, `availableTokens`, `utilization`,
`overThreshold`, and `overCapacity`.

## Cheap reduction first (CX-02)

`reduceContext(items, options)` runs loss-bounded steps **in order**, before ever paying for
compaction:

1. **offload** large tool results to a durable `ContextRef` (bounded head+tail preview + opaque
   ref; the blob store is `storage`'s — this package only produces the reference);
2. **prune** only safe middle content — plain messages between the goal and the recent tail;
3. **drop** the oldest complete tool-call/result **pairs** together, when a token target demands it.

The dominant invariant: **a tool result is never orphaned from its call.** `isPairingIntact`
is the checkable statement, and a 200-trial property test over randomized interleavings asserts it
survives every reduction.

## Threshold compaction (CX-03)

`compact({ items, summarizer, boundaryStore, ... })`:

1. measures the transcript;
2. writes the full transcript **boundary first** through the injected `BoundaryStore` and records
   its opaque ref — nothing is destroyed before the original is durably captured;
3. calls the injected `Summarizer` (the model call, kept out so this stays deterministic);
4. validates the summarizer's structured output with zod — a summary that drops the goal is
   rejected with `InvalidCompactionSummaryError`;
5. renders the preserved fields into the final `summary` text.

A valid summary **preserves** user goal, constraints, plan, todos/tasks, active files, decisions,
errors, and unfinished obligations — and those fields are rendered into the text so they literally
survive. The result is `CompactionResult { boundaryRef, summary, preserved, tokensBefore,
tokensAfter, freedTokens, compactedItemCount, trigger }`.

`InMemoryBoundaryStore` is the deterministic default. `eventStoreBoundaryStore(ctx)` is the
`storage`-backed adapter: it records the boundary as a `compaction` item on the durable append-only
log through the injected `EventStore`, returning the content digest as the ref.

## Commands (CX-06)

- `contextCommand(input)` — `/context`: the budget breakdown plus a printable status line.
- `compactCommand(options)` — `/compact [focus]`: runs compaction, then applies the
  diminishing-returns guard. Returns either `{ kind: 'compacted', result }` or the typed
  `{ kind: 'no-further-reduction', ... }` signal — **never a loop.**
- `clearCommand(options)` — `/clear`: resets to an empty transcript and reports a fresh budget.
- `evaluateCompaction` / `isDiminishingReturns` — the thrashing guards a scheduler consults before
  compacting again.

## Tests

- `src/budget.test.ts` — the 15% reserve, utilization math, near-full and over-capacity.
- `src/reduction.test.ts` — offload, safe pruning, pair dropping, and the pairing property test.
- `src/compaction.test.ts` — boundary-first ordering, preserved-field survival, invalid-summary
  rejection, async summarizer + focus.
- `src/commands.test.ts` — `/context`, `/compact`, `/clear`, and the diminishing-returns signal.
- `test/integration/storage-boundary.test.ts` — boundary persisted through a real `EventStore`.
