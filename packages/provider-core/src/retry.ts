import type { HarnessError } from '@qwen-harness/protocol';

/**
 * Bounded retry with exponential FULL jitter.
 *
 * The defaults are frozen in docs/product/defaults.md and are not tunable by a provider:
 * 10 attempts, bounded by 5 minutes, 500 ms base, 30 s cap, full jitter, honor server hint.
 *
 * `provider-core` is a PURE package, so there is no `Math.random()` anywhere in this file. The
 * random source is a parameter. That is not ceremony: it is the only way the backoff distribution
 * is testable at all, and it keeps the whole runtime replayable (RT-08).
 */

/** Returns a float in `[0, 1)`. Injected — never taken from the ambient environment. */
export type Rng = () => number;

export interface RetryPolicy {
  /** Total attempts INCLUDING the first. 10 means one initial call plus at most nine retries. */
  readonly maxAttempts: number;
  /** Hard ceiling on the whole retry sequence, measured from the first attempt. */
  readonly maxElapsedMs: number;
  readonly baseDelayMs: number;
  /** Upper bound of the exponential term, before jitter. Jitter can still return less. */
  readonly maxDelayMs: number;
  /** When the server names a delay, prefer it over our own guess. */
  readonly honorServerHint: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 10,
  maxElapsedMs: 5 * 60 * 1000,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  honorServerHint: true,
});

/**
 * The exponential bound for a retry, before jitter: `min(cap, base * 2^attempt)`.
 * `attempt` is 0-based (0 = the delay before the first retry).
 */
export function backoffBoundMs(policy: RetryPolicy, attempt: number): number {
  const exponent = Math.max(0, Math.trunc(attempt));
  // 2**exponent overflows to Infinity long before it matters; min() collapses it to the cap.
  const raw = policy.baseDelayMs * 2 ** exponent;
  return Math.min(policy.maxDelayMs, raw);
}

/**
 * Full jitter: `random(0, min(cap, base * 2^attempt))`, inclusive of both ends.
 *
 * Not "exponential with a bit of noise" — the whole interval. Equal jitter still synchronizes a
 * thundering herd around the lower half; full jitter is what actually spreads a fleet out.
 */
export function fullJitterDelayMs(policy: RetryPolicy, attempt: number, rng: Rng): number {
  const bound = backoffBoundMs(policy, attempt);
  const r = rng();
  if (!Number.isFinite(r) || r < 0 || r >= 1) {
    throw new RangeError(`rng() must return a float in [0, 1); received ${String(r)}`);
  }
  return Math.floor(r * (bound + 1));
}

export interface RetryState {
  /** How many attempts have already been made, including the one that just failed. `>= 1`. */
  readonly attempt: number;
  /** Milliseconds since the first attempt started. */
  readonly elapsedMs: number;
}

export type RetryRefusal =
  | 'not-retryable'
  | 'user-action-required'
  | 'visible-output-emitted'
  | 'side-effect-uncertain'
  | 'attempts-exhausted'
  | 'time-exhausted';

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false; readonly reason: RetryRefusal };

/**
 * Decide whether a failed attempt may be retried, and after how long.
 *
 * The refusal reasons are separate on purpose: "we ran out of attempts" and "retrying would
 * concatenate a second stream onto text the user already saw" are different facts, and the second
 * one is a correctness bug rather than a budget. `HarnessError.canRetryTransparently()` already
 * encodes that rule; this function reports WHICH clause of it refused, so a turn can explain
 * itself instead of just stopping.
 */
export function decideRetry(
  error: HarnessError,
  state: RetryState,
  rng: Rng,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryDecision {
  if (!error.retryable) return { retry: false, reason: 'not-retryable' };
  if (error.userActionRequired) return { retry: false, reason: 'user-action-required' };
  // PV-11: a retry stream must never be appended to partial visible output.
  if (error.visibleOutputEmitted) return { retry: false, reason: 'visible-output-emitted' };
  if (error.sideEffectCertainty !== 'none' && error.sideEffectCertainty !== 'not-started') {
    return { retry: false, reason: 'side-effect-uncertain' };
  }
  if (state.attempt >= policy.maxAttempts) return { retry: false, reason: 'attempts-exhausted' };
  if (state.elapsedMs >= policy.maxElapsedMs) return { retry: false, reason: 'time-exhausted' };

  const jittered = fullJitterDelayMs(policy, state.attempt - 1, rng);
  const hint = error.retryAfterMs;
  const delayMs = policy.honorServerHint && hint !== null ? hint : jittered;

  // A hint we cannot honor inside the 5-minute budget is not a reason to ignore the budget.
  if (state.elapsedMs + delayMs > policy.maxElapsedMs) {
    return { retry: false, reason: 'time-exhausted' };
  }
  return { retry: true, delayMs };
}
