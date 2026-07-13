/**
 * The scheduler (CR-02..CR-05, CR-07). Independent of the runtime: it does not RUN jobs, it decides
 * which are due and reports them so the runtime can inject them at a safe turn boundary. Every time
 * input is injected — the current instant, whether the runtime is busy, the current managed policy —
 * so the whole thing is pure and replayable.
 *
 * Two poll entry points, one per real-world scenario:
 *
 *   - {@link Scheduler.due} is the LIVE poll while the process is alive. A job that comes due while
 *     the runtime is busy is coalesced ONCE and runs at the next non-busy boundary (CR-05).
 *   - {@link Scheduler.resumeAfterDowntime} is called once on restart. Durable recurring jobs resume
 *     at the next FUTURE instant with missed instants recorded but never replayed; a missed durable
 *     one-shot is marked `missed`; session jobs never catch up (CR-05).
 *
 * A single malformed or failing job never takes down a poll — each job is evaluated in isolation.
 */

import { harnessError, type Clock, type IdSource, type ThreadId } from '@qwen-harness/protocol';
import {
  intersect,
  NO_MANAGED_RESTRICTIONS,
  type Authority,
  type ManagedPolicy,
} from '@qwen-harness/policy';

import { matches, nextFireAfter, nominalIntervalMs, parseCron } from './cron.ts';
import {
  deterministicJitterMs,
  MAX_JOBS_PER_OWNER,
  RECURRING_EXPIRY_MS,
  type CronJob,
  type JobStatus,
} from './job.ts';
import { foldRecords, type DurableJobSnapshot, type SchedulerStore } from './store.ts';

const MINUTE_MS = 60_000;

export interface CreateRecurringInput {
  readonly kind: 'recurring';
  readonly owner: string;
  readonly threadId: ThreadId;
  readonly cronExpr: string;
  readonly workloadTag: string;
  readonly authorityCeiling: Authority;
  readonly durable: boolean;
}

export interface CreateOneShotInput {
  readonly kind: 'one-shot';
  readonly owner: string;
  readonly threadId: ThreadId;
  /** Fire instant, epoch ms. */
  readonly fireAt: number;
  readonly workloadTag: string;
  readonly authorityCeiling: Authority;
  readonly durable: boolean;
}

export type CreateJobInput = CreateRecurringInput | CreateOneShotInput;

/** A job the poll reports as due. The scheduler reports; it never executes (CR-02). */
export interface DueResult {
  readonly job: CronJob;
  /** The scheduled minute marker that triggered this firing. */
  readonly scheduledInstant: number;
  /** When a supervisor would actually start it: the instant plus the job's deterministic jitter. */
  readonly firedAt: number;
  /**
   * The authority to run under: the job's captured ceiling INTERSECTED with current managed policy
   * (CR-07). Never wider than the captured ceiling.
   */
  readonly authority: Authority;
}

/** What a downtime resume did, for audit and tests. */
export interface DowntimeSummary {
  readonly recurringResumed: number;
  readonly missedInstantsRecorded: number;
  readonly missedOneShots: readonly string[];
  readonly droppedSessionOneShots: readonly string[];
  readonly expired: readonly string[];
}

interface PollOptions {
  readonly now: number;
  readonly busy?: boolean;
  /** Current managed policy, intersected into each fired job's authority. */
  readonly managed?: ManagedPolicy;
}

/** Mutable per-job state the readonly {@link CronJob} snapshot does not carry. */
interface JobState {
  readonly job: CronJob;
  status: JobStatus;
  /** The latest instant already accounted for; the next fire is strictly after it. */
  cursor: number;
  /** An instant deferred because the runtime was busy, to run at the next non-busy boundary. */
  pendingCoalesced: number | null;
  readonly firedInstants: number[];
  readonly missedInstants: number[];
}

export interface SchedulerOptions {
  readonly clock: Clock;
  readonly ids: IdSource;
  /** Durable backend. When present, durable jobs persist and are reconstructed on construction. */
  readonly store?: SchedulerStore;
}

function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

export class Scheduler {
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #store: SchedulerStore | undefined;
  readonly #jobs = new Map<string, JobState>();

  constructor(opts: SchedulerOptions) {
    this.#clock = opts.clock;
    this.#ids = opts.ids;
    this.#store = opts.store;
    if (this.#store) this.#restore(this.#store);
  }

  // -------------------------------------------------------------------------
  // Create / read / delete (CR-03)
  // -------------------------------------------------------------------------

  create(input: CreateJobInput): CronJob {
    const createdAt = this.#clock.now();

    // 50-job ceiling, counted over an owner's LIVE jobs (docs/product/defaults.md).
    const live = [...this.#jobs.values()].filter(
      (s) => s.job.owner === input.owner && s.status === 'active',
    ).length;
    if (live >= MAX_JOBS_PER_OWNER) {
      throw harnessError({
        origin: 'user',
        category: 'cron.limit_exceeded',
        message: `owner ${input.owner} already has ${MAX_JOBS_PER_OWNER} live jobs`,
      });
    }

    const id = this.#ids.next('job');
    let cronSource: string | null = null;
    let fireAt: number | null = null;
    let expiresAt: number | null = null;
    let jitterMs = 0;

    if (input.kind === 'recurring') {
      // Validate eagerly: an unparseable expression is rejected at creation, not at fire time.
      parseCron(input.cronExpr);
      cronSource = input.cronExpr;
      expiresAt = createdAt + RECURRING_EXPIRY_MS;
      jitterMs = deterministicJitterMs(id, this.#intervalOf(input.cronExpr, createdAt));
    } else {
      if (!Number.isFinite(input.fireAt)) {
        throw harnessError({
          origin: 'user',
          category: 'cron.invalid_fire_time',
          message: 'one-shot fireAt must be a finite epoch-ms instant',
        });
      }
      fireAt = input.fireAt;
    }

    const job: CronJob = {
      id,
      owner: input.owner,
      threadId: input.threadId,
      kind: input.kind,
      cronSource,
      fireAt,
      workloadTag: input.workloadTag,
      authorityCeiling: input.authorityCeiling,
      createdAt,
      expiresAt,
      durable: input.durable,
      jitterMs,
    };

    this.#jobs.set(id, {
      job,
      status: 'active',
      cursor: input.kind === 'one-shot' ? createdAt : createdAt,
      pendingCoalesced: null,
      firedInstants: [],
      missedInstants: [],
    });

    if (job.durable && this.#store) {
      this.#store.append({ type: 'job-created', job: toSnapshot(job) });
    }
    return job;
  }

  get(id: string): CronJob | undefined {
    return this.#jobs.get(id)?.job;
  }

  /** The current status of a job (its lifecycle state), or `undefined` if unknown. */
  statusOf(id: string): JobStatus | undefined {
    return this.#jobs.get(id)?.status;
  }

  list(owner?: string): CronJob[] {
    return [...this.#jobs.values()]
      .filter((s) => s.status !== 'deleted' && (owner === undefined || s.job.owner === owner))
      .map((s) => s.job);
  }

  /** Missed instants recorded for a durable recurring job (not replayed, CR-05). */
  missedInstantsOf(id: string): readonly number[] {
    return this.#jobs.get(id)?.missedInstants ?? [];
  }

  delete(id: string): boolean {
    const state = this.#jobs.get(id);
    if (!state || state.status === 'deleted') return false;
    state.status = 'deleted';
    if (state.job.durable && this.#store) this.#store.append({ type: 'job-deleted', id });
    return true;
  }

  // -------------------------------------------------------------------------
  // Live poll (CR-02, CR-05 coalescing)
  // -------------------------------------------------------------------------

  due(opts: PollOptions): DueResult[] {
    const { now } = opts;
    const busy = opts.busy ?? false;
    const managed = opts.managed ?? NO_MANAGED_RESTRICTIONS;
    const out: DueResult[] = [];

    for (const state of this.#jobs.values()) {
      // Isolation: a single job that throws never aborts the poll for the others (CR-05).
      try {
        const result = this.#evaluate(state, now, busy, managed);
        if (result) out.push(result);
      } catch {
        // A broken job is skipped this poll; it does not corrupt or halt the scheduler.
        continue;
      }
    }
    return out;
  }

  #evaluate(state: JobState, now: number, busy: boolean, managed: ManagedPolicy): DueResult | null {
    if (state.status !== 'active') return null;

    if (this.#maybeExpire(state, now)) return null;

    const target =
      state.job.kind === 'recurring'
        ? this.#recurringTarget(state, now)
        : this.#oneShotTarget(state, now);

    if (target === null) return null;

    if (busy) {
      // Coalesce: remember one deferred fire, advance the cursor so intermediate instants are not
      // re-counted, and run nothing now. A second busy poll only updates the single pending instant.
      state.pendingCoalesced = target;
      state.cursor = Math.max(state.cursor, target);
      return null;
    }

    return this.#fire(state, target, managed);
  }

  #fire(state: JobState, scheduledInstant: number, managed: ManagedPolicy): DueResult {
    state.cursor = Math.max(state.cursor, scheduledInstant);
    state.pendingCoalesced = null;
    state.firedInstants.push(scheduledInstant);

    if (state.job.kind === 'one-shot') {
      state.status = 'fired';
      this.#persistStatus(state, 'fired');
    } else if (state.job.durable && this.#store) {
      this.#store.append({ type: 'job-fired', id: state.job.id, instant: scheduledInstant });
    }

    return {
      job: state.job,
      scheduledInstant,
      firedAt: scheduledInstant + state.job.jitterMs,
      // Intersect the captured ceiling with current managed policy; passing the ceiling as both
      // requested and parent yields the ceiling narrowed by managed, never widened (CR-07).
      authority: intersect(state.job.authorityCeiling, state.job.authorityCeiling, managed),
    };
  }

  /** The latest recurring instant to fire now (coalescing any earlier live ones), or null. */
  #recurringTarget(state: JobState, now: number): number | null {
    const expr = state.job.cronSource;
    if (expr === null) return null;
    const jitter = state.job.jitterMs;

    let candidate: number | null = null;
    let probe = nextFireAfter(expr, state.cursor);
    while (probe.getTime() + jitter <= now) {
      candidate = probe.getTime();
      probe = nextFireAfter(expr, probe);
    }

    if (state.pendingCoalesced !== null) {
      candidate =
        candidate === null ? state.pendingCoalesced : Math.max(candidate, state.pendingCoalesced);
    }
    return candidate;
  }

  #oneShotTarget(state: JobState, now: number): number | null {
    const fireAt = state.job.fireAt;
    if (fireAt === null) return null;
    if (state.pendingCoalesced !== null) return state.pendingCoalesced;
    if (fireAt + state.job.jitterMs <= now && !state.firedInstants.includes(fireAt)) return fireAt;
    return null;
  }

  #maybeExpire(state: JobState, now: number): boolean {
    if (state.job.kind !== 'recurring' || state.job.expiresAt === null) return false;
    if (now < state.job.expiresAt) return false;
    state.status = 'expired';
    this.#persistStatus(state, 'expired');
    return true;
  }

  // -------------------------------------------------------------------------
  // Downtime resume (CR-05 missed / no-catch-up)
  // -------------------------------------------------------------------------

  resumeAfterDowntime(opts: { now: number }): DowntimeSummary {
    const now = opts.now;
    const nowMinute = floorMinute(now);
    let recurringResumed = 0;
    let missedInstantsRecorded = 0;
    const missedOneShots: string[] = [];
    const droppedSessionOneShots: string[] = [];
    const expired: string[] = [];

    for (const state of this.#jobs.values()) {
      if (state.status !== 'active') continue;
      try {
        if (this.#maybeExpire(state, now)) {
          expired.push(state.job.id);
          continue;
        }

        if (state.job.kind === 'recurring') {
          this.#resumeRecurring(state, now, nowMinute, (n) => {
            missedInstantsRecorded += n;
          });
          recurringResumed += 1;
        } else {
          this.#resumeOneShot(state, now, missedOneShots, droppedSessionOneShots);
        }
      } catch {
        // A broken job cannot block recovery of the rest.
        continue;
      }
    }

    return {
      recurringResumed,
      missedInstantsRecorded,
      missedOneShots,
      droppedSessionOneShots,
      expired,
    };
  }

  #resumeRecurring(
    state: JobState,
    now: number,
    nowMinute: number,
    onMissed: (count: number) => void,
  ): void {
    const expr = state.job.cronSource;
    if (expr === null) return;

    if (state.job.durable) {
      // Record every instant we were down for — but never replay them (CR-05).
      let count = 0;
      let probe = nextFireAfter(expr, state.cursor);
      while (probe.getTime() <= now) {
        const instant = probe.getTime();
        if (!state.missedInstants.includes(instant)) {
          state.missedInstants.push(instant);
          if (this.#store) {
            this.#store.append({ type: 'job-missed-instant', id: state.job.id, instant });
          }
          count += 1;
        }
        probe = nextFireAfter(expr, probe);
      }
      onMissed(count);
    }
    // Both durable and session jobs resume at the NEXT FUTURE instant: advance the cursor past now,
    // so nothing before now can fire. Session jobs simply record nothing on the way (no catch-up).
    state.cursor = Math.max(state.cursor, nowMinute);
  }

  #resumeOneShot(
    state: JobState,
    now: number,
    missedOneShots: string[],
    droppedSessionOneShots: string[],
  ): void {
    const fireAt = state.job.fireAt;
    if (fireAt === null || fireAt > now || state.firedInstants.includes(fireAt)) return;

    if (state.job.durable) {
      state.status = 'missed';
      this.#persistStatus(state, 'missed');
      missedOneShots.push(state.job.id);
    } else {
      state.status = 'dropped';
      droppedSessionOneShots.push(state.job.id);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #persistStatus(state: JobState, status: JobStatus): void {
    if (state.job.durable && this.#store) {
      this.#store.append({ type: 'job-status', id: state.job.id, status });
    }
  }

  /** Nominal interval for jitter sizing; an unsatisfiable expression yields no jitter. */
  #intervalOf(cronExpr: string, at: number): number | null {
    try {
      return nominalIntervalMs(cronExpr, at);
    } catch {
      return null;
    }
  }

  /** Reconstruct durable jobs from the log on construction (CR-04). Session jobs are never here. */
  #restore(store: SchedulerStore): void {
    for (const folded of foldRecords(store.load())) {
      const snapshot = folded.snapshot;
      const job = fromSnapshot(snapshot);
      const cursor = Math.max(
        snapshot.createdAt,
        ...folded.firedInstants,
        ...folded.missedInstants,
      );
      this.#jobs.set(job.id, {
        job,
        status: folded.status,
        cursor,
        pendingCoalesced: null,
        firedInstants: [...folded.firedInstants],
        missedInstants: [...folded.missedInstants],
      });
    }
  }
}

function toSnapshot(job: CronJob): DurableJobSnapshot {
  return {
    id: job.id,
    owner: job.owner,
    threadId: job.threadId,
    kind: job.kind,
    cronSource: job.cronSource,
    fireAt: job.fireAt,
    workloadTag: job.workloadTag,
    authorityCeiling: job.authorityCeiling,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    jitterMs: job.jitterMs,
  };
}

function fromSnapshot(snapshot: DurableJobSnapshot): CronJob {
  return {
    id: snapshot.id,
    owner: snapshot.owner,
    threadId: snapshot.threadId as ThreadId,
    kind: snapshot.kind,
    cronSource: snapshot.cronSource,
    fireAt: snapshot.fireAt,
    workloadTag: snapshot.workloadTag,
    authorityCeiling: snapshot.authorityCeiling,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    durable: true,
    jitterMs: snapshot.jitterMs,
  };
}

// `matches` is re-exported for callers that want to test membership without a full poll.
export { matches };
