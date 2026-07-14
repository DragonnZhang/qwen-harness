import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyHttpError, type ClassifyInput } from './errors.ts';

/**
 * Property test for the DashScope HTTP error classifier (PV-10 `P`).
 *
 * Classification decides retry behaviour, so it must be TOTAL and self-consistent over any response
 * the service (or a hostile proxy) could send. Over arbitrary status + vendor code + body, we prove:
 *   - it never throws and always yields a typed `provider.*` category;
 *   - `retryable` and `userActionRequired` are mutually exclusive (a call is never both);
 *   - an UNRECOGNISED 429 defaults to user-action-required, never a silent retry (task.md PV-10);
 *   - the request id and retry-after are preserved (body value wins, else the header value);
 *   - a known transient rate-limit code (Throttling/RateQuota/BurstRate) is always retryable.
 */

const KNOWN_CODES = [
  'throttling',
  'ratequota',
  'burstrate',
  'requesttimeout',
  'allocationquota',
  'insufficient_quota',
  'invalidapikey',
  'arrearage',
  'modelnotfound',
  'invalidparameter',
] as const;

const arbInput = fc.record({
  status: fc.oneof(
    fc.constantFrom(400, 401, 403, 404, 429, 500, 502, 503),
    fc.integer({ min: 400, max: 599 }),
  ),
  body: fc.record({
    code: fc.oneof(fc.constant(null), fc.constantFrom(...KNOWN_CODES), fc.string()),
    message: fc.option(fc.string(), { nil: null }),
    requestId: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    retryAfterMs: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
  }),
  headerRequestId: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  headerRetryAfterMs: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
  visibleOutputEmitted: fc.boolean(),
}) as fc.Arbitrary<ClassifyInput>;

describe('classifyHttpError invariants (PV-10 P)', () => {
  it('is total and always yields a typed provider category', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const err = classifyHttpError(input);
        expect(typeof err.category).toBe('string');
        expect(err.category.startsWith('provider.')).toBe(true);
        expect(typeof err.retryable).toBe('boolean');
        expect(typeof err.userActionRequired).toBe('boolean');
      }),
      { numRuns: 2000 },
    );
  });

  it('never marks a call BOTH retryable and user-action-required', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const err = classifyHttpError(input);
        expect(err.retryable && err.userActionRequired).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });

  it('an unrecognised 429 (no code) is user-action-required, never a silent retry', () => {
    fc.assert(
      fc.property(
        arbInput.map((i) => ({ ...i, status: 429, body: { ...i.body, code: null } })),
        (input) => {
          const err = classifyHttpError(input);
          expect(err.retryable).toBe(false);
          expect(err.userActionRequired).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('preserves the request id (body wins, else header) and the retry-after', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const err = classifyHttpError(input);
        expect(err.requestId).toBe(input.body.requestId ?? input.headerRequestId);
        expect(err.retryAfterMs).toBe(input.body.retryAfterMs ?? input.headerRetryAfterMs);
      }),
      { numRuns: 2000 },
    );
  });

  it('always retries a known transient rate-limit code', () => {
    fc.assert(
      fc.property(
        arbInput.map((i) => ({
          ...i,
          body: { ...i.body, code: 'throttling' as string },
        })),
        (input) => {
          expect(classifyHttpError(input).retryable).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});
