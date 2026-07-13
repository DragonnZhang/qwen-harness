import { z } from 'zod';

/**
 * The durable task state machine (WK-04). A task's lifecycle is validated as DATA — the legal
 * transitions live in a table so the machine is testable table-driven and an illegal transition is
 * rejected at the boundary instead of silently corrupting a task.
 *
 * States (WK-03):
 *   - pending      created, unowned, not started (all dependencies satisfied)
 *   - blocked      cannot start: at least one dependency is not yet completed
 *   - claimed      owned, not yet started
 *   - in-progress  owned, actively worked
 *   - completed    finished (terminal for work; may still be deleted)
 *   - released     was owned, returned to the pool — re-claimable (explicit release or owner-loss)
 *   - deleted      soft-deleted; retained for audit and to keep its id retired (terminal)
 */
export const TASK_STATUSES = [
  'pending',
  'blocked',
  'claimed',
  'in-progress',
  'completed',
  'released',
  'deleted',
] as const;

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Legal transitions, encoded as data. `A -> [B, C]` means a task in state A may move to B or C.
 *
 *   - Claiming enters from `pending` / `released` only — a `blocked` task is not claimable, which is
 *     precisely how "a task cannot begin until its dependencies complete" is enforced (WK-05).
 *   - `-> released` from `claimed` / `in-progress` is BOTH explicit release and owner-loss recovery
 *     (WK-04): losing an owner requeues the work rather than stranding it.
 *   - `-> blocked` from `pending` / `claimed` / `released` covers a dependency added after creation.
 *   - `deleted` is reachable from every non-deleted state (delete is always allowed) and is terminal.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['claimed', 'blocked', 'deleted'],
  blocked: ['pending', 'deleted'],
  claimed: ['in-progress', 'released', 'blocked', 'deleted'],
  'in-progress': ['completed', 'released', 'blocked', 'deleted'],
  completed: ['deleted'],
  released: ['claimed', 'blocked', 'deleted'],
  deleted: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** A task in one of these states is owned by an agent. */
export const OWNED_STATUSES = ['claimed', 'in-progress'] as const satisfies readonly TaskStatus[];

export function isOwned(status: TaskStatus): boolean {
  return (OWNED_STATUSES as readonly string[]).includes(status);
}

/** A task in one of these states can be picked up by a claimer (if its dependencies allow). */
export const CLAIMABLE_STATUSES = ['pending', 'released'] as const satisfies readonly TaskStatus[];

export function isClaimable(status: TaskStatus): boolean {
  return (CLAIMABLE_STATUSES as readonly string[]).includes(status);
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'deleted';
}
