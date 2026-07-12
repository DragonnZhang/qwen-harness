# @qwen-harness/storage

The append-only typed event store: SQLite WAL, transactional projections, migrations, JSONL
export/replay, and boundary redaction.

A declared I/O owner (`scripts/graph.ts`): it owns its database and its files. No other package
may open SQLite.

## The central guarantee

**An event and every projection it implies commit in ONE transaction.** There is no window in
which an event exists but its projection does not. A crash therefore cannot leave a thread whose
log and whose materialized state disagree, and recovery is "reopen the file" rather than
"reconcile two stores".

`test/integration/event-store.test.ts` proves this by injecting a crash at all three durable
boundaries and asserting the log and the projection are _both_ empty afterwards.

## Never replaying a completed side effect

The `side_effects` table is the mechanism behind the invariant in `task.md`: _"Never automatically
replay a known-complete or indeterminate destructive action."_

| Recorded state                | `mayExecute()` | Why                                            |
| ----------------------------- | -------------- | ---------------------------------------------- |
| `not-started` / not recorded  | allow          | nothing happened yet                           |
| `known-failed`                | allow          | it demonstrably did not land; retrying is safe |
| `known-complete`              | **deny**       | re-running would duplicate it                  |
| `in-flight` / `indeterminate` | **deny**       | we started and never learned the outcome       |

On restart, `recoverInterrupted()` promotes every `in-flight` row to `indeterminate` — because the
process that owned it is gone, so it cannot still be running. It deliberately does **not** guess
`known-failed`: guessing failure is exactly what causes a double-write.

## Redaction sits at the STORAGE boundary

Not at the logging boundary. If redaction only happened on the way to a log, the secret would
still be sitting in the SQLite file, in the JSONL export, and in the support bundle. Redacting
before persistence makes every downstream artifact clean by construction, which is why the
security test can assert that a key in an event payload reaches neither the database nor the
export.

The redactor scrubs pattern-matched credentials, fields named `authorization`/`api_key`/…, _and_
the live key's base64 / base64url / percent-encoded forms — because a key leaks in shapes no
regex anticipates.

## Export is a public contract

The JSONL export schema is deliberately decoupled from the SQLite tables. Internal tables may be
renamed or re-indexed across releases; an export written today must still import into a future
build. So we serialize the typed event, not a row dump.
