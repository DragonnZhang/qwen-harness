import { EventStore } from '@qwen-harness/storage';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import { TurnEngine, type EventSink, type ToolExecutor } from '../../src/index.ts';

/**
 * TL-08 (I + F) — the turn engine runs a round's INDEPENDENT read calls in a PARALLEL batch, driven
 * by the executor's `planBatches`, while keeping the durable log deterministic and every call paired
 * to exactly one result.
 *
 * The tool executor is a fake so we can (a) decide the batching (its `planBatches` groups the reads)
 * and (b) PROVE concurrency with a barrier: each `execute` waits until BOTH calls have entered. If the
 * engine ran them serially, the first would wait forever for a second that never starts, and the
 * barrier's bounded fallback would fire — leaving `maxInFlight === 1`. Concurrency makes it 2.
 *
 * The STORE is real, so this also proves the persistence ordering: with concurrent execution, intents
 * are still written for every call before any result (phase 1), then results after (phase 3).
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scriptedProvider(rounds: ProviderStreamEvent[][]): ModelProvider {
  let i = 0;
  return {
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: false,
      reasoningEffortGranularity: 'none',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream() {
      const round = rounds[i++] ?? [{ type: 'done', finishReason: 'stop' }];
      for (const e of round) yield e;
    },
  };
}

function readCall(callId: string, path: string): ProviderStreamEvent {
  return {
    type: 'tool-call-complete',
    itemId: `it_${callId}`,
    callId,
    toolName: 'read_file',
    argumentsJson: JSON.stringify({ path }),
    arguments: { path },
  };
}

/**
 * A fake executor whose `execute` is a 2-party barrier: it records the peak number of simultaneously
 * in-flight executions. `plan` decides whether the engine even attempts concurrency.
 */
function barrierExecutor(opts: {
  plan: boolean;
  failCallId?: string;
}): ToolExecutor & { state: { maxInFlight: number } } {
  let inFlight = 0;
  const state = { maxInFlight: 0 };
  let entered = 0;
  let release!: () => void;
  const bothEntered = new Promise<void>((r) => {
    release = r;
  });
  const base: ToolExecutor = {
    evaluate: (call) =>
      Promise.resolve({
        status: 'allow' as const,
        actionDigest: `digest:${call.callId}`,
        description: call.toolName,
        risk: 'low' as const,
        reason: 'reads are allowed',
        source: 'test:fake',
      }),
    intentFor: (call) => ({
      idempotencyKey: `${call.toolName}:${JSON.stringify(call.arguments)}`,
      destructive: false,
      kind: 'other' as const,
      normalizedAction: call.toolName,
    }),
    execute: async (call) => {
      inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      entered += 1;
      if (entered >= 2) release();
      // Wait until BOTH executions are in flight (proves overlap), with a bounded fallback so a serial
      // regression fails on the assertion instead of hanging forever.
      await Promise.race([bothEntered, delay(1500)]);
      inFlight -= 1;
      const ok = call.callId !== opts.failCallId;
      return {
        ok,
        modelText: ok ? `read ${String(call.arguments['path'])}` : 'read failed',
        userText: ok ? 'ok' : 'failed',
        errorCategory: ok ? null : ('execution-failed' as never),
        resultDigest: ok ? 'sha' : null,
        outputRef: null,
        truncated: false,
        durationMs: 5,
      };
    },
  };
  if (opts.plan) {
    // Group EVERY call of this round into a single parallel batch (they are independent reads).
    base.planBatches = (calls) => [calls.map((c) => c.callId)];
  }
  return Object.assign(base, { state });
}

describe('TurnEngine parallel tool batches (TL-08)', () => {
  let store: EventStore;
  let clock: ManualClock;
  let ids: SequentialIds;

  beforeEach(() => {
    clock = new ManualClock(1_700_000_000_000);
    ids = new SequentialIds();
    store = new EventStore({ path: ':memory:', clock, ids });
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
  });

  const sink = (): EventSink => ({
    append: (input) =>
      store.append({ ...input, causationId: (input.causationId ?? null) as never }),
    mayExecute: (key) => store.mayExecute(key),
  });

  const twoReadsThenDone = (): ProviderStreamEvent[][] => [
    [
      readCall('call_read0000000001', 'a.ts'),
      readCall('call_read0000000002', 'b.ts'),
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'text-done', itemId: 'm', text: 'done' },
      { type: 'done', finishReason: 'stop' },
    ],
  ];

  const run = (exec: ToolExecutor): Promise<{ state: string }> =>
    new TurnEngine({
      provider: scriptedProvider(twoReadsThenDone()),
      tools: exec,
      sink: sink(),
      ids,
      clock,
    }).run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'read both files',
      tools: [],
      actor: MODEL_ACTOR,
    });

  it('runs two independent reads CONCURRENTLY when the executor batches them (I)', async () => {
    const exec = barrierExecutor({ plan: true });
    const result = await run(exec);
    expect(result.state).toBe('completed');
    // Concurrency proven: both executions were in flight at the same time.
    expect(exec.state.maxInFlight).toBe(2);

    const events = store.readThread(THREAD).map((e) => e.payload);
    // Both calls produced a durable tool-result, each paired to its own call id (ordering preserved).
    const results = events.filter(
      (p): p is Extract<typeof p, { type: 'item-appended' }> =>
        p.type === 'item-appended' && p.item.type === 'tool-result',
    );
    expect(results.map((r) => (r.item.type === 'tool-result' ? r.item.callId : ''))).toEqual([
      'call_read0000000001',
      'call_read0000000002',
    ]);
    // Deterministic durable ordering: with concurrent EXECUTION, both intents are still persisted
    // before either result (phase 1 records intent for each call in order, phase 3 records results).
    const types = events.map((p) => p.type);
    const lastIntent = types.lastIndexOf('side-effect-intent');
    const firstSettled = types.indexOf('side-effect-settled');
    expect(lastIntent).toBeLessThan(firstSettled);
  });

  it('falls back to SERIAL when the executor does not batch (no planBatches)', async () => {
    const exec = barrierExecutor({ plan: false });
    const result = await run(exec);
    expect(result.state).toBe('completed');
    // With no batching the engine runs calls one at a time — they never overlap.
    expect(exec.state.maxInFlight).toBe(1);
  });

  it('a FAILURE in a parallel batch does not corrupt its siblings’ pairing (F)', async () => {
    const exec = barrierExecutor({ plan: true, failCallId: 'call_read0000000001' });
    const result = await run(exec);
    expect(result.state).toBe('completed');
    expect(exec.state.maxInFlight).toBe(2);

    const results = store
      .readThread(THREAD)
      .map((e) => e.payload)
      .filter(
        (p): p is Extract<typeof p, { type: 'item-appended' }> =>
          p.type === 'item-appended' && p.item.type === 'tool-result',
      )
      .map((p) => (p.item.type === 'tool-result' ? p.item : null))
      .filter((i): i is NonNullable<typeof i> => i !== null);
    // Both calls still have exactly one result, paired correctly; only the failing one is not ok.
    expect(results).toHaveLength(2);
    const byId = new Map(results.map((r) => [r.callId, r.ok]));
    expect(byId.get('call_read0000000001')).toBe(false);
    expect(byId.get('call_read0000000002')).toBe(true);
  });
});
