/**
 * The job model and its deterministic jitter (CR-03).
 *
 * A `CronJob` is either recurring (a cron expression, a 7-day expiry) or one-shot (a fixed fire
 * instant). Both capture an immutable authority ceiling at creation (CR-07) and a jitter seeded from
 * the job id, so the same job always jitters by the same amount — reproducible across processes and
 * replays, never `Math.random()`.
 */

import type { Authority } from '@qwen-harness/policy';
import type { ThreadId } from '@qwen-harness/protocol';

export type JobKind = 'recurring' | 'one-shot';

/**
 * A job's lifecycle status.
 *
 *   active   eligible to fire.
 *   fired    a one-shot that has fired (terminal for one-shots).
 *   missed   a DURABLE one-shot whose instant elapsed during downtime; requires explicit rerun.
 *   dropped  a SESSION one-shot whose instant elapsed during downtime; never catches up (CR-05).
 *   expired  a recurring job past its 7-day expiry.
 *   deleted  removed by the owner (terminal).
 */
export type JobStatus = 'active' | 'fired' | 'missed' | 'dropped' | 'expired' | 'deleted';

/** Recurring jobs expire 7 days after creation unless renewed (docs/product/defaults.md). */
export const RECURRING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** No owner may hold more than this many live jobs (docs/product/defaults.md). */
export const MAX_JOBS_PER_OWNER = 50;

/** Jitter is capped at 15 minutes regardless of interval (docs/product/defaults.md). */
export const MAX_JITTER_MS = 15 * 60 * 1000;

/** Default jitter is at most 10% of the interval. */
export const JITTER_FRACTION = 0.1;

export interface CronJob {
  readonly id: string;
  readonly owner: string;
  readonly threadId: ThreadId;
  readonly kind: JobKind;
  /** Recurring only: the cron source string. */
  readonly cronSource: string | null;
  /** One-shot only: the fire instant (epoch ms). */
  readonly fireAt: number | null;
  readonly workloadTag: string;
  /** The authority ceiling captured at creation and intersected with managed policy at fire time. */
  readonly authorityCeiling: Authority;
  readonly createdAt: number;
  /** Recurring jobs carry a 7-day expiry; one-shots carry `null`. */
  readonly expiresAt: number | null;
  /** Durable jobs persist through storage and resume after downtime; session jobs do not (CR-04). */
  readonly durable: boolean;
  /** Deterministic per-job jitter, seeded from {@link id}. */
  readonly jitterMs: number;
}

/**
 * A stable 32-bit hash of a string (FNV-1a). Deterministic and dependency-free — the point is that a
 * job id maps to the SAME jitter everywhere, so this must never use randomness.
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned space via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic jitter for a job: `min(10% of interval, 15 min)`, seeded from the job id (CR-03). An
 * interval of `null` (a one-shot, which has no repeat interval) gets no jitter. The value lands in
 * `[0, cap]` and is stable for a given id — the same id always produces the same jitter.
 */
export function deterministicJitterMs(id: string, intervalMs: number | null): number {
  if (intervalMs === null || intervalMs <= 0) return 0;
  const cap = Math.floor(Math.min(JITTER_FRACTION * intervalMs, MAX_JITTER_MS));
  if (cap <= 0) return 0;
  // Map the hash into [0, cap]. `+ 1` makes the range inclusive of `cap`.
  return hashString(id) % (cap + 1);
}
