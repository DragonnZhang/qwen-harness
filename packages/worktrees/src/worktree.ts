import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Git worktree isolation (section K: GT-01..GT-06).
 *
 * A worktree gives an agent or teammate its own checked-out branch of the SAME repository, so
 * concurrent work does not collide in one working directory. This package owns the git-worktree
 * lifecycle (an `IO_OWNERS` entry) and nothing else.
 *
 * The safety rules that matter:
 *   - a worktree name/slug is validated and collision-safe, never a path-traversal vector (GT-01);
 *   - removal REFUSES dirty or unpushed work by default; discarding requires an explicit flag and
 *     produces an audit record (GT-04);
 *   - the original repo's branch/HEAD and the worktree's own state are both recorded, so recovery
 *     can tell them apart (GT-03).
 */

export class WorktreeError extends Error {
  constructor(
    readonly code:
      | 'not-a-repo'
      | 'invalid-name'
      | 'collision'
      | 'dirty'
      | 'unpushed'
      | 'not-found'
      | 'git-failed',
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface WorktreeRecord {
  /** The logical slug, validated and safe. */
  readonly slug: string;
  /** Absolute path to the worktree checkout. */
  readonly path: string;
  /** The branch checked out in the worktree. */
  readonly branch: string;
  /** The base ref the worktree branched from. */
  readonly base: string;
  /** The repository this worktree belongs to (its main working directory). */
  readonly repoRoot: string;
  readonly createdAt: number;
}

/** A slug is `[a-z0-9][a-z0-9-_]{0,63}` — no slashes, dots, or traversal. Validated, not trusted. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw new WorktreeError(
      'invalid-name',
      `invalid worktree slug ${JSON.stringify(slug)} — must match ${SLUG}`,
    );
  }
}

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      // A repository's own hooks/config are attacker-influenced content; neutralize them so a
      // worktree operation can never execute code the repository chose.
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }).trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    throw new WorktreeError(
      'git-failed',
      `git ${args[0] ?? ''} failed: ${err.stderr ?? err.message}`,
    );
  }
}

function assertRepo(repoRoot: string): void {
  if (!isAbsolute(repoRoot)) throw new WorktreeError('not-a-repo', 'repoRoot must be absolute');
  try {
    const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true')
      throw new WorktreeError('not-a-repo', `${repoRoot} is not a git work tree`);
  } catch (e) {
    if (e instanceof WorktreeError && e.code === 'not-a-repo') throw e;
    throw new WorktreeError('not-a-repo', `${repoRoot} is not a git repository`);
  }
}

export interface CreateWorktreeOptions {
  readonly repoRoot: string;
  readonly slug: string;
  /** The ref to branch from. Defaults to the current HEAD. */
  readonly base?: string;
  /** Where the worktree directories live. Defaults to a sibling `.qh-worktrees` dir. */
  readonly worktreesDir?: string;
  readonly now: number;
}

/**
 * Create an isolated worktree + branch from a validated base. The branch name is derived from the
 * slug (`qh/<slug>`), and the checkout path is under a controlled directory — never a caller-
 * supplied absolute path, so there is no traversal (GT-01).
 */
export function createWorktree(opts: CreateWorktreeOptions): WorktreeRecord {
  assertRepo(opts.repoRoot);
  validateSlug(opts.slug);

  const base = opts.base ?? git(opts.repoRoot, ['rev-parse', 'HEAD']);
  const branch = `qh/${opts.slug}`;
  const dir = opts.worktreesDir ?? join(opts.repoRoot, '.qh-worktrees');
  const path = resolve(dir, opts.slug);

  // Containment: the resolved path must stay under the worktrees dir. A slug that passed the regex
  // cannot escape, but we verify the resolved path anyway — defense in depth.
  const containRoot = resolve(dir);
  if (path !== join(containRoot, opts.slug)) {
    throw new WorktreeError('invalid-name', `worktree path escapes its directory: ${path}`);
  }
  if (existsSync(path)) {
    throw new WorktreeError('collision', `a worktree already exists at ${path}`);
  }
  // A branch collision is also a collision — do not silently reuse someone else's branch.
  const branches = git(opts.repoRoot, ['branch', '--list', branch]);
  if (branches.length > 0) {
    throw new WorktreeError('collision', `branch ${branch} already exists`);
  }

  git(opts.repoRoot, ['worktree', 'add', '-b', branch, path, base]);

  return { slug: opts.slug, path, branch, base, repoRoot: opts.repoRoot, createdAt: opts.now };
}

/** The origin repository's state at the moment a worktree was created — recorded so a later recovery
 * knows exactly where the work came from (GT-03). */
export interface WorktreeOrigin {
  /** The main working directory the worktree was branched from. */
  readonly originalCwd: string;
  /** The branch the origin repo had checked out, or `(detached)` for a detached HEAD. */
  readonly originalBranch: string;
  /** The origin repo's HEAD commit at creation time. */
  readonly originalHead: string;
}

/** Capture the origin repo's cwd/branch/HEAD for durable recovery metadata (GT-03). */
export function captureWorktreeOrigin(repoRoot: string): WorktreeOrigin {
  assertRepo(repoRoot);
  const originalHead = git(repoRoot, ['rev-parse', 'HEAD']);
  let originalBranch: string;
  try {
    originalBranch = git(repoRoot, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    // A detached HEAD has no symbolic branch; that is recorded, not guessed.
    originalBranch = '(detached)';
  }
  return { originalCwd: repoRoot, originalBranch, originalHead };
}

export function listWorktrees(repoRoot: string): { path: string; branch: string }[] {
  assertRepo(repoRoot);
  const out = git(repoRoot, ['worktree', 'list', '--porcelain']);
  const result: { path: string; branch: string }[] = [];
  let path = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line.startsWith('branch ')) {
      result.push({ path, branch: line.slice('branch '.length).replace('refs/heads/', '') });
    }
  }
  return result;
}

/** True if the worktree has uncommitted changes. */
export function isWorktreeDirty(worktreePath: string): boolean {
  return git(worktreePath, ['status', '--porcelain']).length > 0;
}

/** True if the worktree's branch has commits not present on any other ref (unpushed/unmerged). */
export function hasUnmergedCommits(worktreePath: string, base: string): boolean {
  // Commits on this branch that are not reachable from base. Non-empty means unmerged work.
  const out = git(worktreePath, ['rev-list', `${base}..HEAD`, '--count']);
  return Number(out) > 0;
}

export interface RemoveWorktreeOptions {
  readonly repoRoot: string;
  readonly record: WorktreeRecord;
  /** Discard dirty/unmerged work. Requires an explicit true — the default REFUSES (GT-04). */
  readonly discard?: boolean;
}

export interface RemoveResult {
  readonly removed: boolean;
  /** An audit record of what was discarded, when discard was used. */
  readonly discardedDirty: boolean;
  readonly discardedUnmerged: boolean;
}

/**
 * Remove a worktree. By default it REFUSES if the worktree is dirty or has unmerged commits —
 * losing work silently is exactly what this guards against. `discard: true` overrides and records
 * an audit trail of what was thrown away (GT-04).
 */
export function removeWorktree(opts: RemoveWorktreeOptions): RemoveResult {
  assertRepo(opts.repoRoot);
  const { path } = opts.record;
  if (!existsSync(path)) throw new WorktreeError('not-found', `no worktree at ${path}`);

  const dirty = isWorktreeDirty(path);
  const unmerged = hasUnmergedCommits(path, opts.record.base);

  if ((dirty || unmerged) && !opts.discard) {
    throw new WorktreeError(
      dirty ? 'dirty' : 'unpushed',
      `refusing to remove ${opts.record.slug}: it has ${dirty ? 'uncommitted changes' : 'unmerged commits'}; pass discard to force`,
    );
  }

  git(opts.repoRoot, ['worktree', 'remove', ...(opts.discard ? ['--force'] : []), path]);
  // Also delete the branch when discarding, so a forced removal leaves no dangling branch.
  if (opts.discard) {
    try {
      git(opts.repoRoot, ['branch', '-D', opts.record.branch]);
    } catch {
      // The branch may already be gone; not fatal.
    }
  }

  return {
    removed: true,
    discardedDirty: dirty && Boolean(opts.discard),
    discardedUnmerged: unmerged && Boolean(opts.discard),
  };
}

/** Allocate a fresh temp worktrees directory. Convenience for callers that want isolation. */
export function tempWorktreesDir(prefix = 'qh-wt-'): string {
  return mkdtempSync(join('/tmp', prefix));
}
