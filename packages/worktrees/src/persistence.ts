import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { WorktreeError, type WorktreeOrigin, type WorktreeRecord } from './worktree.ts';

/**
 * Durable worktree persistence and recovery (GT-03).
 *
 * `createWorktree` performs the git side effect and returns an in-memory record; nothing about it
 * survives a crash. This module makes the record durable: the origin repo's cwd/branch/HEAD, the
 * worktree's own path/branch/base, the owner/session that created it, and a recovery state — all
 * written to `<repoRoot>/.qwen-harness/worktrees.json`. After a crash a fresh process reloads the
 * manifest and `reconcile` re-derives each record's recovery state from the filesystem, so an orphaned
 * checkout (its directory gone) is detected rather than silently forgotten.
 */

/** `active` — the checkout is present. `orphaned` — the record persists but its directory is gone. */
export type RecoveryState = 'active' | 'orphaned';

export interface PersistedWorktree {
  readonly slug: string;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
  readonly repoRoot: string;
  readonly createdAt: number;
  /** Origin repo state at creation (GT-03). */
  readonly origin: WorktreeOrigin;
  /** Who created the worktree — an agent, teammate, or session identity. */
  readonly owner: string;
  /** The session/thread the worktree belongs to. */
  readonly session: string;
  readonly recoveryState: RecoveryState;
  /**
   * OPTIONAL task binding (GT-05). A worktree may be associated with a task, but this is metadata on
   * the WORKTREE side only — it lives here, never on the task, so binding can never silently change a
   * task's state, and task ownership (the task graph) and workspace ownership (this manifest) stay
   * independently recoverable. Absent when the worktree is not bound to any task.
   */
  readonly boundTaskId?: number;
}

const MANIFEST_VERSION = 1;

function manifestPath(repoRoot: string): string {
  return join(repoRoot, '.qwen-harness', 'worktrees.json');
}

/** Build a durable record from a freshly-created worktree plus its owner/session and captured origin. */
export function toPersisted(
  record: WorktreeRecord,
  meta: {
    readonly origin: WorktreeOrigin;
    readonly owner: string;
    readonly session: string;
    /** Optional task binding (GT-05) — metadata only, never mirrored onto the task. */
    readonly boundTaskId?: number;
  },
): PersistedWorktree {
  return {
    slug: record.slug,
    path: record.path,
    branch: record.branch,
    base: record.base,
    repoRoot: record.repoRoot,
    createdAt: record.createdAt,
    origin: meta.origin,
    owner: meta.owner,
    session: meta.session,
    recoveryState: existsSync(record.path) ? 'active' : 'orphaned',
    ...(meta.boundTaskId !== undefined ? { boundTaskId: meta.boundTaskId } : {}),
  };
}

function isPersisted(value: unknown): value is PersistedWorktree {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const o = v['origin'] as Record<string, unknown> | undefined;
  return (
    typeof v['slug'] === 'string' &&
    typeof v['path'] === 'string' &&
    typeof v['branch'] === 'string' &&
    typeof v['base'] === 'string' &&
    typeof v['repoRoot'] === 'string' &&
    typeof v['createdAt'] === 'number' &&
    typeof v['owner'] === 'string' &&
    typeof v['session'] === 'string' &&
    (v['recoveryState'] === 'active' || v['recoveryState'] === 'orphaned') &&
    (v['boundTaskId'] === undefined || typeof v['boundTaskId'] === 'number') &&
    typeof o === 'object' &&
    o !== null &&
    typeof o['originalCwd'] === 'string' &&
    typeof o['originalBranch'] === 'string' &&
    typeof o['originalHead'] === 'string'
  );
}

/**
 * The durable manifest for one repository. A fresh instance reads whatever a previous process wrote,
 * which is exactly the restart path a recovery has to survive.
 */
export class WorktreeStore {
  readonly #path: string;

  constructor(repoRoot: string) {
    this.#path = manifestPath(repoRoot);
  }

  list(): PersistedWorktree[] {
    if (!existsSync(this.#path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch {
      throw new WorktreeError('git-failed', `worktree manifest is corrupt: ${this.#path}`);
    }
    const list = (parsed as { worktrees?: unknown })?.worktrees;
    if (!Array.isArray(list)) return [];
    // A malformed entry is dropped, never allowed to crash recovery of the others.
    return list.filter(isPersisted);
  }

  get(slug: string): PersistedWorktree | undefined {
    return this.list().find((w) => w.slug === slug);
  }

  /** Insert or replace the record for a slug. Ordering by slug keeps the manifest deterministic. */
  save(record: PersistedWorktree): void {
    const next = this.list().filter((w) => w.slug !== record.slug);
    next.push(record);
    next.sort((a, b) => a.slug.localeCompare(b.slug));
    this.#write(next);
  }

  remove(slug: string): void {
    this.#write(this.list().filter((w) => w.slug !== slug));
  }

  /**
   * Bind (or, with `null`, unbind) a worktree to a task (GT-05). This touches ONLY the worktree
   * manifest — the task graph is never read or written here — so a binding can never change a task's
   * state. Returns the updated record, or undefined if the slug is unknown.
   */
  bind(slug: string, taskId: number | null): PersistedWorktree | undefined {
    const current = this.get(slug);
    if (current === undefined) return undefined;
    // Rebuild without the old binding, then re-add it only when binding (not unbinding). Rebuilt
    // explicitly rather than by rest-destructuring so there is no dropped-variable to lint around.
    const updated: PersistedWorktree = {
      slug: current.slug,
      path: current.path,
      branch: current.branch,
      base: current.base,
      repoRoot: current.repoRoot,
      createdAt: current.createdAt,
      origin: current.origin,
      owner: current.owner,
      session: current.session,
      recoveryState: current.recoveryState,
      ...(taskId !== null ? { boundTaskId: taskId } : {}),
    };
    this.save(updated);
    return updated;
  }

  #write(worktrees: PersistedWorktree[]): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(
      this.#path,
      `${JSON.stringify({ version: MANIFEST_VERSION, worktrees }, null, 2)}\n`,
      'utf8',
    );
  }
}

/**
 * Re-derive every record's recovery state from the filesystem and persist the result (GT-03 recovery).
 * A record whose checkout directory is gone becomes `orphaned`; one whose directory is present becomes
 * `active`. Returns the reconciled records so a caller can act on the orphans.
 */
export function reconcile(store: WorktreeStore): PersistedWorktree[] {
  const reconciled = store.list().map((w) => ({
    ...w,
    recoveryState: (existsSync(w.path) ? 'active' : 'orphaned') as RecoveryState,
  }));
  for (const w of reconciled) store.save(w);
  return reconciled;
}
