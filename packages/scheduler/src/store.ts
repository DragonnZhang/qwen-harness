/**
 * Durable persistence for scheduled jobs (CR-04).
 *
 * The scheduler itself is pure coordination — it holds no database handle (the architecture gate
 * forbids `scheduler` from opening one). Durability is an INJECTED append-only log port: durable
 * definitions survive a restart by replaying the log; session-only definitions never touch it and so
 * disappear with the process. This is the same seam `context` uses for its transcript boundary and
 * `hooks` uses for its network egress — the domain depends on a small interface, and production wires
 * it to `@qwen-harness/storage`.
 *
 * The records are a faithful event log: the durable job set is a pure fold of them, so replaying the
 * log rebuilds byte-identical state.
 */

import type {
  Actor,
  Clock,
  CorrelationId,
  IdSource,
  PermissionProfile,
  SideEffectId,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { Authority } from '@qwen-harness/policy';
import type { EventStore } from '@qwen-harness/storage';

import type { JobKind, JobStatus } from './job.ts';

/** A durable job's serializable snapshot — plain data, safe to JSON round-trip. */
export interface DurableJobSnapshot {
  readonly id: string;
  readonly owner: string;
  readonly threadId: string;
  readonly kind: JobKind;
  /** Recurring jobs carry their cron source; one-shots carry `null`. */
  readonly cronSource: string | null;
  /** One-shot jobs carry their fire instant (epoch ms); recurring jobs carry `null`. */
  readonly fireAt: number | null;
  readonly workloadTag: string;
  readonly authorityCeiling: Authority;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly jitterMs: number;
}

/**
 * One entry in the durable scheduler log. The projection (`foldRecords`) is a pure function of the
 * whole sequence, which is what lets a restart reconstruct the exact live job set.
 */
export type SchedulerRecord =
  | { readonly type: 'job-created'; readonly job: DurableJobSnapshot }
  | { readonly type: 'job-deleted'; readonly id: string }
  | { readonly type: 'job-status'; readonly id: string; readonly status: JobStatus }
  | { readonly type: 'job-fired'; readonly id: string; readonly instant: number }
  | { readonly type: 'job-missed-instant'; readonly id: string; readonly instant: number };

/** The append-only durable-log port the {@link Scheduler} writes through. */
export interface SchedulerStore {
  append(record: SchedulerRecord): void;
  /** Every record ever appended, in append order. */
  load(): readonly SchedulerRecord[];
}

/** The reconstructed durable state of one job after folding the log. */
export interface FoldedJob {
  readonly snapshot: DurableJobSnapshot;
  readonly status: JobStatus;
  readonly firedInstants: readonly number[];
  readonly missedInstants: readonly number[];
}

/**
 * Fold a record sequence into the durable job set (CR-04 restart reconstruction). A `job-deleted`
 * record removes the job entirely; every other record updates the surviving projection. Pure.
 */
export function foldRecords(records: readonly SchedulerRecord[]): FoldedJob[] {
  const byId = new Map<
    string,
    { snapshot: DurableJobSnapshot; status: JobStatus; fired: number[]; missed: number[] }
  >();

  for (const record of records) {
    switch (record.type) {
      case 'job-created':
        byId.set(record.job.id, {
          snapshot: record.job,
          status: 'active',
          fired: [],
          missed: [],
        });
        break;
      case 'job-deleted':
        byId.delete(record.id);
        break;
      case 'job-status': {
        const entry = byId.get(record.id);
        if (entry) entry.status = record.status;
        break;
      }
      case 'job-fired': {
        const entry = byId.get(record.id);
        if (entry && !entry.fired.includes(record.instant)) entry.fired.push(record.instant);
        break;
      }
      case 'job-missed-instant': {
        const entry = byId.get(record.id);
        if (entry && !entry.missed.includes(record.instant)) entry.missed.push(record.instant);
        break;
      }
    }
  }

  return [...byId.values()].map((e) => ({
    snapshot: e.snapshot,
    status: e.status,
    firedInstants: e.fired,
    missedInstants: e.missed,
  }));
}

/** An in-memory durable log — the default backend for session use and for tests. */
export class InMemorySchedulerStore implements SchedulerStore {
  readonly #records: SchedulerRecord[] = [];

  append(record: SchedulerRecord): void {
    this.#records.push(record);
  }

  load(): readonly SchedulerRecord[] {
    return [...this.#records];
  }
}

/** Marker that tags a scheduler record inside the shared event log, so `load` reads only our own. */
const SCHEDULER_NAMESPACE = 'scheduler.v1';

interface EventStoreSchedulerContext {
  readonly store: EventStore;
  readonly threadId: ThreadId;
  /** The turn the durable records are attributed to (the event store requires a turn id). */
  readonly turnId: TurnId;
  readonly actor: Actor;
  readonly correlationId: CorrelationId;
  readonly permissionProfile: PermissionProfile;
  readonly ids: IdSource;
  readonly clock: Clock;
}

/**
 * A {@link SchedulerStore} backed by the real {@link EventStore} (CR-04). Each record is persisted as
 * a `side-effect-intent` event — a durable job IS a persisted intent to do future work — with the
 * record JSON carried in `normalizedAction` under a namespace marker. Appending goes through the
 * store's single transactional path, so a crash cannot record a job in the log but lose it from
 * recovery. `load` replays the thread's scheduler intents and returns them in order.
 *
 * The protocol event schema is frozen and has no job-specific payload; `side-effect-intent` is the
 * honest fit (attributed, redacted, idempotent) rather than inventing one.
 */
export function eventStoreSchedulerStore(ctx: EventStoreSchedulerContext): SchedulerStore {
  return {
    append(record: SchedulerRecord): void {
      const marker = JSON.stringify({ ns: SCHEDULER_NAMESPACE, record });
      ctx.store.append({
        threadId: ctx.threadId,
        payload: {
          type: 'side-effect-intent',
          intent: {
            sideEffectId: ctx.ids.next('sfx') as SideEffectId,
            idempotencyKey: `${SCHEDULER_NAMESPACE}:${ctx.ids.next('sfx')}`,
            kind: 'other',
            destructive: false,
            normalizedAction: marker,
          },
        },
        actor: ctx.actor,
        correlationId: ctx.correlationId,
        turnId: ctx.turnId,
        permissionProfile: ctx.permissionProfile,
      });
    },

    load(): readonly SchedulerRecord[] {
      const out: SchedulerRecord[] = [];
      for (const event of ctx.store.readThread(ctx.threadId)) {
        if (event.payload.type !== 'side-effect-intent') continue;
        const parsed = tryParseMarker(event.payload.intent.normalizedAction);
        if (parsed) out.push(parsed);
      }
      return out;
    },
  };
}

function tryParseMarker(normalizedAction: string): SchedulerRecord | null {
  try {
    const value: unknown = JSON.parse(normalizedAction);
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as { ns?: unknown }).ns === SCHEDULER_NAMESPACE
    ) {
      return (value as { record: SchedulerRecord }).record;
    }
  } catch {
    // A non-scheduler side effect (or any non-JSON action) simply is not one of our records.
  }
  return null;
}
