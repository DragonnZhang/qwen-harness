import type { Actor, Clock } from '@qwen-harness/protocol';

import type { EventStore } from './event-store.ts';

/**
 * Durable task-graph persistence (capability matrix E). This is the STORAGE half of the task
 * system: it owns SQLite and does exactly what storage is allowed to do — persist an append-only
 * `task_events` log and project it into `task_nodes` / `task_deps`, atomically. It contains NO
 * domain policy: it does not know which status transitions are legal, what a dependency cycle is,
 * or when a task becomes runnable. Those decisions live in `@qwen-harness/tasks`, which drives this
 * store through {@link TaskStore.transact} so that its read-decide-write happens INSIDE one SQLite
 * transaction (the TOCTOU guard for atomic claiming, WK-06).
 *
 * Splitting it this way keeps the boundary honest: `tasks` never imports `better-sqlite3` (the
 * architecture gate forbids it), and `storage` never encodes task rules. The event is validated by
 * the domain layer BEFORE it is emitted; this layer only records and projects an already-legal one.
 */

/** A task's projected state — plain data, never a database handle. Numeric high-water id (WK-03). */
export interface StoredTask {
  readonly id: number;
  readonly subject: string;
  readonly description: string;
  readonly activeForm: string;
  readonly owner: string | null;
  readonly status: string;
  readonly metadata: Record<string, unknown>;
  /** Bumped on every mutation. The optimistic token a claimer re-reads inside the write tx. */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Audit provenance: who created the task (WK-03). */
  readonly createdBy: Actor;
}

/** One dependency edge: `blockerId` must complete before `blockedId` may begin. */
export interface StoredTaskDep {
  readonly blockerId: number;
  readonly blockedId: number;
}

/** A recorded task-log entry, in append order. Used for rebuild and audit. */
export interface TaskEventRecord {
  readonly seq: number;
  readonly taskId: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly actor: Actor;
  readonly timestamp: number;
}

/**
 * The semantic task events. A faithful log: the projection is a pure fold of these, so a rebuild
 * lands byte-identically (WK-07). `status` on `task-created` / `task-status-changed` is supplied by
 * the domain layer — storage does not compute it, it records the decision.
 */
export type TaskEventInput =
  | {
      readonly type: 'task-created';
      readonly taskId: number;
      readonly actor: Actor;
      readonly subject: string;
      readonly description: string;
      readonly activeForm: string;
      readonly status: string;
      readonly metadata: Record<string, unknown>;
      readonly blockedBy: readonly number[];
    }
  | {
      readonly type: 'task-claimed';
      readonly taskId: number;
      readonly actor: Actor;
      readonly owner: string;
    }
  | { readonly type: 'task-released'; readonly taskId: number; readonly actor: Actor }
  | {
      readonly type: 'task-status-changed';
      readonly taskId: number;
      readonly actor: Actor;
      readonly status: string;
    }
  | { readonly type: 'task-deleted'; readonly taskId: number; readonly actor: Actor }
  | {
      readonly type: 'task-metadata-updated';
      readonly taskId: number;
      readonly actor: Actor;
      readonly metadata: Record<string, unknown>;
    }
  | {
      readonly type: 'task-dependency-added';
      readonly taskId: number;
      readonly actor: Actor;
      readonly blockerId: number;
      readonly blockedId: number;
    };

/**
 * The transaction context handed to a {@link TaskStore.transact} mutator. Reads reflect state
 * INSIDE the open transaction; {@link emit} appends a task event and applies its projection in the
 * same transaction. A mutator that throws rolls the whole thing back — log and projection stay in
 * agreement (there is never an event without its projection, WK-07).
 */
export interface TaskTx {
  getTask(id: number): StoredTask | undefined;
  listTasks(includeDeleted?: boolean): StoredTask[];
  listDeps(): StoredTaskDep[];
  /** Allocate the next high-water id and persist the advanced mark. Never reuses a value (WK-07). */
  allocateId(): number;
  /** Append the event to the log and project it. Returns the recorded entry. */
  emit(event: TaskEventInput): TaskEventRecord;
  /** Drop the projection (NOT the log, NOT the high-water mark). Used only by rebuild. */
  clearProjection(): void;
}

interface TaskNodeRow {
  id: number;
  subject: string;
  description: string;
  active_form: string;
  owner: string | null;
  status: string;
  metadata: string;
  version: number;
  created_at: number;
  updated_at: number;
  created_by_kind: string;
  created_by_id: string;
  created_by_label: string | null;
}

interface TaskEventRow {
  seq: number;
  task_id: number;
  type: string;
  payload: string;
  actor_kind: string;
  actor_id: string;
  actor_label: string | null;
  timestamp: number;
}

function rowToStoredTask(row: TaskNodeRow): StoredTask {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    activeForm: row.active_form,
    owner: row.owner,
    status: row.status,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: rowActor(row.created_by_kind, row.created_by_id, row.created_by_label),
  };
}

function rowActor(kind: string, id: string, label: string | null): Actor {
  const actor = { kind, id } as Actor;
  return label === null ? actor : { ...actor, label };
}

export interface TaskStoreOptions {
  readonly store: EventStore;
  readonly clock: Clock;
}

/**
 * Persistence and projection for the durable task graph. Shares the {@link EventStore}'s single
 * SQLite connection, so task writes and the main event log are serialized by the same writer and
 * governed by the same WAL durability — one database, one source of truth on disk.
 */
export class TaskStore {
  readonly #db: EventStore['db'];
  readonly #clock: Clock;

  constructor(opts: TaskStoreOptions) {
    this.#db = opts.store.db;
    this.#clock = opts.clock;
  }

  /** The shared SQLite handle, exposed for inspection and tests (mirrors {@link EventStore.db}). */
  get db(): EventStore['db'] {
    return this.#db;
  }

  /**
   * Runs `fn` inside one SQLite transaction. The mutator reads current state through the context
   * and emits events; everything commits together or not at all. This is the primitive the domain
   * layer uses for atomic claiming — the re-read and the conditional write share the transaction,
   * so no second writer can slip between them (WK-06).
   */
  transact<T>(fn: (tx: TaskTx) => T): T {
    const tx = this.#db.transaction((): T => fn(this.#context()));
    return tx();
  }

  #context(): TaskTx {
    const db = this.#db;
    const clock = this.#clock;
    return {
      getTask: (id) => this.getTask(id),
      listTasks: (includeDeleted = false) => this.listTasks(includeDeleted),
      listDeps: () => this.listDeps(),
      allocateId(): number {
        const row = db.prepare('SELECT next_id FROM task_high_water WHERE id = 0').get() as {
          next_id: number;
        };
        const id = row.next_id;
        db.prepare('UPDATE task_high_water SET next_id = ? WHERE id = 0').run(id + 1);
        return id;
      },
      emit: (event) => applyEvent(db, clock.now(), event),
      clearProjection(): void {
        db.exec('DELETE FROM task_deps; DELETE FROM task_nodes;');
      },
    };
  }

  getTask(id: number): StoredTask | undefined {
    const row = this.#db.prepare('SELECT * FROM task_nodes WHERE id = ?').get(id) as
      TaskNodeRow | undefined;
    return row ? rowToStoredTask(row) : undefined;
  }

  listTasks(includeDeleted = false): StoredTask[] {
    const sql = includeDeleted
      ? 'SELECT * FROM task_nodes ORDER BY id'
      : "SELECT * FROM task_nodes WHERE status <> 'deleted' ORDER BY id";
    return (this.#db.prepare(sql).all() as TaskNodeRow[]).map(rowToStoredTask);
  }

  listDeps(): StoredTaskDep[] {
    const rows = this.#db
      .prepare('SELECT blocker_id, blocked_id FROM task_deps ORDER BY blocker_id, blocked_id')
      .all() as { blocker_id: number; blocked_id: number }[];
    return rows.map((r) => ({ blockerId: r.blocker_id, blockedId: r.blocked_id }));
  }

  /** The current high-water mark: the id the NEXT created task will receive. */
  highWater(): number {
    const row = this.#db.prepare('SELECT next_id FROM task_high_water WHERE id = 0').get() as {
      next_id: number;
    };
    return row.next_id;
  }

  /** The full task log, in append order. Optionally scoped to one task. */
  readEvents(taskId?: number): TaskEventRecord[] {
    const rows = (
      taskId === undefined
        ? this.#db.prepare('SELECT * FROM task_events ORDER BY seq').all()
        : this.#db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY seq').all(taskId)
    ) as TaskEventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      taskId: r.task_id,
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      actor: rowActor(r.actor_kind, r.actor_id, r.actor_label),
      timestamp: r.timestamp,
    }));
  }

  /**
   * Rebuilds `task_nodes` / `task_deps` by replaying `task_events` (WK-07 crash survival). Runs in
   * one transaction so a crash mid-rebuild rolls back rather than leaving a half-truncated
   * projection, and it never touches the high-water mark — deleted ids stay retired across a
   * rebuild.
   */
  rebuildProjection(): { events: number } {
    return this.transact((tx) => {
      const events = this.readEvents();
      tx.clearProjection();
      // Project only — the log is the source we are replaying, so we must NOT append to it.
      for (const record of events) {
        projectEvent(this.#db, record.timestamp, recordToInput(record));
      }
      return { events: events.length };
    });
  }
}

/** Reconstruct a {@link TaskEventInput} from a recorded log entry (payload lacks the envelope). */
function recordToInput(record: TaskEventRecord): TaskEventInput {
  return {
    ...record.payload,
    type: record.type,
    taskId: record.taskId,
    actor: record.actor,
  } as unknown as TaskEventInput;
}

/**
 * Append a task event to the log AND project it, atomically (the caller is already inside a
 * transaction). Live path only; rebuild replays the log through {@link projectEvent} without
 * re-appending. This is the single writer of `task_events`, so the log and its projection commit
 * together — there is never an event without its projection (WK-07).
 */
function applyEvent(db: EventStore['db'], now: number, event: TaskEventInput): TaskEventRecord {
  const { type, taskId, actor, ...rest } = event;
  const payload = rest as Record<string, unknown>;
  const info = db
    .prepare(
      `INSERT INTO task_events (task_id, type, payload, actor_kind, actor_id, actor_label, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, type, JSON.stringify(payload), actor.kind, actor.id, actor.label ?? null, now);

  projectEvent(db, now, event);

  return { seq: Number(info.lastInsertRowid), taskId, type, payload, actor, timestamp: now };
}

/**
 * The projection reducer: apply ONE task event to `task_nodes` / `task_deps`. A pure fold of
 * (event, current projection) — which is exactly why the log can be replayed to the same place.
 */
function projectEvent(db: EventStore['db'], now: number, event: TaskEventInput): void {
  const actor = event.actor;
  switch (event.type) {
    case 'task-created':
      db.prepare(
        `INSERT INTO task_nodes (id, subject, description, active_form, owner, status, metadata,
           version, created_at, updated_at, created_by_kind, created_by_id, created_by_label)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(
        event.taskId,
        event.subject,
        event.description,
        event.activeForm,
        event.status,
        JSON.stringify(event.metadata),
        now,
        now,
        actor.kind,
        actor.id,
        actor.label ?? null,
      );
      for (const blocker of event.blockedBy) {
        db.prepare('INSERT OR IGNORE INTO task_deps (blocker_id, blocked_id) VALUES (?, ?)').run(
          blocker,
          event.taskId,
        );
      }
      break;

    case 'task-claimed':
      db.prepare(
        `UPDATE task_nodes SET owner = ?, status = 'claimed', version = version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(event.owner, now, event.taskId);
      break;

    case 'task-released':
      db.prepare(
        `UPDATE task_nodes SET owner = NULL, status = 'released', version = version + 1,
           updated_at = ? WHERE id = ?`,
      ).run(now, event.taskId);
      break;

    case 'task-status-changed':
      db.prepare(
        'UPDATE task_nodes SET status = ?, version = version + 1, updated_at = ? WHERE id = ?',
      ).run(event.status, now, event.taskId);
      break;

    case 'task-deleted':
      db.prepare(
        `UPDATE task_nodes SET status = 'deleted', owner = NULL, version = version + 1,
           updated_at = ? WHERE id = ?`,
      ).run(now, event.taskId);
      break;

    case 'task-metadata-updated':
      db.prepare(
        'UPDATE task_nodes SET metadata = ?, version = version + 1, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(event.metadata), now, event.taskId);
      break;

    case 'task-dependency-added':
      db.prepare('INSERT OR IGNORE INTO task_deps (blocker_id, blocked_id) VALUES (?, ?)').run(
        event.blockerId,
        event.blockedId,
      );
      db.prepare('UPDATE task_nodes SET version = version + 1, updated_at = ? WHERE id = ?').run(
        now,
        event.blockedId,
      );
      break;
  }
}
