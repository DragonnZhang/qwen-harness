# Sessions: resume, fork, export

A session is a **durable event log**, not a chat buffer. Everything the CLI can tell you about a
session — its history, its lineage, what it did to your host — is a read over that log. This is why
resume needs no remote state, why fork is cheap and safe, and why an interrupted write is never
blindly replayed.

## Where the state lives

```text
<your workspace>/.qwen-harness/sessions.sqlite
```

Workspace-local, not in `$HOME`. A run is therefore self-contained and inspectable, and deleting the
directory deletes the sessions for that workspace and nothing else.

SQLite in WAL mode with `synchronous = FULL`. The log is append-only; the tables the CLI reads
(`threads`, `turns`, `items`, `side_effects`) are **projections** that can be dropped and rebuilt
from the events.

Every event is **redacted before it is persisted**: the store is constructed with the live key so the
redactor scrubs it — along with `sk-…`-shaped tokens, GitHub tokens, AWS access keys, bearer/basic
authorization headers, private-key blocks, URL userinfo, and API-key query parameters — plus the
key's base64, base64url, and percent-encoded forms. Values under sensitive key names (`authorization`,
`api_key`, `access_token`, `refresh_token`, `client_secret`, `password`, `secret`, `token`, `cookie`)
are replaced wholesale with `[REDACTED]`. Redaction happens at the storage boundary, *before* the
transaction — not on the way out.

## Resume

```sh
qwen-harness resume thr_m4x8c2a0001 "now update the docs to match"
```

The model conversation is rebuilt from the durable log: user turns, assistant messages, tool calls,
and tool outputs, paired by their exact call IDs. **Local history is authoritative.** The harness
never asks the provider to remember a conversation and never trusts a remote conversation handle —
which also means a session survives a provider that forgot it, and cannot be steered by one that
misremembers.

Items that are not part of the model's input history (reasoning summaries, usage records) are stored
but not replayed into the prompt.

## Fork

```sh
qwen-harness fork thr_m4x8c2a0001
# forked thr_m4x8c2a0001 -> thr_m4x8c2a0007 (14 events copied)
```

Fork creates a new thread whose history is a copy of the original, with recorded lineage
(`thread-forked`, carrying the source id and the sequence it branched at). The original is never
modified.

What it copies: `turn-started` and `item-appended` events, with turn and item ids **re-minted** so
the new thread owns its own identity. The reconstructed model history is unchanged — history is
built from role, text, and the provider call id, none of which fork touches.

What it does **not** copy: the **side-effect ledger**. A forked session starts with no record of
prior host side effects. Fork branches the *conversation*, not the *consequences* — the files those
side effects wrote are still on disk, and the fork will happily do them again if you ask it to.

`sessions` shows the lineage:

```text
thr_m4x8c2a0007  turns=3  (unnamed) (forked from thr_m4x8c2a0001)
```

## Export

```sh
qwen-harness export thr_m4x8c2a0001 > session.jsonl
```

A stable public JSONL schema, independent of the internal tables: one header line, then one JSON
event per line.

```json
{"format":"qwen-harness/jsonl","formatVersion":1,"exportedAt":1752345600000,"threadId":"thr_…","eventCount":42}
```

The export is not re-redacted on the way out — it does not need to be, because nothing unredacted
was ever written. An unknown payload type survives a round trip intact rather than being dropped, so
an export written by a newer build is not silently mangled by an older one.

An import refuses what it cannot faithfully understand, with the exact reason:

```text
unrecognized export format: <format>
export is format version 3, this build understands up to 1
export claims 42 events but contains 41
empty export: missing header line
```

## The side-effect ledger

Every host side effect the agent performs is recorded with an idempotency key **before** it runs, and
settled **after**. Its state is one of:

| State | Meaning |
|---|---|
| `not-started` | recorded, not yet begun |
| `in-flight` | started; the outcome is not yet known |
| `known-complete` | it finished, and we know it |
| `known-failed` | it failed, and we know it |
| `indeterminate` | it was interrupted, and **we do not know** whether it took effect |

Before executing, the engine asks the ledger whether it may proceed:

| Prior state | May execute? | Reason given |
|---|---|---|
| not recorded / `not-started` | yes | `no prior execution recorded` |
| `known-failed` | yes | `prior attempt is known to have failed; safe to retry` |
| `known-complete` | **no** | `already completed; re-running would duplicate the side effect` |
| `in-flight` / `indeterminate` | **no** | `outcome is indeterminate after interruption; requires inspection, never blind replay` |

When execution is refused, the model is told so explicitly — the tool output becomes
`(skipped: already completed; re-running would duplicate the side effect)` — rather than the call
silently succeeding or silently vanishing.

### Why `indeterminate` exists

If the process dies between "I started writing this file" and "the write returned", there are exactly
two safe things to do and one unsafe one:

- Assuming it **failed** and retrying is how you get a double-write: two appends, two commits, two
  emails.
- Assuming it **succeeded** silently skips work that may never have happened.
- Recording that you **do not know** — and refusing to act until a human or a higher layer looks —
  is the only answer that cannot corrupt anything.

The harness takes the third. This is invariant 6 of the threat model: *known-complete side effects
never replay automatically after crash or disconnect*, and neither do unknown ones.

The storage layer implements the recovery step (`recoverInterrupted()` promotes every `in-flight` row
to `indeterminate` on restart; `listIndeterminate()` lists them for inspection), **but no CLI command
calls it today**. The safety property still holds — `in-flight` is refused by `mayExecute` exactly as
`indeterminate` is — but there is no user-facing way to list or clear the stuck rows. See
[Troubleshooting](troubleshooting.md#a-side-effect-is-stuck-indeterminate) for the manual procedure
and [Library surface](library-surface.md) for the gap.

## Budgets and cancellation

A turn is bounded. The defaults (`packages/runtime/src/budget.ts`, matching
[`docs/product/defaults.md`](../product/defaults.md)):

| Budget | Default | Termination reason when hit |
|---|---:|---|
| turns per goal | 200 | `turn-limit` |
| model calls per turn | 100 | `model-call-limit` |
| tool calls per turn | 1,000 | `tool-call-limit` |
| wall time per turn | 8 hours | `time-limit` |
| retries before visible output | 10 | `retry-limit` |
| rounds with no progress | 3 | `no-progress` |
| repeated identical tool calls | 3 | `repeated-identical-calls` |

No budget is ever silently increased. When one is hit, the turn ends in state `budget-exhausted` (or
`failed`) with that reason in the `--json` output, so a script can tell "the model gave up" from "the
model looped".

**Cancellation** is checked at the top of each loop iteration, and the abort signal is forwarded to
the provider stream and to the tool executor, so an in-flight model request or tool call is aborted
too. The turn ends `cancelled` with reason `user-cancelled`, and that ending is written to the log —
a cancelled turn is closed, not left dangling.

## A suspended turn is not a finished turn

There is one non-terminal outcome you will meet in normal use: **`awaiting-approval`**.

When policy says `ask` and there is no channel to ask on (`--json`, a closed stdin, a client that
detached), the turn does **not** end. It suspends, and the durable log holds the pending request —
the tool call, its normalized action, and the turn it belongs to. `sessions` shows it:

```text
thr_m4x8c2a0001  turns=1  (unnamed)  [awaiting approval: write /repo/hello.txt]
```

`qwen-harness resume <id>` (with no prompt) re-presents the action and finishes **that same turn**.
This is why an approval is not modelled as a new user message: replaying it as a message would lose
the tool call it was gating, and the model would be asked to redo work it had already decided on.

The distinction matters for scripts: exit `3` with `state: "awaiting-approval"` means *this work is
still alive and waiting for a human*, while exit `2` means the turn is over and it went wrong.
