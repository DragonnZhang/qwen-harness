import { describe, expect, it } from 'vitest';

import {
  defaultAuthority,
  NO_MANAGED_RESTRICTIONS,
  isAtMost,
  type Authority,
  type ManagedPolicy,
} from '@qwen-harness/policy';
import type { ThreadId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';

import { deterministicJitterMs, RECURRING_EXPIRY_MS } from './job.ts';
import { Scheduler } from './scheduler.ts';
import { InMemorySchedulerStore } from './store.ts';

/** A minute-aligned base instant, so time-sensitive assertions are exact. */
const BASE = 1_700_000_040_000;
const THREAD = 'thr_000001' as ThreadId;
const CEILING = defaultAuthority('ask', '/repo', NO_MANAGED_RESTRICTIONS);

function newScheduler(opts: { start?: number; store?: InMemorySchedulerStore } = {}): {
  scheduler: Scheduler;
  clock: ManualClock;
} {
  const clock = new ManualClock(opts.start ?? BASE);
  const scheduler = new Scheduler({
    clock,
    ids: new SequentialIds(),
    ...(opts.store ? { store: opts.store } : {}),
  });
  return { scheduler, clock };
}

function recurring(
  scheduler: Scheduler,
  cronExpr: string,
  over: Partial<{ owner: string; durable: boolean; workloadTag: string }> = {},
): ReturnType<Scheduler['create']> {
  return scheduler.create({
    kind: 'recurring',
    owner: over.owner ?? 'owner-a',
    threadId: THREAD,
    cronExpr,
    workloadTag: over.workloadTag ?? 'digest',
    authorityCeiling: CEILING,
    durable: over.durable ?? false,
  });
}

describe('Scheduler create/list/delete (CR-03)', () => {
  it('returns a job immediately and lists/gets/deletes it', () => {
    const { scheduler } = newScheduler();
    const job = recurring(scheduler, '*/10 * * * *');
    expect(job.id).toMatch(/^job_/);
    expect(scheduler.get(job.id)).toEqual(job);
    expect(scheduler.list('owner-a')).toHaveLength(1);
    expect(scheduler.delete(job.id)).toBe(true);
    expect(scheduler.list('owner-a')).toHaveLength(0);
    expect(scheduler.delete(job.id)).toBe(false);
  });

  it('enforces the 50-job-per-owner ceiling (CR-03)', () => {
    const { scheduler } = newScheduler();
    for (let i = 0; i < 50; i += 1) recurring(scheduler, '*/10 * * * *', { owner: 'o' });
    expect(() => recurring(scheduler, '*/10 * * * *', { owner: 'o' })).toThrow(/50 live jobs/);
    // A different owner is unaffected.
    expect(() => recurring(scheduler, '*/10 * * * *', { owner: 'other' })).not.toThrow();
  });

  it('gives a recurring job a 7-day expiry and expires it at the poll (CR-03/CR-05)', () => {
    const { scheduler } = newScheduler();
    const job = recurring(scheduler, '*/10 * * * *');
    expect(job.expiresAt).toBe(BASE + RECURRING_EXPIRY_MS);

    expect(scheduler.due({ now: BASE + RECURRING_EXPIRY_MS })).toHaveLength(0);
    expect(scheduler.statusOf(job.id)).toBe('expired');
  });

  it('rejects an unparseable cron expression at creation', () => {
    const { scheduler } = newScheduler();
    expect(() => recurring(scheduler, 'not a cron')).toThrow();
  });
});

describe('deterministic jitter (CR-03)', () => {
  it('seeds jitter from the job id and stays within min(10% interval, 15 min)', () => {
    // '*/10' -> 10-minute interval -> cap = min(60_000, 900_000) = 60_000 ms.
    const { scheduler } = newScheduler();
    const job = recurring(scheduler, '*/10 * * * *');
    expect(job.jitterMs).toBe(deterministicJitterMs(job.id, 10 * 60_000));
    expect(job.jitterMs).toBeGreaterThanOrEqual(0);
    expect(job.jitterMs).toBeLessThanOrEqual(60_000);
  });

  it('is reproducible: the same id yields the same jitter across schedulers', () => {
    const a = newScheduler().scheduler;
    const b = newScheduler().scheduler;
    const ja = recurring(a, '*/10 * * * *');
    const jb = recurring(b, '*/10 * * * *');
    expect(ja.id).toBe(jb.id);
    expect(ja.jitterMs).toBe(jb.jitterMs);
  });
});

describe('coalescing a due-while-busy job (CR-05)', () => {
  it('coalesces once while busy, then fires exactly once at the next non-busy boundary', () => {
    const { scheduler } = newScheduler();
    const job = recurring(scheduler, '* * * * *'); // every minute
    const at = BASE + 90_000; // one instant (BASE+60_000) has come due

    expect(scheduler.due({ now: at, busy: true })).toHaveLength(0);
    // A second busy poll does not accumulate a second pending fire.
    expect(scheduler.due({ now: at, busy: true })).toHaveLength(0);

    const fired = scheduler.due({ now: at, busy: false });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.job.id).toBe(job.id);
    expect(fired[0]?.scheduledInstant).toBe(BASE + 60_000);

    // Nothing left over: it already fired.
    expect(scheduler.due({ now: at, busy: false })).toHaveLength(0);
  });
});

describe('downtime behavior (CR-05)', () => {
  it('records missed instants for a durable recurring job and resumes at the next future instant', () => {
    const store = new InMemorySchedulerStore();
    const { scheduler } = newScheduler({ store });
    const job = recurring(scheduler, '* * * * *', { durable: true });

    const now = BASE + 5 * 60_000 + 30_000; // 5.5 minutes of downtime
    const summary = scheduler.resumeAfterDowntime({ now });
    expect(summary.missedInstantsRecorded).toBe(5);
    expect(scheduler.missedInstantsOf(job.id)).toHaveLength(5);

    // Missed instants are NOT replayed: nothing fires for the downtime window.
    expect(scheduler.due({ now })).toHaveLength(0);

    // It resumes at the next FUTURE instant.
    const next = BASE + 6 * 60_000;
    const fired = scheduler.due({ now: next + job.jitterMs });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.scheduledInstant).toBe(next);
  });

  it('never catches a SESSION recurring job up after downtime', () => {
    const { scheduler } = newScheduler();
    const job = recurring(scheduler, '* * * * *', { durable: false });

    const now = BASE + 5 * 60_000 + 30_000;
    const summary = scheduler.resumeAfterDowntime({ now });
    expect(summary.missedInstantsRecorded).toBe(0);
    expect(scheduler.missedInstantsOf(job.id)).toHaveLength(0);
    expect(scheduler.due({ now })).toHaveLength(0);
  });

  it('marks a missed durable one-shot as `missed` (requires explicit rerun)', () => {
    const store = new InMemorySchedulerStore();
    const { scheduler } = newScheduler({ store });
    const job = scheduler.create({
      kind: 'one-shot',
      owner: 'owner-a',
      threadId: THREAD,
      fireAt: BASE + 60_000,
      workloadTag: 'reminder',
      authorityCeiling: CEILING,
      durable: true,
    });

    const summary = scheduler.resumeAfterDowntime({ now: BASE + 5 * 60_000 });
    expect(summary.missedOneShots).toContain(job.id);
    expect(scheduler.statusOf(job.id)).toBe('missed');
    // A missed one-shot does not fire on a later poll; it awaits an explicit rerun.
    expect(scheduler.due({ now: BASE + 5 * 60_000 })).toHaveLength(0);
  });

  it('drops a missed SESSION one-shot instead of marking it for rerun', () => {
    const { scheduler } = newScheduler();
    const job = scheduler.create({
      kind: 'one-shot',
      owner: 'owner-a',
      threadId: THREAD,
      fireAt: BASE + 60_000,
      workloadTag: 'reminder',
      authorityCeiling: CEILING,
      durable: false,
    });
    const summary = scheduler.resumeAfterDowntime({ now: BASE + 5 * 60_000 });
    expect(summary.droppedSessionOneShots).toContain(job.id);
    expect(scheduler.statusOf(job.id)).toBe('dropped');
  });
});

describe('resilience: one bad job never kills the poll (CR-05)', () => {
  it('evaluates each job in isolation', () => {
    // A corrupt durable job (unparseable cron) reconstructed from the log must not abort due().
    const store = new InMemorySchedulerStore();
    store.append({
      type: 'job-created',
      job: {
        id: 'job_corrupt',
        owner: 'owner-a',
        threadId: THREAD,
        kind: 'recurring',
        cronSource: 'totally invalid',
        fireAt: null,
        workloadTag: 'broken',
        authorityCeiling: CEILING,
        createdAt: BASE,
        expiresAt: BASE + RECURRING_EXPIRY_MS,
        jitterMs: 0,
      },
    });
    const { scheduler } = newScheduler({ store });
    const good = recurring(scheduler, '* * * * *', { durable: false });

    const fired = scheduler.due({ now: BASE + 90_000 });
    // The good job fires; the corrupt one is skipped rather than throwing.
    expect(fired.map((r) => r.job.id)).toEqual([good.id]);
  });
});

describe('authority intersection at fire time (CR-07)', () => {
  it('intersects the captured ceiling with current managed policy and never widens', () => {
    const ceiling = defaultAuthority('yolo', '/repo', NO_MANAGED_RESTRICTIONS);
    const { scheduler } = newScheduler();
    scheduler.create({
      kind: 'recurring',
      owner: 'owner-a',
      threadId: THREAD,
      cronExpr: '* * * * *',
      workloadTag: 'digest',
      authorityCeiling: ceiling,
      durable: false,
    });

    const tightManaged: ManagedPolicy = {
      ...NO_MANAGED_RESTRICTIONS,
      maxProfile: 'plan',
      maxIsolation: 'read-only',
      networkAllowed: false,
    };

    const fired = scheduler.due({ now: BASE + 90_000, managed: tightManaged });
    expect(fired).toHaveLength(1);
    const authority = fired[0]?.authority as Authority;
    expect(authority.profile).toBe('plan');
    expect(authority.isolation).toBe('read-only');
    expect(authority.networkAllowed).toBe(false);
    // The invariant: the fired authority is never wider than the captured ceiling.
    expect(isAtMost(authority, ceiling)).toBe(true);
  });

  it('leaves the ceiling intact under an unrestricted managed policy', () => {
    const { scheduler } = newScheduler();
    scheduler.create({
      kind: 'recurring',
      owner: 'owner-a',
      threadId: THREAD,
      cronExpr: '* * * * *',
      workloadTag: 'digest',
      authorityCeiling: CEILING,
      durable: false,
    });
    const fired = scheduler.due({ now: BASE + 90_000, managed: NO_MANAGED_RESTRICTIONS });
    expect(fired[0]?.authority.profile).toBe('ask');
  });
});
