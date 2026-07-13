import { harnessError, type Actor, type HarnessError } from '@qwen-harness/protocol';
import type { StoredTask, TaskEventRecord, TaskStore, TaskTx } from '@qwen-harness/storage';
import { z } from 'zod';

import {
  allBlockersCompleted,
  blockersOf,
  blocksOf,
  newlyUnblocked,
  wouldCreateCycle,
  type DepEdge,
} from './dependencies.ts';
import {
  canTransition,
  isClaimable,
  isOwned,
  TaskStatusSchema,
  type TaskStatus,
} from './state-machine.ts';

/**
 * The durable dependency task graph (WK-03..WK-08). It is the DOMAIN half of the task system: it
 * decides what is legal (the state machine, dependency rules, atomic claiming) and drives the
 * storage {@link TaskStore} to persist those decisions. Storage owns SQLite and the projection;
 * this layer owns the rules and never touches a database handle directly.
 *
 * It is a completely separate system from the turn-local {@link TodoList}: a todo change touches
 * nothing here, and nothing here writes a todo (WK-01/WK-02).
 */

export interface Task {
  readonly id: number;
  readonly subject: string;
  readonly description: string;
  readonly activeForm: string;
  readonly owner: string | null;
  readonly status: TaskStatus;
  /** Tasks that are waiting on this one. Derived from the edge set — a single source of truth. */
  readonly blocks: readonly number[];
  /** Tasks that must complete before this one may begin. */
  readonly blockedBy: readonly number[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Who created the task (audit provenance, WK-03). */
  readonly createdBy: Actor;
}

export const CreateTaskInputSchema = z.object({
  subject: z.string().min(1),
  description: z.string().default(''),
  activeForm: z.string().min(1),
  /** Existing tasks that must complete before this one begins. */
  blockedBy: z.array(z.number().int().nonnegative()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;

const OwnerSchema = z.string().min(1).max(200);

/** The outcome of an atomic claim (WK-06). A failed claim is data, not an exception. */
export type ClaimResult =
  { readonly ok: true; readonly task: Task } | { readonly ok: false; readonly reason: string };

export interface CompleteResult {
  readonly task: Task;
  /** Exactly the downstream tasks that became runnable because this one completed (WK-05). */
  readonly newlyUnblocked: readonly Task[];
}

/** A committed task event, exposed so hooks and the TUI consume the SAME events (WK-08). */
export type TaskGraphListener = (event: TaskEventRecord) => void;

/** A dependency is satisfied once its blocker is completed — or deleted (it can never complete). */
function isSatisfied(status: string): boolean {
  return status === 'completed' || status === 'deleted';
}

export class TaskGraph {
  readonly #store: TaskStore;
  readonly #listeners = new Set<TaskGraphListener>();

  constructor(opts: { store: TaskStore }) {
    this.#store = opts.store;
  }

  /**
   * Subscribe to committed task events (WK-08). The callback fires AFTER the transaction commits,
   * in event order, so a listener never observes a state that a rollback later erased.
   */
  subscribe(listener: TaskGraphListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(records: readonly TaskEventRecord[]): void {
    for (const record of records) {
      for (const listener of this.#listeners) listener(record);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  get(id: number): Task | undefined {
    const stored = this.#store.getTask(id);
    if (!stored) return undefined;
    return toTask(stored, this.#store.listDeps());
  }

  list(opts: { includeDeleted?: boolean } = {}): Task[] {
    const edges = this.#store.listDeps();
    return this.#store
      .listTasks(opts.includeDeleted ?? false)
      .map((stored) => toTask(stored, edges));
  }

  /** The next id a created task will receive — proves ids only ever climb (WK-07). */
  highWater(): number {
    return this.#store.highWater();
  }

  // -------------------------------------------------------------------------
  // Create / link
  // -------------------------------------------------------------------------

  create(input: CreateTaskInput, actor: Actor): Task {
    const parsed = CreateTaskInputSchema.parse(input);
    const blockedBy = [...new Set(parsed.blockedBy)];

    const { task, records } = this.#store.transact((tx) => {
      // Missing-reference check: every declared blocker must exist and not be deleted (WK-05).
      for (const blockerId of blockedBy) {
        const blocker = tx.getTask(blockerId);
        if (!blocker || blocker.status === 'deleted') {
          throw missingReference(blockerId);
        }
      }

      const id = tx.allocateId();

      // A fresh node has no outgoing edges, so blockedBy alone cannot create a cycle. We still run
      // the full check defensively against the resulting edge set (WK-05).
      const edges: DepEdge[] = [
        ...tx.listDeps(),
        ...blockedBy.map((blockerId) => ({ blockerId, blockedId: id })),
      ];
      if (blockedBy.some((blockerId) => wouldCreateCycle(tx.listDeps(), blockerId, id))) {
        throw cycleRejected(edges);
      }

      // Initial status: blocked unless every blocker is already satisfied (WK-05).
      const satisfied = blockedBy.every((blockerId) =>
        isSatisfied(tx.getTask(blockerId)?.status ?? ''),
      );
      const status: TaskStatus = blockedBy.length === 0 || satisfied ? 'pending' : 'blocked';

      const record = tx.emit({
        type: 'task-created',
        taskId: id,
        actor,
        subject: parsed.subject,
        description: parsed.description,
        activeForm: parsed.activeForm,
        status,
        metadata: parsed.metadata,
        blockedBy,
      });

      const stored = tx.getTask(id);
      if (!stored) throw invariant('created task is missing from its own projection');
      return { task: toTask(stored, tx.listDeps()), records: [record] };
    });

    this.#notify(records);
    return task;
  }

  /**
   * Add a dependency between two existing tasks (WK-05 link-time). Rejects missing references and
   * any edge that would close a cycle, re-reading the graph inside the transaction so the decision
   * is made against committed state.
   */
  addDependency(blockerId: number, blockedId: number, actor: Actor): Task {
    const { task, records } = this.#store.transact((tx) => {
      const blocker = tx.getTask(blockerId);
      const blocked = tx.getTask(blockedId);
      if (!blocker || blocker.status === 'deleted') throw missingReference(blockerId);
      if (!blocked || blocked.status === 'deleted') throw missingReference(blockedId);

      if (wouldCreateCycle(tx.listDeps(), blockerId, blockedId)) {
        throw cycleRejected([...tx.listDeps(), { blockerId, blockedId }]);
      }

      const records: TaskEventRecord[] = [
        tx.emit({
          type: 'task-dependency-added',
          taskId: blockedId,
          actor,
          blockerId,
          blockedId,
        }),
      ];

      // A new incomplete blocker sends a not-yet-owned downstream task back to `blocked` (WK-05).
      const status = blocked.status as TaskStatus;
      if ((status === 'pending' || status === 'released') && !isSatisfied(blocker.status)) {
        records.push(this.#transition(tx, blockedId, 'blocked', actor));
      }

      const stored = tx.getTask(blockedId);
      if (!stored) throw invariant('task vanished during dependency add');
      return { task: toTask(stored, tx.listDeps()), records };
    });

    this.#notify(records);
    return task;
  }

  // -------------------------------------------------------------------------
  // Atomic claiming (WK-06)
  // -------------------------------------------------------------------------

  /**
   * Atomically claim a task for `owner`. The read of the current owner and the conditional write
   * happen inside ONE SQLite transaction, so two agents racing for the same task cannot both win:
   * the second attempt re-reads an already-owned task and fails (WK-06). A failed claim returns
   * `{ ok: false }` rather than throwing — losing a race is normal, not exceptional.
   */
  claim(id: number, owner: string, actor: Actor): ClaimResult {
    const ownerId = OwnerSchema.parse(owner);

    const result = this.#store.transact<{ result: ClaimResult; records: TaskEventRecord[] }>(
      (tx) => {
        const stored = tx.getTask(id);
        if (!stored)
          return { result: { ok: false, reason: `task ${id} does not exist` }, records: [] };

        const status = stored.status as TaskStatus;
        // The TOCTOU-critical re-read: only claim if STILL unowned and claimable.
        if (stored.owner !== null) {
          return {
            result: { ok: false, reason: `task ${id} is already owned by ${stored.owner}` },
            records: [],
          };
        }
        if (!isClaimable(status)) {
          return {
            result: { ok: false, reason: `task ${id} is ${status}, not claimable` },
            records: [],
          };
        }

        const record = tx.emit({ type: 'task-claimed', taskId: id, actor, owner: ownerId });
        const next = tx.getTask(id);
        if (!next) throw invariant('claimed task vanished');
        return { result: { ok: true, task: toTask(next, tx.listDeps()) }, records: [record] };
      },
    );

    this.#notify(result.records);
    return result.result;
  }

  // -------------------------------------------------------------------------
  // Lifecycle transitions (WK-04)
  // -------------------------------------------------------------------------

  /** Begin work: claimed -> in-progress. Rejects if any dependency is still incomplete (WK-05). */
  start(id: number, actor: Actor): Task {
    return this.#simpleTransition(id, 'in-progress', actor, (tx) => {
      const edges = tx.listDeps();
      const satisfied = allBlockersCompleted(edges, id, (b) =>
        isSatisfied(tx.getTask(b)?.status ?? ''),
      );
      if (!satisfied) {
        throw taskError(
          'user',
          'tasks.blocked',
          `task ${id} cannot start: dependencies incomplete`,
        );
      }
    });
  }

  /** Return an owned task to the pool (explicit release OR owner-loss recovery, WK-04). */
  release(id: number, actor: Actor): Task {
    const { task, records } = this.#store.transact((tx) => {
      const stored = tx.getTask(id);
      if (!stored) throw missingReference(id);
      const status = stored.status as TaskStatus;
      if (!isOwned(status)) {
        throw illegalTransition(status, 'released');
      }
      const record = tx.emit({ type: 'task-released', taskId: id, actor });
      return { task: this.#readback(tx, id), records: [record] };
    });
    this.#notify(records);
    return task;
  }

  /**
   * Owner-loss recovery (WK-04). A teammate that lost its heartbeat has its owned task requeued
   * rather than stranded — mechanically identical to {@link release}, named for the caller's intent.
   */
  recoverOwnerLoss(id: number, actor: Actor): Task {
    return this.release(id, actor);
  }

  /** Complete an in-progress task and report exactly what it unblocked (WK-05). */
  complete(id: number, actor: Actor): CompleteResult {
    const { result, records } = this.#store.transact((tx) => {
      const stored = tx.getTask(id);
      if (!stored) throw missingReference(id);
      const status = stored.status as TaskStatus;
      if (!canTransition(status, 'completed')) throw illegalTransition(status, 'completed');

      const records: TaskEventRecord[] = [this.#transition(tx, id, 'completed', actor)];
      const unblocked = this.#unblockDownstream(tx, id, actor, records);

      return {
        result: {
          task: this.#readback(tx, id),
          newlyUnblocked: unblocked,
        },
        records,
      };
    });
    this.#notify(records);
    return result;
  }

  /** Soft-delete a task. The id is retained and never reused (WK-07); downstream may unblock. */
  delete(id: number, actor: Actor): { task: Task; newlyUnblocked: readonly Task[] } {
    const { result, records } = this.#store.transact((tx) => {
      const stored = tx.getTask(id);
      if (!stored) throw missingReference(id);
      if (stored.status === 'deleted') throw illegalTransition('deleted', 'deleted');

      const records: TaskEventRecord[] = [tx.emit({ type: 'task-deleted', taskId: id, actor })];
      // A deleted blocker can never complete, so downstream tasks waiting only on it become runnable.
      const unblocked = this.#unblockDownstream(tx, id, actor, records);

      return { result: { task: this.#readback(tx, id), newlyUnblocked: unblocked }, records };
    });
    this.#notify(records);
    return result;
  }

  /** Replace a task's metadata. */
  setMetadata(id: number, metadata: Record<string, unknown>, actor: Actor): Task {
    const { task, records } = this.#store.transact((tx) => {
      const stored = tx.getTask(id);
      if (!stored) throw missingReference(id);
      if (stored.status === 'deleted') throw illegalTransition('deleted', 'deleted');
      const record = tx.emit({ type: 'task-metadata-updated', taskId: id, actor, metadata });
      return { task: this.#readback(tx, id), records: [record] };
    });
    this.#notify(records);
    return task;
  }

  /**
   * Rebuild the projection from the task log and confirm it survives (WK-07). Delegates to storage,
   * which replays `task_events` in one transaction. Exposed here so the domain owns the operation
   * its crash-survival tests exercise.
   */
  rebuild(): { events: number } {
    return this.#store.rebuildProjection();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A status-only transition, validated against the state machine before it is emitted (WK-04). */
  #simpleTransition(id: number, to: TaskStatus, actor: Actor, guard?: (tx: TaskTx) => void): Task {
    const { task, records } = this.#store.transact((tx) => {
      const stored = tx.getTask(id);
      if (!stored) throw missingReference(id);
      const from = stored.status as TaskStatus;
      if (!canTransition(from, to)) throw illegalTransition(from, to);
      guard?.(tx);
      const record = this.#transition(tx, id, to, actor);
      return { task: this.#readback(tx, id), records: [record] };
    });
    this.#notify(records);
    return task;
  }

  /** Emit a validated status change. Caller has already checked legality. */
  #transition(tx: TaskTx, id: number, to: TaskStatus, actor: Actor): TaskEventRecord {
    return tx.emit({
      type: 'task-status-changed',
      taskId: id,
      actor,
      status: TaskStatusSchema.parse(to),
    });
  }

  /** After `id` is completed/deleted, flip every now-runnable downstream task blocked -> pending. */
  #unblockDownstream(tx: TaskTx, id: number, actor: Actor, records: TaskEventRecord[]): Task[] {
    const edges = tx.listDeps();
    const ids = newlyUnblocked(
      edges,
      id,
      (t) => (tx.getTask(t)?.status ?? '') === 'blocked',
      (t) => isSatisfied(tx.getTask(t)?.status ?? ''),
    );
    const unblocked: Task[] = [];
    for (const downstreamId of ids) {
      records.push(this.#transition(tx, downstreamId, 'pending', actor));
      unblocked.push(this.#readback(tx, downstreamId));
    }
    return unblocked;
  }

  #readback(tx: TaskTx, id: number): Task {
    const stored = tx.getTask(id);
    if (!stored) throw invariant(`task ${id} vanished mid-transaction`);
    return toTask(stored, tx.listDeps());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTask(stored: StoredTask, edges: readonly DepEdge[]): Task {
  return {
    id: stored.id,
    subject: stored.subject,
    description: stored.description,
    activeForm: stored.activeForm,
    owner: stored.owner,
    status: TaskStatusSchema.parse(stored.status),
    blocks: blocksOf(edges, stored.id),
    blockedBy: blockersOf(edges, stored.id),
    metadata: stored.metadata,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    createdBy: stored.createdBy,
  };
}

function taskError(origin: 'user' | 'internal', category: string, message: string): HarnessError {
  return harnessError({ origin, category, message });
}

function missingReference(id: number): HarnessError {
  return taskError('user', 'tasks.missing_reference', `task ${id} does not exist`);
}

function illegalTransition(from: string, to: string): HarnessError {
  return taskError('user', 'tasks.illegal_transition', `illegal task transition: ${from} -> ${to}`);
}

function cycleRejected(edges: readonly DepEdge[]): HarnessError {
  return taskError(
    'user',
    'tasks.cycle',
    `dependency would create a cycle among tasks: ${edges
      .map((e) => `${e.blockerId}->${e.blockedId}`)
      .join(', ')}`,
  );
}

function invariant(message: string): HarnessError {
  return taskError('internal', 'tasks.invariant', message);
}
