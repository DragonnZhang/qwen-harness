import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { MemoryTraceSink, Tracer } from './index.ts';

/** A redactor that scrubs a canary, standing in for storage's real Redactor at the app boundary. */
const SECRET = 'super-secret-token-value-000';
const redact = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return JSON.parse(s.split(SECRET).join('[REDACTED]'));
};

describe('Tracer', () => {
  it('stamps time from the injected clock (deterministic)', () => {
    const clock = new ManualClock(1000);
    const sink = new MemoryTraceSink();
    const tracer = new Tracer({ clock, sink, redact });
    tracer.info('provider.request', 'started');
    clock.advance(50);
    tracer.info('provider.request', 'done');
    expect(sink.records.map((r) => r.ts)).toEqual([1000, 1050]);
  });

  it('redacts every field AND the message before writing — leaks are impossible here', () => {
    const sink = new MemoryTraceSink();
    const tracer = new Tracer({ clock: new ManualClock(0), sink, redact });
    tracer.error('provider.auth', `failed with ${SECRET}`, {
      header: `Bearer ${SECRET}`,
      code: 401,
    });
    const record = sink.records[0]!;
    expect(record.message).not.toContain(SECRET);
    expect(JSON.stringify(record.fields)).not.toContain(SECRET);
    expect(record.fields['code']).toBe(401);
  });

  it('respects the minimum level', () => {
    const sink = new MemoryTraceSink();
    const tracer = new Tracer({ clock: new ManualClock(0), sink, redact, minLevel: 'warn' });
    tracer.debug('x', 'ignored');
    tracer.info('x', 'ignored');
    tracer.warn('x', 'kept');
    tracer.error('x', 'kept');
    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('tags records with a correlation id via a child tracer', () => {
    const sink = new MemoryTraceSink();
    const tracer = new Tracer({ clock: new ManualClock(0), sink, redact }).withCorrelation('cor_1');
    tracer.info('x', 'y');
    expect(sink.records[0]!.correlationId).toBe('cor_1');
  });

  it('times a span and records duration; a throw is recorded and re-thrown', async () => {
    const clock = new ManualClock(0);
    const sink = new MemoryTraceSink();
    const tracer = new Tracer({ clock, sink, redact });

    await tracer.span('tool.exec', 'ok op', () => {
      clock.advance(10);
      return Promise.resolve(42);
    });
    expect(sink.records[0]!.fields).toMatchObject({ durationMs: 10, ok: true });

    await expect(
      tracer.span('tool.exec', 'bad op', () => {
        clock.advance(5);
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    // The failure was RECORDED, not swallowed.
    expect(sink.records[1]!.fields).toMatchObject({ ok: false, error: 'boom' });
  });
});
