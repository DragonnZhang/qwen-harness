# Checkpoints 05-07 - Domain packages (consolidated record)

Status: substantially complete; several rows still need T/L/E evidence at checkpoint 10
Date: 2026-07-13

This record covers the broad package-building phase that advanced checkpoints 05, 06, and 07 in
parallel. Each package was built to the "real, tested, no placeholders" bar, committed individually
with its own evidence, and reconciled into a green tree.

## What landed (all committed on `main`)

| Package | Checkpoint | Headline guarantee | Tests |
|---|---|---|---|
| `config` | 03 | per-value provenance; deny-first security merge; tighten-only managed ceiling | 60 |
| `hooks` | 03 | 30 events; a hook allow can never flip a policy deny/ask; Stop re-entry refused | 45 |
| `instructions` | 05 | resolution precedence + provenance; instructions are context, never authority | 21 |
| `context` | 05 | budget with reserved headroom; reduction never orphans a tool result; compaction preserves goal/tasks/files | 24 |
| `memory` | 05 | scopes; Dream on exact frozen gates; atomic writes; secrets rejected at extraction | 79 |
| `tasks` | 06 | todo vs durable graph; atomic claim (race-proven); no id reuse; cycle rejection | 87 |
| `background` | 06 | one lifecycle for 3 real categories; idempotent completion; FIFO priority + anti-starvation | 21 |
| `scheduler` | 06 | 5-field Cron (DOM/DOW OR); deterministic jitter; coalesce/missed/resume; authority intersected at fire | 50 |
| `worktrees` | 06 | real git worktrees; removal refuses dirty/unmerged by default | 20 |
| `agents` | 07 | a child never gets more authority than its parent; depth/count bounded; bounded conclusion | 9 |
| `teams` | 07 | typed protocol (no forged approvals); atomic-claim loop; incarnation recovery, never double-run | 14 |
| `telemetry` | (obs) | redaction inside the tracer; leaks impossible at the write boundary | 6 |
| `secret-store` | 08 | three fail-safe backends; encrypted file 0600, master key never colocated; wrong-key/tamper fail closed | 11 |
| `network` | 08 | one outbound broker; SSRF guard on direct AND redirect to loopback/metadata; body sanitized | 16 |

Apps advanced: `apps/cli` gained sessions (list/resume/fork/export, resume verified live); `apps/daemon`
got the single-writer lease + versioned Unix-socket protocol (SS-08), 5 tests over a real socket.

## Aggregate evidence

At the close of this phase: **~1170+ deterministic tests across ~95 files, plus 3 live tests
(provider smoke, coding loop, session resume)**, all passing. Every gate green: `format:check`,
`lint`, `typecheck` (whole graph), `architecture` (7 boundaries across 170+ files), `secrets:scan`.

Two tooling improvements were driven out by this phase:
- `gen-packages` now preserves hand-authored build scripts (it had been clobbering the tool-worker
  esbuild bundle under concurrent regeneration).
- the secret scanner's `sk-` rule requires a word boundary, so it no longer flags identifiers like
  `task-metadata-updated` while still catching a real in-repo key.

## Honest carry-forward

- `background`/`scheduler` persist durable job state through the existing `side-effect-intent/settled`
  ledger rather than a new protocol payload (the frozen protocol schema could not be extended by a
  sub-agent). Semantically sound; a dedicated payload would be a protocol v2 + storage migration.
- These rows are `IN_PROGRESS`, not `VERIFIED`: `VERIFIED` requires the full evidence set — the PTY
  (`T`), live (`L`), and cross-capability golden-path (`E`) classes — which are resolved together at
  checkpoint 10. No row is marked `VERIFIED` yet.

## Remaining

`mcp` and `tui-kit` (in flight), then the `apps/tui` Ink client and `apps/remote-worker` peer, then
checkpoint 09 (release hardening, full user docs, packaging PK-01/PK-02) and checkpoint 10 (the ten
golden paths + the full credentialed live suite + clean install).
