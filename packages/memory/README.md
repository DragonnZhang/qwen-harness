# @qwen-harness/memory

Long-term memory for the harness: Markdown files with validated YAML frontmatter, budgeted
retrieval, safe post-turn extraction, and Dream consolidation. Implements capability-matrix rows
**MM-01 … MM-06**.

This package is a declared **I/O owner** (`scripts/graph.ts`): memory FILES are Markdown on disk —
that is the product's memory format, not an implementation detail — so this package reads and writes
them. It may open only `node:fs`, `node:fs/promises`, and `node:path`.

## Document format (MM-01)

A memory is a Markdown file with a `---`-fenced YAML frontmatter block validated by a zod schema:

```markdown
---
name: prefers-pnpm
description: The user builds and tests with pnpm, never npm or yarn.
type: user
---
Always run `pnpm install` / `pnpm test`; npm lockfiles are not committed.
```

- `name` is a path-safe slug (also the file stem), `description` is a single line used for retrieval
  side-selection, and `type` is one of `user`, `feedback`, `project`, `reference`.
- Invalid frontmatter throws `MemoryFormatError`, which always **names the file**.
- `MEMORY.md` is the index. Startup loads only the **first 200 lines or 25 KiB, whichever comes
  first** (`loadMemoryIndex`); topic files load on demand through retrieval.

## Scopes (MM-05)

Five distinct scopes. `resolveMemoryDir(scope, location)` maps each to a directory (all inputs —
`homeDir`, `env` — are injected; this package never reads ambient `process.env` or `os.homedir()`).

| Scope     | Lives in                                              | Shared by                          | Persisted |
| --------- | ----------------------------------------------------- | ---------------------------------- | --------- |
| `project` | `<repo>/.qwen-harness/memory`                         | everyone who clones the repo       | yes       |
| `team`    | `<repo>/.qwen-harness/team-memory`                    | the team, explicitly               | yes       |
| `user`    | `$XDG_DATA_HOME/qwen-harness/memory` (`~/.local/share`)| one human, across all repos        | yes       |
| `auto`    | `$XDG_STATE_HOME/qwen-harness/auto/<repo-key>` (`~/.local/state`) | all **worktrees of one canonical repo** | yes (machine-local) |
| `session` | — (in memory only)                                    | one run                            | no (survives compaction only) |

**Auto memory is keyed by the canonical repository** (`canonicalRepoKey`, a hash of the canonical
repo root), so every git worktree of the same repo shares one auto store — a lesson learned in one
worktree is available in its siblings. `session` deliberately has no directory: it survives
compaction within a run but is never written to disk.

## Retrieval (MM-02)

`retrieve(query, candidates)` is two-stage and deterministic:

1. **Side-selection** — score each candidate by query-term overlap on `name` + `description` (cheap;
   no body read).
2. **Keyword fallback** — only when nothing matched on metadata, score on the body instead.

Budgets are hard: **at most 5 files and 50 KiB total** per turn. Provenance (scope + path) travels
with every result. Retrieval is **failure-isolated**: a body that cannot be read is recorded in
`skipped` and never aborts the whole retrieval.

## Extraction (MM-03)

`maybeExtract(outcome, options)` runs the deterministic gate around lesson extraction; the "is there
a lesson, and what is it" decision is **injected** as `propose` (a model or heuristic), so the gate
itself never invents a memory. It enforces:

- extraction only after a **naturally completed, non-cancelled** turn; otherwise a clean no-op;
- an empty proposal is a **no-op, not an error**;
- every candidate is run through the storage `Redactor`; a candidate that contained secret-shaped
  material is **rejected outright** (not stored, not even redacted) — a stored memory can never
  contain a secret;
- candidates are **deduplicated** against each other and the already-stored set.

## Dream consolidation (MM-04)

`consolidateMemories` (pure) deduplicates, resolves conflicts (newer wins; ties break to the more
specific memory) recording provenance, and retires stale content. `runDream` orchestrates the full
pass and enforces **exactly** the frozen gates from `docs/product/defaults.md`:

- **Eligibility** (`isDreamEligible`): eligible after **5 completed sessions OR 7 days** since the
  last consolidation, gated on **≥10 candidate memories OR ≥32 KiB** of candidate content, and run
  **at most once per 24 hours** per canonical repository.
- **Lock**: a **5-minute renewable lease**. **Wall limit**: 10 minutes; any step past it aborts
  without writing.
- **Model**: exactly **one** injected `summarize` call, input capped at **64K tokens**, output at
  **8K tokens**.
- **No write on failure**: the final memory set is re-validated against the schema; if anything
  fails, **nothing is written**.

## Atomic write & lock guarantee (MM-06)

Two mechanical guarantees back every memory write:

- **Atomic write** (`atomicWriteFile`): write to a unique temp file → `fsync` → `rename` over the
  target. `rename` within one directory is atomic on POSIX, so a reader sees either the old file or
  the whole new file — **never a partial one**. A crash between the temp-write and the rename leaves
  the **prior file intact** and orphans only the temp file. This is the property that lets a crashed
  or lease-lost Dream preserve the previous index.
- **Lease-based lock** (`FileLock`): a writer creates a lock file with `O_EXCL`. A second writer
  waits or, if the holder's **lease has expired** (a crash left the lock behind), **steals** it. The
  lease is renewable, so a long legitimate operation keeps its lock alive while a dead holder's lock
  becomes reclaimable. Two concurrent writers to one memory file therefore serialize; the last valid
  write wins and no writer ever observes corruption.

Redaction runs at this same storage boundary: `MemoryStore` can be constructed with a `Redactor`,
and every file it writes is redacted first, so a memory on disk cannot contain a secret even if an
upstream filter missed one.
