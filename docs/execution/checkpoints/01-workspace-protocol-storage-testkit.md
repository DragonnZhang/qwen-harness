# Checkpoint 01 - Workspace, protocol, storage, testkit

Status: PASSED
Date: 2026-07-12

## Vertical outcome

**A complete fake turn can be persisted, exported, and replayed into an identical projection —
including across an injected crash at every durable boundary, and without a secret reaching disk.**

This is the gate the protocol requires ("state-machine and crash-boundary tests can replay a
complete fake turn identically"), and it is proven by executable tests, not by inspection.

## What was built

| Unit                      | Contents                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| workspace                 | pnpm monorepo, 31 packages/apps, TS project references, root command contract                                               |
| `scripts/graph.ts`        | THE dependency graph — one declaration, used to _generate_ manifests and to _enforce_ the boundary, so the two cannot drift |
| `scripts/architecture.ts` | 7 mechanically-checked boundaries (`pnpm architecture`)                                                                     |
| `scripts/secret-scan.ts`  | working-tree credential scan (`pnpm secrets:scan`)                                                                          |
| `packages/protocol`       | branded IDs, Thread/Turn/Item, turn state machine, event envelope, typed errors, command protocol, `Clock`                  |
| `packages/storage`        | SQLite WAL event store, transactional projections, migrations, JSONL export/replay, boundary redaction                      |
| `packages/testkit`        | `ManualClock`, `SequentialIds`, canonical actors, disposable Git `FixtureRepo`                                              |

## Gate results

```
pnpm exec tsc --build --force        exit 0
pnpm exec eslint packages scripts    exit 0 (0 errors)
pnpm exec prettier --check           exit 0
pnpm architecture                    ✓ PASS: all 7 boundaries hold across 14 source files
pnpm secrets:scan                    ✓ PASS: no credential material in the working tree
pnpm test              (unit)        21 passed
pnpm test:integration                12 passed
pnpm test:security                   11 passed
                                     ── 44 tests, 0 failures
```

## The architecture gate is verified to actually catch violations

A gate that has never failed is worthless. Each boundary was tested by _injecting_ a real
violation and confirming a non-zero exit with an actionable message:

| Injected violation                            | Caught by                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `protocol` imports `node:fs`                  | rule 4 (host I/O only in declared `IO_OWNERS`) + rule 5 (pure packages) |
| `storage` imports `@qwen-harness/cli`         | rule 1 (dependency direction) + rule 2 (no package imports an app)      |
| `storage` imports `runtime` (wrong direction) | rule 1, naming the exact fix in `graph.ts`                              |
| `Date.now()` inside `protocol`                | rule 5 — "inject a Clock / RNG / config value instead"                  |

All four failed the build; removing them restored `✓ PASS`.

## Evidence for the reliability gate

`packages/storage/test/integration/event-store.test.ts`:

- **Crash boundaries** — failure is injected at `before-event-insert`,
  `after-event-insert-before-projection`, and `after-projection-before-commit`. After a crash at
  _any_ of the three, the event log and the projection agree (both empty). There is no state in
  which an event exists but its projection does not.
- **Deterministic rebuild** — `rebuildProjections()` replays the log and lands on _identical_
  projection rows, not merely equivalent ones.
- **Never replay a completed side effect (SS-05)** — a `known-complete` write is refused; a
  `known-failed` one is allowed to retry; an interrupted `in-flight` `rm -rf build` is promoted to
  `indeterminate` on recovery and then **refused**, because we do not know whether it ran.
  Guessing "failed" and re-running it is precisely the bug the ledger exists to prevent.
- **Single-writer guard** — a second writer forcing a duplicate `(thread_id, seq)` is rejected by
  a `UNIQUE` constraint, not by a lock we merely hope is held.
- **Forward compatibility (RT-09)** — an event written by a _future_ build survives
  export → import → re-export with its payload intact.

`packages/storage/test/security/redaction.test.ts`:

- A canary key (never the real credential) placed into an event payload reaches **neither the
  SQLite file nor the JSONL export** — because redaction runs at the storage boundary, so every
  downstream artifact is clean by construction.
- Base64, base64url, percent-encoded, and `Bearer`-wrapped encodings of the key are all scrubbed.
  A key leaks in shapes no regex anticipates, so the literal value's _encodings_ are scrubbed too.
- Fields named `authorization` / `api_key` / `password` are redacted by NAME even when the value
  looks innocuous.

## Notes carried forward

- `tsc --build` is incremental; the `typecheck` script uses `--force` so a stale `.tsbuildinfo`
  can never mask an error in CI.
- Prettier is pinned to single quotes / trailing commas / 100 cols (`.prettierrc.json`).
- 56 non-fatal architecture warnings remain: packages scaffolded but not yet implemented have no
  `src/index.ts` or README. These convert to failures as each checkpoint claims its package.

## Next

Checkpoint 02 — the safe vertical loop: deny-by-default policy, capability-scoped tool-worker RPC,
the real bubblewrap sandbox worker, `provider-core` + DashScope Responses/Chat adapters, the turn
state machine, and the foundational tools. No model-initiated host write may exist before the
sandbox does.
