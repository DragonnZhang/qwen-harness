import Database from 'better-sqlite3';
import {
  HarnessEventSchema,
  SCHEMA_VERSION,
  harnessError,
  parseEventLenient,
  type Clock,
  type EventPayload,
  type HarnessEvent,
  type IdSource,
  type SideEffectState,
  type Thread,
  type ThreadId,
} from '@qwen-harness/protocol';

import { migrate } from './migrations.ts';
import { createRedactor, type Redactor } from './redaction.ts';

export interface EventStoreOptions {
  /** `:memory:` for tests, a path for real use. */
  readonly path: string;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** Secret values scrubbed from every payload BEFORE it is written. */
  readonly secrets?: readonly (string | undefined)[];
  /**
   * Deterministic failure injection (acceptance.md "Reliability gate"). A test names a boundary;
   * the store throws exactly there. This is how we prove crash-safety instead of asserting it.
   */
  readonly failAt?: FailureBoundary | undefined;
}

export type FailureBoundary =
  'before-event-insert' | 'after-event-insert-before-projection' | 'after-projection-before-commit';

/** Thrown by injected failure. Distinct type so a test can assert it was OUR crash, not a bug. */
export class InjectedFailure extends Error {
  constructor(readonly boundary: FailureBoundary) {
    super(`injected failure at ${boundary}`);
    this.name = 'InjectedFailure';
  }
}

export interface AppendInput {
  readonly threadId: ThreadId;
  readonly payload: EventPayload;
  readonly actor: HarnessEvent['actor'];
  readonly correlationId: HarnessEvent['correlationId'];
  readonly causationId?: HarnessEvent['causationId'];
  readonly turnId?: HarnessEvent['turnId'];
  readonly itemId?: HarnessEvent['itemId'];
  readonly permissionProfile: HarnessEvent['permissionProfile'];
}

/**
 * Append-only typed event store on SQLite WAL, with transactional projections.
 *
 * The central guarantee: **the event insert and every projection update it implies commit in ONE
 * transaction.** There is no window in which an event exists but its projection does not, so a
 * crash can never leave a thread whose log and whose materialized state disagree. Recovery is
 * therefore "reopen the file", not "reconcile two stores".
 */
export class EventStore {
  readonly #db: Database.Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #redactor: Redactor;
  readonly #failAt: FailureBoundary | undefined;

  constructor(opts: EventStoreOptions) {
    this.#db = new Database(opts.path);
    this.#clock = opts.clock;
    this.#ids = opts.ids;
    this.#redactor = createRedactor([...(opts.secrets ?? [])]);
    this.#failAt = opts.failAt;

    // WAL: readers never block the writer, and a crash recovers from the log rather than
    // truncating. `synchronous=FULL` is the durability half — without it WAL can lose the tail
    // of the last transaction on power loss, which would break "persist before presenting".
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.pragma('foreign_keys = ON');
    // Fail fast rather than hang if another process holds the write lock (SS-08).
    this.#db.pragma('busy_timeout = 5000');

    migrate(this.#db);
  }

  get db(): Database.Database {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  // -------------------------------------------------------------------------
  // Append
  // -------------------------------------------------------------------------

  /**
   * Appends one event and applies its projection atomically.
   *
   * The per-thread `seq` is read and written *inside* the transaction, so two writers racing for
   * the same sequence number collide on the UNIQUE(thread_id, seq) constraint instead of silently
   * interleaving a thread. That is a real guard, not an advisory one.
   */
  append(input: AppendInput): HarnessEvent {
    const redactedPayload = this.#redactor.redactValue(input.payload);

    const tx = this.#db.transaction((): HarnessEvent => {
      const nextSeq = this.#nextSeq(input.threadId);

      const event: HarnessEvent = HarnessEventSchema.parse({
        id: this.#ids.next('evt'),
        schemaVersion: SCHEMA_VERSION,
        seq: nextSeq,
        timestamp: this.#clock.now(),
        threadId: input.threadId,
        turnId: input.turnId ?? null,
        itemId: input.itemId ?? null,
        actor: input.actor,
        correlationId: input.correlationId,
        causationId: input.causationId ?? null,
        permissionProfile: input.permissionProfile,
        payload: redactedPayload,
      });

      if (this.#failAt === 'before-event-insert') throw new InjectedFailure(this.#failAt);

      this.#db
        .prepare(
          `INSERT INTO events (id, schema_version, thread_id, seq, timestamp, turn_id, item_id,
             actor_kind, actor_id, correlation_id, causation_id, permission_profile,
             payload_type, payload)
           VALUES (@id, @schemaVersion, @threadId, @seq, @timestamp, @turnId, @itemId,
             @actorKind, @actorId, @correlationId, @causationId, @permissionProfile,
             @payloadType, @payload)`,
        )
        .run({
          id: event.id,
          schemaVersion: event.schemaVersion,
          threadId: event.threadId,
          seq: event.seq,
          timestamp: event.timestamp,
          turnId: event.turnId,
          itemId: event.itemId,
          actorKind: event.actor.kind,
          actorId: event.actor.id,
          correlationId: event.correlationId,
          causationId: event.causationId,
          permissionProfile: event.permissionProfile,
          payloadType: event.payload.type,
          payload: JSON.stringify(event.payload),
        });

      if (this.#failAt === 'after-event-insert-before-projection') {
        throw new InjectedFailure(this.#failAt);
      }

      this.#project(event);

      if (this.#failAt === 'after-projection-before-commit') {
        throw new InjectedFailure(this.#failAt);
      }

      return event;
    });

    return tx();
  }

  #nextSeq(threadId: ThreadId): number {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM events WHERE thread_id = ?')
      .get(threadId) as { maxSeq: number };
    return row.maxSeq + 1;
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------

  /**
   * Applies one event to the projection tables. Pure function of (event, current projection) —
   * which is exactly why `rebuildProjections()` can replay the log and land in the same place.
   */
  #project(e: HarnessEvent): void {
    const db = this.#db;
    const p = e.payload;

    switch (p.type) {
      case 'thread-created':
        db.prepare(
          `INSERT INTO threads (id, name, created_at, updated_at, canonical_repo, cwd,
             permission_profile, archived, forked_from_thread, forked_from_seq, last_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`,
        ).run(
          e.threadId,
          p.name,
          e.timestamp,
          e.timestamp,
          p.canonicalRepo,
          p.cwd,
          e.permissionProfile,
          e.seq,
        );
        return;

      case 'thread-forked':
        db.prepare(
          'UPDATE threads SET forked_from_thread = ?, forked_from_seq = ? WHERE id = ?',
        ).run(p.fromThreadId, p.atSeq, e.threadId);
        break;

      case 'thread-renamed':
        db.prepare('UPDATE threads SET name = ? WHERE id = ?').run(p.name, e.threadId);
        break;

      case 'thread-archived':
        db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run(e.threadId);
        break;

      case 'cwd-changed':
        db.prepare('UPDATE threads SET cwd = ? WHERE id = ?').run(p.to, e.threadId);
        break;

      case 'turn-started':
        db.prepare(
          `INSERT INTO turns (id, thread_id, seq, state, termination_reason, started_at, ended_at,
             permission_profile)
           VALUES (?, ?, ?, 'preparing', NULL, ?, NULL, ?)`,
        ).run(e.turnId, e.threadId, e.seq, e.timestamp, e.permissionProfile);
        break;

      case 'turn-state-changed':
        db.prepare('UPDATE turns SET state = ? WHERE id = ?').run(p.to, e.turnId);
        break;

      case 'turn-ended':
        db.prepare(
          'UPDATE turns SET state = ?, termination_reason = ?, ended_at = ? WHERE id = ?',
        ).run(p.state, p.reason, e.timestamp, e.turnId);
        break;

      case 'item-appended':
      case 'item-updated':
        db.prepare(
          `INSERT INTO items (id, thread_id, turn_id, seq, type, data, created_at)
           VALUES (@id, @threadId, @turnId, @seq, @type, @data, @createdAt)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, type = excluded.type`,
        ).run({
          id: p.item.id,
          threadId: p.item.threadId,
          turnId: p.item.turnId,
          seq: p.item.seq,
          type: p.item.type,
          data: JSON.stringify(p.item),
          createdAt: p.item.createdAt,
        });
        break;

      case 'side-effect-intent':
        db.prepare(
          `INSERT INTO side_effects (id, thread_id, turn_id, idempotency_key, kind, destructive,
             normalized_action, state, result_digest, created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'not-started', NULL, ?, NULL)`,
        ).run(
          p.intent.sideEffectId,
          e.threadId,
          e.turnId,
          p.intent.idempotencyKey,
          p.intent.kind,
          p.intent.destructive ? 1 : 0,
          p.intent.normalizedAction,
          e.timestamp,
        );
        break;

      case 'side-effect-started':
        // `in-flight` is the state a crash leaves behind. Recovery promotes it to
        // `indeterminate` — we know we started, we do not know whether it landed.
        db.prepare("UPDATE side_effects SET state = 'in-flight' WHERE id = ?").run(p.sideEffectId);
        break;

      case 'side-effect-settled':
        db.prepare(
          'UPDATE side_effects SET state = ?, result_digest = ?, settled_at = ? WHERE id = ?',
        ).run(p.state, p.resultDigest, e.timestamp, p.sideEffectId);
        break;

      default:
        // Other events are recorded in the log but project nothing. Notably `unknown` payloads
        // from a future build: they are stored, exported, and replayed, but never interpreted.
        break;
    }

    db.prepare('UPDATE threads SET last_seq = ?, updated_at = ? WHERE id = ?').run(
      e.seq,
      e.timestamp,
      e.threadId,
    );
  }

  /**
   * Drops and rebuilds every projection by replaying the log.
   *
   * This must land on byte-identical projection state (SS-01, SS-06). It runs in one transaction:
   * a crash mid-rebuild rolls back rather than leaving projections half-truncated.
   */
  rebuildProjections(): { events: number } {
    // Read the log fully BEFORE opening the write transaction. Iterating a statement while the
    // same transaction writes to other tables is asking for surprises; materializing is cheap
    // and makes the rebuild obviously correct.
    const events = this.readAll();

    const tx = this.#db.transaction(() => {
      this.#db.exec(
        'DELETE FROM items; DELETE FROM side_effects; DELETE FROM turns; DELETE FROM threads;',
      );
      for (const event of events) this.#project(event);
      return { events: events.length };
    });
    return tx();
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Every event in global insertion order. Used by export and replay. */
  readAll(): HarnessEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM events ORDER BY rowid_alias ASC')
      .all() as EventRow[];
    return rows.map(rowToEvent);
  }

  readThread(threadId: ThreadId, fromSeq = 0): HarnessEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM events WHERE thread_id = ? AND seq >= ? ORDER BY seq ASC')
      .all(threadId, fromSeq) as EventRow[];
    return rows.map(rowToEvent);
  }

  getThread(threadId: ThreadId): Thread | undefined {
    const row = this.#db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as
      ThreadRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id as ThreadId,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canonicalRepo: row.canonical_repo,
      cwd: row.cwd,
      permissionProfile: row.permission_profile as Thread['permissionProfile'],
      archived: row.archived === 1,
      forkedFrom:
        row.forked_from_thread !== null && row.forked_from_seq !== null
          ? {
              threadId: row.forked_from_thread as ThreadId,
              atSeq: row.forked_from_seq,
            }
          : null,
    };
  }

  listThreads(opts: { includeArchived?: boolean } = {}): Thread[] {
    const rows = this.#db
      .prepare(
        `SELECT id FROM threads ${opts.includeArchived ? '' : 'WHERE archived = 0'}
         ORDER BY updated_at DESC`,
      )
      .all() as { id: string }[];
    return rows
      .map((r) => this.getThread(r.id as ThreadId))
      .filter((t): t is Thread => t !== undefined);
  }

  // -------------------------------------------------------------------------
  // Side-effect recovery (SS-05) — the "never replay a completed action" mechanism
  // -------------------------------------------------------------------------

  /**
   * Answers the only question recovery actually needs to ask:
   * *given this intent, is it safe to execute?*
   *
   * `not-started` -> yes, run it.
   * `known-failed` -> yes, safe to retry; it demonstrably did not land.
   * `known-complete` -> NO. It already happened. Re-running would duplicate it.
   * `in-flight` / `indeterminate` -> NO, not automatically. We started and never learned the
   *   outcome. A destructive action here requires inspection or explicit approval; replaying it
   *   blindly is precisely the bug this whole ledger exists to prevent.
   */
  sideEffectState(idempotencyKey: string): SideEffectState | 'not-recorded' {
    const row = this.#db
      .prepare(
        `SELECT state FROM side_effects WHERE idempotency_key = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(idempotencyKey) as { state: SideEffectState } | undefined;
    return row?.state ?? 'not-recorded';
  }

  mayExecute(idempotencyKey: string): { allowed: boolean; reason: string } {
    const state = this.sideEffectState(idempotencyKey);
    switch (state) {
      case 'not-recorded':
      case 'not-started':
        return { allowed: true, reason: 'no prior execution recorded' };
      case 'known-failed':
        return {
          allowed: true,
          reason: 'prior attempt is known to have failed; safe to retry',
        };
      case 'known-complete':
        return {
          allowed: false,
          reason: 'already completed; re-running would duplicate the side effect',
        };
      case 'in-flight':
      case 'indeterminate':
        return {
          allowed: false,
          reason:
            'outcome is indeterminate after interruption; requires inspection, never blind replay',
        };
    }
  }

  /**
   * Crash recovery. Anything the log says was `in-flight` cannot still be running — the process
   * that owned it is gone. It becomes `indeterminate`, which is honest: we do not know.
   * We must NOT guess `known-failed`, because guessing failure is what causes a double-write.
   */
  recoverInterrupted(): { promoted: number } {
    const res = this.#db
      .prepare("UPDATE side_effects SET state = 'indeterminate' WHERE state = 'in-flight'")
      .run();
    return { promoted: res.changes };
  }

  listIndeterminate(
    threadId: ThreadId,
  ): { id: string; normalizedAction: string; destructive: boolean }[] {
    const rows = this.#db
      .prepare(
        `SELECT id, normalized_action, destructive FROM side_effects
         WHERE thread_id = ? AND state = 'indeterminate'`,
      )
      .all(threadId) as {
      id: string;
      normalized_action: string;
      destructive: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      normalizedAction: r.normalized_action,
      destructive: r.destructive === 1,
    }));
  }
}

// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  schema_version: number;
  thread_id: string;
  seq: number;
  timestamp: number;
  turn_id: string | null;
  item_id: string | null;
  actor_kind: string;
  actor_id: string;
  correlation_id: string;
  causation_id: string | null;
  permission_profile: string;
  payload_type: string;
  payload: string;
}

interface ThreadRow {
  id: string;
  name: string | null;
  created_at: number;
  updated_at: number;
  canonical_repo: string | null;
  cwd: string;
  permission_profile: string;
  archived: number;
  forked_from_thread: string | null;
  forked_from_seq: number | null;
}

function rowToEvent(row: EventRow): HarnessEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch (cause) {
    throw harnessError(
      {
        origin: 'storage',
        category: 'storage.corrupt_payload',
        message: `event ${row.id} has an unparseable payload`,
      },
      { cause },
    );
  }

  // Lenient on purpose: an event written by a NEWER build must survive being read by this one
  // (RT-09). It comes back as an `unknown` payload rather than throwing.
  return parseEventLenient({
    id: row.id,
    schemaVersion: row.schema_version,
    seq: row.seq,
    timestamp: row.timestamp,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    actor: { kind: row.actor_kind, id: row.actor_id },
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    permissionProfile: row.permission_profile,
    payload,
  });
}
