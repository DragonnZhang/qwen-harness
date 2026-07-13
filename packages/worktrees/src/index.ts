/**
 * @qwen-harness/worktrees
 *
 * Git worktree isolation (section K). A worktree gives an agent or teammate its own checked-out
 * branch of the same repository, so concurrent work does not collide in one directory. This package
 * owns the git-worktree lifecycle (an IO_OWNERS entry) and nothing else.
 *
 * The rule that matters most: removal REFUSES dirty or unmerged work by default. Discarding requires
 * an explicit flag and produces an audit record — losing a teammate's work silently is exactly what
 * this guards against.
 */

export {
  createWorktree,
  removeWorktree,
  listWorktrees,
  isWorktreeDirty,
  hasUnmergedCommits,
  validateSlug,
  tempWorktreesDir,
  WorktreeError,
} from './worktree.ts';
export type {
  WorktreeRecord,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  RemoveResult,
} from './worktree.ts';
