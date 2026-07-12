import { describe, expect, it } from 'vitest';

import { HarnessError, harnessError } from './errors.ts';
import { HarnessEventSchema, parseEventLenient, SCHEMA_VERSION } from './events.ts';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_000001',
    schemaVersion: SCHEMA_VERSION,
    seq: 0,
    timestamp: 1_700_000_000_000,
    threadId: 'thr_000001',
    turnId: null,
    itemId: null,
    actor: { kind: 'user', id: 'act_user01' },
    correlationId: 'cor_000001',
    causationId: null,
    permissionProfile: 'ask',
    ...overrides,
  };
}

describe('event envelope', () => {
  it('accepts a well-formed event', () => {
    const ev = HarnessEventSchema.parse(
      envelope({
        payload: {
          type: 'thread-created',
          cwd: '/w',
          canonicalRepo: null,
          name: null,
        },
      }),
    );
    expect(ev.payload.type).toBe('thread-created');
    expect(ev.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('rejects an event missing attribution — an unattributable event is never accepted', () => {
    const bad = envelope({
      payload: {
        type: 'thread-created',
        cwd: '/w',
        canonicalRepo: null,
        name: null,
      },
    });
    delete (bad as Record<string, unknown>)['actor'];
    expect(() => HarnessEventSchema.parse(bad)).toThrow();
  });

  it('rejects a mistyped id, so a TurnId can never be stored as a ThreadId', () => {
    expect(() =>
      HarnessEventSchema.parse(
        envelope({
          threadId: 'trn_000001', // wrong prefix
          payload: { type: 'thread-archived' },
        }),
      ),
    ).toThrow();
  });
});

describe('forward compatibility (RT-09)', () => {
  it('preserves an unknown future payload instead of dropping it', () => {
    const future = envelope({
      payload: {
        type: 'quantum-entangled',
        spookiness: 11,
        nested: { a: [1, 2] },
      },
    });

    const parsed = parseEventLenient(future);

    expect(parsed.payload.type).toBe('unknown');
    // The point of the test: the data SURVIVES. An older build must not silently lose it.
    expect(parsed.payload).toMatchObject({
      originalType: 'quantum-entangled',
      raw: { type: 'quantum-entangled', spookiness: 11, nested: { a: [1, 2] } },
    });
    // Envelope attribution is still fully intact.
    expect(parsed.threadId).toBe('thr_000001');
    expect(parsed.correlationId).toBe('cor_000001');
  });

  it('still refuses an unknown event with a broken envelope', () => {
    // Forward compatibility is not an excuse to accept garbage. Attribution stays mandatory.
    const broken = { payload: { type: 'whatever' } };
    expect(() => parseEventLenient(broken)).toThrow();
  });

  it('survives an export -> import -> export round trip without loss', () => {
    const future = envelope({ payload: { type: 'from-the-future', v: 42 } });
    const once = parseEventLenient(future);
    const twice = parseEventLenient(JSON.parse(JSON.stringify(once)));
    // Re-exporting a preserved-unknown event must not degrade it further.
    expect(twice.payload).toEqual(once.payload);
  });
});

describe('HarnessError retry semantics', () => {
  it('permits transparent retry only when it is genuinely safe', () => {
    const transient = harnessError({
      origin: 'provider',
      category: 'provider.throttling',
      message: 'Throttling',
      retryable: true,
    });
    expect(transient.canRetryTransparently()).toBe(true);
  });

  it('refuses to retry once visible output was emitted (PV-11)', () => {
    // Retrying here would concatenate a second stream onto text the user already saw.
    const midStream = harnessError({
      origin: 'network',
      category: 'network.disconnect',
      message: 'socket hang up',
      retryable: true,
      visibleOutputEmitted: true,
    });
    expect(midStream.retryable).toBe(true);
    expect(midStream.canRetryTransparently()).toBe(false);
  });

  it('refuses to retry when a side effect may already have happened', () => {
    for (const certainty of ['known-complete', 'indeterminate'] as const) {
      const e = harnessError({
        origin: 'tool',
        category: 'tool.timeout',
        message: 'tool timed out',
        retryable: true,
        sideEffectCertainty: certainty,
      });
      expect(e.canRetryTransparently(), `must not auto-retry a ${certainty} side effect`).toBe(
        false,
      );
    }
  });

  it('refuses to retry a quota/auth failure that only the user can fix', () => {
    const quota = harnessError({
      origin: 'provider',
      category: 'provider.quota.arrears',
      message: 'PostpaidBillOverdue',
      retryable: false,
      userActionRequired: true,
    });
    expect(quota.canRetryTransparently()).toBe(false);
  });

  it('round-trips through toData() without losing a field', () => {
    const e = harnessError({
      origin: 'provider',
      category: 'provider.rate_limit',
      message: 'slow down',
      retryable: true,
      requestId: 'req-123',
      retryAfterMs: 2000,
    });
    const revived = new HarnessError(e.toData());
    expect(revived.toData()).toEqual(e.toData());
    expect(revived.retryAfterMs).toBe(2000);
  });
});
