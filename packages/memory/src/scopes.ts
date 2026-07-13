/**
 * Memory scopes (MM-05).
 *
 * The product distinguishes FOUR durable memory scopes plus one ephemeral one, and each resolves to
 * a different directory. Getting the directory wrong is a data-leak or a data-loss bug, so the
 * mapping is explicit, injected (never reads ambient `process.env`/home directly — this package is
 * not `config`), and documented in README.md.
 *
 *   - `project`  cross-session memory for one repository, committed with it and shared by everyone
 *                who clones it. Lives inside the working tree.
 *   - `team`     team-shared memory: like `project` but a separate, explicitly team-owned tree so a
 *                solo note and a team-agreed convention are never confused.
 *   - `user`     cross-session memory for one human across every repository. XDG data home.
 *   - `auto`     machine-local memory the harness writes for itself. It is keyed by the CANONICAL
 *                repository so every git worktree of the same repo shares ONE auto store — a lesson
 *                learned in one worktree is available in its siblings. XDG state home.
 *   - `session`  survives compaction within a run but is NEVER persisted to disk (defaults.md). It
 *                has no directory; `resolveMemoryDir` returns `null` for it by design.
 *
 * XDG is respected: `user` uses `$XDG_DATA_HOME` (default `~/.local/share`) and `auto` uses
 * `$XDG_STATE_HOME` (default `~/.local/state`), because auto memory is regenerable machine state,
 * not portable user data.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export const MEMORY_SCOPES = ['project', 'team', 'user', 'auto', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Scopes whose memories are persisted to disk. `session` is deliberately excluded. */
export const PERSISTENT_SCOPES = ['project', 'team', 'user', 'auto'] as const satisfies readonly [
  ...MemoryScope[],
];

export function isPersistentScope(scope: MemoryScope): scope is (typeof PERSISTENT_SCOPES)[number] {
  return (PERSISTENT_SCOPES as readonly string[]).includes(scope);
}

/** The directory name the harness uses inside a repository for its own state. */
export const REPO_STATE_DIR = '.qwen-harness';
export const PROJECT_MEMORY_SUBDIR = 'memory';
export const TEAM_MEMORY_SUBDIR = 'team-memory';
/** Subpath under the XDG data/state root, shared by user and auto scopes. */
export const APP_DIR = 'qwen-harness';

export interface Env {
  readonly [key: string]: string | undefined;
}

export interface MemoryLocation {
  /** Absolute repository working-tree root. Required for `project` and `team`. */
  readonly projectRoot?: string;
  /**
   * Absolute path of the CANONICAL repository (the primary worktree / common git dir owner).
   * Required for `auto` so all worktrees of one repo key to the same store. When omitted for `auto`
   * it falls back to `projectRoot`.
   */
  readonly canonicalRepoRoot?: string;
  /** The user's home directory. Injected — this package never calls `os.homedir()`. */
  readonly homeDir?: string;
  /** Environment for XDG lookups. Injected — this package never reads `process.env` directly. */
  readonly env?: Env;
}

/** `$XDG_DATA_HOME` or `~/.local/share`. A relative XDG value is invalid and ignored (as in config). */
function xdgDataHome(env: Env, home: string): string {
  const xdg = env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) return xdg;
  return join(home, '.local', 'share');
}

/** `$XDG_STATE_HOME` or `~/.local/state`. */
function xdgStateHome(env: Env, home: string): string {
  const xdg = env['XDG_STATE_HOME'];
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) return xdg;
  return join(home, '.local', 'state');
}

/**
 * A stable, filesystem-safe key for a canonical repository. Worktrees of one repo share a canonical
 * root, so they hash to the same key and therefore the same auto-memory directory — which is exactly
 * the "shared by worktrees of one canonical repo" guarantee (MM-05), made mechanical.
 */
export function canonicalRepoKey(canonicalRepoRoot: string): string {
  return createHash('sha256').update(canonicalRepoRoot).digest('hex').slice(0, 16);
}

export class MemoryScopeError extends Error {
  readonly scope: MemoryScope;
  constructor(scope: MemoryScope, detail: string) {
    super(`cannot resolve ${scope} memory directory: ${detail}`);
    this.name = 'MemoryScopeError';
    this.scope = scope;
  }
}

/**
 * Resolve the directory a scope's memory files live in. Returns `null` for `session` (no directory
 * by design). Throws {@link MemoryScopeError} when a required input for a durable scope is missing —
 * a durable write with no home to write to must fail loudly, not silently drop the memory.
 */
export function resolveMemoryDir(scope: MemoryScope, loc: MemoryLocation): string | null {
  const env = loc.env ?? {};
  switch (scope) {
    case 'session':
      return null;

    case 'project': {
      if (!loc.projectRoot) throw new MemoryScopeError(scope, 'projectRoot is required');
      return join(loc.projectRoot, REPO_STATE_DIR, PROJECT_MEMORY_SUBDIR);
    }

    case 'team': {
      if (!loc.projectRoot) throw new MemoryScopeError(scope, 'projectRoot is required');
      return join(loc.projectRoot, REPO_STATE_DIR, TEAM_MEMORY_SUBDIR);
    }

    case 'user': {
      if (!loc.homeDir) throw new MemoryScopeError(scope, 'homeDir is required');
      return join(xdgDataHome(env, loc.homeDir), APP_DIR, PROJECT_MEMORY_SUBDIR);
    }

    case 'auto': {
      if (!loc.homeDir) throw new MemoryScopeError(scope, 'homeDir is required');
      const repo = loc.canonicalRepoRoot ?? loc.projectRoot;
      if (!repo) {
        throw new MemoryScopeError(scope, 'canonicalRepoRoot (or projectRoot) is required');
      }
      return join(xdgStateHome(env, loc.homeDir), APP_DIR, 'auto', canonicalRepoKey(repo));
    }
  }
}

/** Provenance carried on every retrieved/stored memory so `/memory` can audit its origin (MM-01). */
export interface MemoryProvenance {
  readonly scope: MemoryScope;
  /** Absolute path on disk, or a synthetic label for a `session`/in-memory memory. */
  readonly path: string;
}
