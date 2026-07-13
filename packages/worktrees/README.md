# @qwen-harness/worktrees

Git worktree isolation (section K). A worktree gives an agent or teammate its own checked-out branch
of the same repository, so concurrent work never collides in one directory. This package owns the
git-worktree lifecycle (an `IO_OWNERS` entry) and nothing else.

## The guarantee that matters

**Removal refuses dirty or unmerged work by default.** Discarding requires an explicit `discard:
true` and returns an audit record of exactly what was thrown away (GT-04). Losing a teammate's
uncommitted or unmerged work silently is the failure this exists to prevent — verified by tests that
create real dirty/unmerged worktrees and confirm removal is refused until forced.

## Safety

- Slugs are validated (`[a-z0-9][a-z0-9_-]{0,63}`) — no slashes, dots, or traversal (GT-01). The
  checkout path is always under a controlled directory, never a caller-supplied absolute path, and
  containment is re-verified after resolution.
- Every `git` call neutralizes global/system config and hooks, so a worktree operation can never
  execute code a malicious repository chose.
- A slug or branch collision is refused, never silently reused.

Tested with real git worktrees against a real fixture repo — the only honest way to verify worktree
behavior.
