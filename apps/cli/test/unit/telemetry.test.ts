import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CorrelationId, HarnessEvent, ThreadId } from '@qwen-harness/protocol';
import { MemoryTraceSink } from '@qwen-harness/telemetry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTelemetry, pruneTraces, traceEvent, traceFileName } from '../../src/telemetry.ts';

/**
 * Telemetry's two CONTROLS: opt-in (OB-02) and retention (OB-02).
 *
 * These are the properties a user is promised and that a config key claims to give them. Before this
 * work `telemetry.enabled` was read by `doctor` and consumed by nothing at all, which is the exact
 * failure this file exists to prevent recurring: a control that reports itself as on while doing
 * nothing is worse than an absent control, because the user stops looking.
 */

const clock = (now: number) => ({
  now: () => now,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

const DAY = 24 * 60 * 60 * 1_000;

describe('telemetry is opt-in', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-tel-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('disabled: no tracer, no directory, no file — the code path does not run', () => {
    const traceDir = join(dir, 'trace');
    const handle = openTelemetry({
      enabled: false,
      level: 'info',
      retentionDays: 7,
      dir: traceDir,
      clock: clock(0),
      secrets: [],
    });

    expect(handle.enabled).toBe(false);
    expect(handle.tracer).toBeNull();
    expect(handle.path).toBeNull();
    // Opt-in means nothing HAPPENS, not that the output is discarded. A directory created "just in
    // case" would already be a behaviour the user did not ask for.
    expect(() => readdirSync(traceDir)).toThrow();
  });

  it('enabled: a real JSONL file is opened and written', () => {
    const traceDir = join(dir, 'trace');
    const handle = openTelemetry({
      enabled: true,
      level: 'info',
      retentionDays: 7,
      dir: traceDir,
      clock: clock(Date.parse('2026-07-13T10:00:00Z')),
      secrets: [],
    });

    expect(handle.enabled).toBe(true);
    expect(handle.path).toBe(join(traceDir, 'trace-2026-07-13.jsonl'));
    handle.tracer!.info('test', 'hello', { a: 1 });
    expect(readdirSync(traceDir)).toEqual(['trace-2026-07-13.jsonl']);
  });

  it('the level is a floor: `warn` drops debug and info records', () => {
    const sink = new MemoryTraceSink();
    const handle = openTelemetry({
      enabled: true,
      level: 'warn',
      retentionDays: 7,
      dir: join(dir, 'trace'),
      clock: clock(0),
      secrets: [],
      sink,
    });

    handle.tracer!.debug('c', 'debug');
    handle.tracer!.info('c', 'info');
    handle.tracer!.warn('c', 'warn');
    handle.tracer!.error('c', 'error');

    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'error']);
    // `detailed` is a `debug`-only affordance: at `warn` the trace never carries content.
    expect(handle.detailed).toBe(false);
  });
});

describe('retention deletes trace files older than the window', () => {
  let dir: string;
  const now = Date.parse('2026-07-13T12:00:00Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-ret-'));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string) => writeFileSync(join(dir, name), '{}\n');

  it('deletes only files whose whole day is past the cutoff', () => {
    write(traceFileName(now)); // today
    write(traceFileName(now - 2 * DAY)); // 2 days old — inside a 7-day window
    write(traceFileName(now - 30 * DAY)); // 30 days old — expired

    const pruned = pruneTraces(dir, 7, now);

    expect(pruned).toEqual(['trace-2026-06-13.jsonl']);
    expect(readdirSync(dir).sort()).toEqual(['trace-2026-07-11.jsonl', 'trace-2026-07-13.jsonl']);
  });

  it('leaves a file it cannot date alone', () => {
    // Deleting a file merely because its name is unfamiliar is how an operator loses the evidence
    // they came for. An unparseable name is left in place, not swept.
    write('trace-not-a-date.jsonl');
    write('notes.txt');
    write(traceFileName(now - 90 * DAY));

    pruneTraces(dir, 1, now);

    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'trace-not-a-date.jsonl']);
  });

  it('a retention of 0 days still keeps today (the day is not over)', () => {
    write(traceFileName(now));
    pruneTraces(dir, 0, now);
    expect(readdirSync(dir)).toEqual([traceFileName(now)]);
  });
});

describe('the durable event log is the spine of the trace (OB-01)', () => {
  const event = (payload: HarnessEvent['payload']): HarnessEvent =>
    ({
      id: 'evt_000001',
      schemaVersion: 1,
      threadId: 'thr_000001' as ThreadId,
      seq: 1,
      timestamp: 0,
      turnId: null,
      itemId: null,
      correlationId: 'cor_000001' as CorrelationId,
      causationId: null,
      actor: { kind: 'model', id: 'act_model1' },
      permissionProfile: 'ask',
      payload,
    }) as unknown as HarnessEvent;

  const trace = (payload: HarnessEvent['payload'], detailed = false) => {
    const sink = new MemoryTraceSink();
    const handle = openTelemetry({
      enabled: true,
      level: 'debug',
      retentionDays: 7,
      dir: '/nonexistent',
      clock: clock(0),
      secrets: [],
      sink,
    });
    traceEvent(handle.tracer!, event(payload), detailed);
    return sink.records;
  };

  it('a policy decision reaches the trace with its reason and its source', () => {
    const [record] = trace({
      type: 'policy-decision',
      callId: 'call_1' as never,
      normalizedAction: 'run `rm -rf /`',
      decision: 'deny',
      reason: 'protected path',
      source: 'managed:root-deny',
    });

    expect(record!.category).toBe('policy.decision');
    expect(record!.fields['decision']).toBe('deny');
    expect(record!.fields['source']).toBe('managed:root-deny');
  });

  it('an approval and its resolution are both recorded', () => {
    expect(
      trace({
        type: 'approval-requested',
        callId: 'call_1' as never,
        normalizedAction: 'write x',
        risk: 'high',
      })[0]!.category,
    ).toBe('approval.requested');

    const [resolved] = trace({
      type: 'approval-resolved',
      callId: 'call_1' as never,
      granted: false,
      scope: null,
    });
    expect(resolved!.message).toBe('denied');
  });

  it('cancellation and budget warnings are not silently dropped', () => {
    expect(trace({ type: 'cancelled', scope: 'turn' })[0]!.level).toBe('warn');
    expect(
      trace({ type: 'budget-warning', budget: 'toolCallsPerTurn', used: 900, limit: 1000 })[0]!
        .level,
    ).toBe('warn');
  });

  it('a failed model request carries `retryable`, which is what a reader needs', () => {
    const [record] = trace({
      type: 'model-request-failed',
      requestId: 'req_1',
      category: 'provider.rate_limit.throttling',
      retryable: true,
      message: 'slow down',
    });
    expect(record!.level).toBe('error');
    expect(record!.fields['retryable']).toBe(true);
  });

  it('verbosity decides whether an item carries CONTENT or only its shape', () => {
    const item = {
      type: 'message',
      id: 'itm_1',
      role: 'assistant',
      text: 'the model said something',
    };

    const shape = trace({ type: 'item-appended', item: item as never }, false)[0]!;
    expect(shape.fields['item']).toBeUndefined();
    expect(shape.fields['itemDigest']).toBeTypeOf('string');

    const content = trace({ type: 'item-appended', item: item as never }, true)[0]!;
    expect(content.fields['item']).toEqual(item);
  });
});
