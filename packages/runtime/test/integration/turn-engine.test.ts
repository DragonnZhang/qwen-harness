import { EventStore } from '@qwen-harness/storage';
import {
  harnessError,
  HarnessError,
  type CorrelationId,
  type ThreadId,
} from '@qwen-harness/protocol';
import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import { TurnEngine, type EventSink, type ToolExecutor } from '../../src/index.ts';

/**
 * The turn engine wired to the REAL event store, driven by a scripted provider and a fake tool
 * executor. This proves the persisted agent loop: every transition and side effect is written to
 * the durable log in the right order, so recovery can read a coherent story afterward.
 *
 * The provider and tool executor are fakes (deterministic), but the STORAGE is real — the point of
 * the test is the persistence ordering, which a fake store would not exercise.
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;

/** A provider that plays back a fixed script of rounds, one per call. */
function scriptedProvider(rounds: ProviderStreamEvent[][]): ModelProvider {
  let i = 0;
  return {
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: true,
      reasoningEffortGranularity: 'graded',
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

/** A tool executor that records calls and returns a canned success. */
function recordingExecutor(): ToolExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    // The real executor asks the policy engine here. This fake allows everything, which is exactly
    // what the OLD behavior of these tests assumed — they are about persistence ordering, and the
    // approval path has its own tests against the real policy engine (apps/cli, apps/daemon).
    evaluate: (call) =>
      Promise.resolve({
        status: 'allow' as const,
        actionDigest: `digest:${call.toolName}`,
        description: call.toolName,
        risk: 'low' as const,
        reason: 'the fake executor allows everything',
        source: 'test:fake',
      }),
    intentFor: (call) => ({
      idempotencyKey: `${call.toolName}:${JSON.stringify(call.arguments)}`,
      destructive: call.toolName.startsWith('write'),
      kind: call.toolName.startsWith('write') ? 'file-write' : 'other',
      normalizedAction: `${call.toolName}`,
    }),
    execute: (call) => {
      calls.push(call.toolName);
      return Promise.resolve({
        ok: true,
        modelText: `${call.toolName} ok`,
        userText: `${call.toolName} ok`,
        errorCategory: null,
        resultDigest: 'sha-result',
        outputRef: null,
        truncated: false,
        durationMs: 5,
      });
    },
  };
}

describe('TurnEngine persisted loop', () => {
  let store: EventStore;
  let clock: ManualClock;
  let ids: SequentialIds;

  beforeEach(() => {
    clock = new ManualClock(1_700_000_000_000);
    ids = new SequentialIds();
    store = new EventStore({ path: ':memory:', clock, ids });
    // The thread must exist before the turn runs.
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

  it('runs a tool round then completes, persisting every transition in order', async () => {
    const provider = scriptedProvider([
      // Round 1: the model calls a tool.
      [
        { type: 'reasoning-summary-done', itemId: 'r', summary: 'I should write the file.' },
        {
          type: 'tool-call-complete',
          itemId: 't',
          callId: 'call_e0f2efaa4f7944dca038',
          toolName: 'write_file',
          argumentsJson: '{"path":"a.ts"}',
          arguments: { path: 'a.ts' },
        },
        {
          type: 'usage',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            reasoningTokens: 2,
            cachedInputTokens: 0,
          },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      // Round 2: the model is satisfied and stops.
      [
        { type: 'text-done', itemId: 'm', text: 'Done — the file is written.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const exec = recordingExecutor();

    const engine = new TurnEngine({ provider, tools: exec, sink: sink(), ids, clock });
    const result = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'write a.ts',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(result.state).toBe('completed');
    expect(result.terminationReason).toBe('natural-completion');
    expect(result.rounds).toBe(2);
    expect(result.finalText).toBe('Done — the file is written.');
    expect(exec.calls).toEqual(['write_file']);

    // The durable log tells a coherent story: the side-effect intent is persisted BEFORE it starts,
    // and settled AFTER — this ordering is what makes recovery correct (SS-05).
    const events = store.readThread(THREAD).map((e) => e.payload.type);
    const intentIdx = events.indexOf('side-effect-intent');
    const startedIdx = events.indexOf('side-effect-started');
    const settledIdx = events.indexOf('side-effect-settled');
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(intentIdx).toBeLessThan(startedIdx);
    expect(startedIdx).toBeLessThan(settledIdx);

    // The turn ended exactly once, with a reason.
    expect(events.filter((t) => t === 'turn-ended')).toHaveLength(1);

    // The side effect is now known-complete, so recovery would refuse to replay it.
    expect(store.mayExecute('write_file:{"path":"a.ts"}').allowed).toBe(false);
  });

  it('stops with a named reason when the model loops with no progress', async () => {
    // The model keeps producing empty rounds (no tool call, no text). This is a stuck loop, and the
    // engine must terminate it for a NAMED reason rather than spinning forever.
    const emptyRound: ProviderStreamEvent[] = [{ type: 'done', finishReason: 'stop' }];
    // First empty round completes naturally (no tools) — so to test no-progress we need rounds that
    // DO call a tool but make no progress. Simulate repeated identical calls instead.
    const provider = scriptedProvider(
      Array.from({ length: 10 }, () => [
        {
          type: 'tool-call-complete',
          itemId: 't',
          callId: 'call_x1a2b3c4d5e6f7890',
          toolName: 'search',
          argumentsJson: '{"pattern":"x"}',
          arguments: { pattern: 'x' },
        } as ProviderStreamEvent,
        { type: 'done', finishReason: 'tool_calls' } as ProviderStreamEvent,
      ]),
    );
    void emptyRound;
    const exec = recordingExecutor();

    const engine = new TurnEngine({
      provider,
      tools: exec,
      sink: sink(),
      ids,
      clock,
      budget: {
        maxTurns: 200,
        maxModelCallsPerTurn: 100,
        maxToolCallsPerTurn: 1000,
        maxWallMs: 1e9,
        maxRetries: 10,
        maxNoProgressRounds: 3,
        maxRepeatedIdenticalCalls: 3,
      },
    });
    const result = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: '',
      history: [],
      userText: 'search forever',
      tools: [],
      actor: MODEL_ACTOR,
    });

    // The identical-repeated-call detector fires and names the reason.
    expect(result.state).toBe('budget-exhausted');
    expect(result.terminationReason).toBe('repeated-identical-calls');
  });
});

describe('TurnEngine PreToolUse hook gating (HK-04/HK-05)', () => {
  let store2: EventStore;
  let clock2: ManualClock;
  let ids2: SequentialIds;

  beforeEach(() => {
    clock2 = new ManualClock(1_700_000_000_000);
    ids2 = new SequentialIds();
    store2 = new EventStore({ path: ':memory:', clock: clock2, ids: ids2 });
    store2.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
  });

  const sink2 = (): EventSink => ({
    append: (input) =>
      store2.append({ ...input, causationId: (input.causationId ?? null) as never }),
    mayExecute: (key) => store2.mayExecute(key),
  });

  it('a blocking PreToolUse hook prevents the tool from executing AND from recording intent', async () => {
    const provider = scriptedProvider([
      [
        {
          type: 'tool-call-complete',
          itemId: 't',
          callId: 'call_blocked00001',
          toolName: 'write_file',
          argumentsJson: '{"path":"a.ts"}',
          arguments: { path: 'a.ts' },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-done', itemId: 'm', text: 'ok, I will not write.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const exec = recordingExecutor();

    const engine = new TurnEngine({
      provider,
      tools: exec,
      sink: sink2(),
      ids: ids2,
      clock: clock2,
      hooks: {
        // Block every write.
        preToolUse: (call) =>
          Promise.resolve({
            blocked: call.toolName === 'write_file',
            reason: 'writes are blocked in this test',
          }),
        postToolUse: () => Promise.resolve(),
      },
    });

    const result = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      model: 'fake',
      instructions: '',
      history: [],
      userText: 'write a.ts',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(result.state).toBe('completed');
    // The tool executor was NEVER called — the hook blocked it.
    expect(exec.calls).toEqual([]);

    const events = store2.readThread(THREAD).map((e) => e.payload);
    // A hook-fired(PreToolUse, block) is recorded...
    const hookFired = events.filter((p) => p.type === 'hook-fired');
    expect(
      hookFired.some(
        (p) => p.type === 'hook-fired' && p.event === 'PreToolUse' && p.outcome === 'block',
      ),
    ).toBe(true);
    // ...and NO side-effect intent was persisted, because nothing happened.
    expect(events.some((p) => p.type === 'side-effect-intent')).toBe(false);
  });

  it('PostToolUse fires after an allowed tool, and the tool ran', async () => {
    const provider = scriptedProvider([
      [
        {
          type: 'tool-call-complete',
          itemId: 't',
          callId: 'call_allowed00001',
          toolName: 'read_file',
          argumentsJson: '{"path":"a.ts"}',
          arguments: { path: 'a.ts' },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-done', itemId: 'm', text: 'done' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const exec = recordingExecutor();
    let postCalls = 0;

    const engine = new TurnEngine({
      provider,
      tools: exec,
      sink: sink2(),
      ids: ids2,
      clock: clock2,
      hooks: {
        preToolUse: () => Promise.resolve({ blocked: false, reason: null }),
        postToolUse: () => {
          postCalls++;
          return Promise.resolve();
        },
      },
    });

    await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      model: 'fake',
      instructions: '',
      history: [],
      userText: 'read a.ts',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(exec.calls).toEqual(['read_file']);
    expect(postCalls).toBe(1);
    const events = store2.readThread(THREAD).map((e) => e.payload);
    expect(events.some((p) => p.type === 'hook-fired' && p.event === 'PostToolUse')).toBe(true);
  });
});

/**
 * Transient-fault retry around the provider call (RT-04, golden path 9).
 *
 * The retry policy lived in `provider-core` — implemented, tested — but the turn loop called
 * `provider.stream()` with no retry wrapper, so a retryable 503 or dropped connection failed the
 * whole turn. Golden path 9 requires surviving that. These tests drive the REAL engine over the
 * REAL store with a provider that throws, and assert the boundary: a retryable fault recovers, a
 * non-retryable one does not, and retries are BOUNDED (never an infinite loop).
 */
describe('TurnEngine: transient provider-fault retry (RT-04)', () => {
  const THREAD_R = 'thr_00retr' as ThreadId;
  const CORR_R = 'cor_00retr' as CorrelationId;

  /** A provider whose Nth stream() call throws `err`, and which otherwise replies and stops. */
  function faultThenOk(throwsOnAttempts: number, err: Error): ModelProvider & { attempts: number } {
    const p = {
      attempts: 0,
      capabilities: freezeCapabilities({
        textStreaming: true,
        reasoningSummary: false,
        reasoningEffortGranularity: 'none' as const,
        incrementalToolArgs: false,
        background: false,
        structuredOutput: false,
        toolStream: false,
      }),
      async *stream(): AsyncGenerator<ProviderStreamEvent> {
        p.attempts += 1;
        if (p.attempts <= throwsOnAttempts) throw err;
        yield { type: 'text-done', itemId: 'm', text: 'recovered' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    return p;
  }

  function newStore() {
    const clock = new ManualClock(1_700_000_000_000);
    const ids = new SequentialIds();
    const store = new EventStore({ path: ':memory:', clock, ids });
    store.append({
      threadId: THREAD_R,
      correlationId: CORR_R,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
    return { clock, ids, store };
  }

  const retryable = (): HarnessError =>
    harnessError({
      origin: 'provider',
      category: 'provider.transient.service_unavailable',
      message: 'service temporarily unavailable',
      retryable: true,
    });

  const permanent = (): HarnessError =>
    harnessError({
      origin: 'provider',
      category: 'provider.auth.invalid_key',
      message: 'invalid api key',
      retryable: false,
      userActionRequired: true,
    });

  it('recovers from a retryable fault and completes the turn', async () => {
    const { clock, ids, store } = newStore();
    const provider = faultThenOk(2, retryable()); // fail twice, succeed on the third
    const engine = new TurnEngine({
      provider,
      tools: recordingExecutor(),
      sink: {
        append: (e) => store.append({ ...e, causationId: (e.causationId ?? null) as never }),
      },
      ids,
      clock,
      rng: () => 0.5, // deterministic jitter
      // Instant backoff so the test does not actually wait out the exponential delay.
      retryPolicy: {
        maxAttempts: 5,
        maxElapsedMs: 60_000,
        baseDelayMs: 1,
        maxDelayMs: 1,
        honorServerHint: true,
      },
    });
    // The clock's sleep is provided by the store's clock? No — inject an instant sleep.
    (clock as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();

    const result = await engine.run({
      threadId: THREAD_R,
      correlationId: CORR_R,
      permissionProfile: 'ask',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'hi',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(provider.attempts).toBe(3); // two failures + one success
    expect(result.state).toBe('completed');
    expect(result.finalText).toBe('recovered');
  });

  it('does NOT retry a non-retryable fault — it fails once, immediately', async () => {
    const { clock, ids, store } = newStore();
    const provider = faultThenOk(1, permanent());
    const engine = new TurnEngine({
      provider,
      tools: recordingExecutor(),
      sink: {
        append: (e) => store.append({ ...e, causationId: (e.causationId ?? null) as never }),
      },
      ids,
      clock,
      rng: () => 0.5,
    });
    (clock as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();

    const result = await engine.run({
      threadId: THREAD_R,
      correlationId: CORR_R,
      permissionProfile: 'ask',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'hi',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(provider.attempts).toBe(1); // NOT retried
    expect(result.state).toBe('failed');
  });

  it('retries are BOUNDED — a permanently-failing retryable fault stops at the attempt budget', async () => {
    const { clock, ids, store } = newStore();
    const provider = faultThenOk(999, retryable()); // never succeeds
    const engine = new TurnEngine({
      provider,
      tools: recordingExecutor(),
      sink: {
        append: (e) => store.append({ ...e, causationId: (e.causationId ?? null) as never }),
      },
      ids,
      clock,
      rng: () => 0.5,
      retryPolicy: {
        maxAttempts: 4,
        maxElapsedMs: 60_000,
        baseDelayMs: 1,
        maxDelayMs: 1,
        honorServerHint: true,
      },
    });
    (clock as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();

    const result = await engine.run({
      threadId: THREAD_R,
      correlationId: CORR_R,
      permissionProfile: 'ask',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'hi',
      tools: [],
      actor: MODEL_ACTOR,
    });

    // Exactly maxAttempts tries, then it fails — never an infinite loop.
    expect(provider.attempts).toBe(4);
    expect(result.state).toBe('failed');
  });
});

/**
 * Regression: multi-round tool turns must send the model a COMPLETE call↔output pairing.
 *
 * The engine used to push the assistant's text into the intra-turn conversation but NOT the
 * assistant's function-CALL items, so round 2 received an orphaned `function-output` with no
 * matching `function-call`. Because the DashScope transport omits `previous_response_id` (local
 * history is authoritative, PV-08), the model could not tell its call was answered and re-issued
 * the identical call every round → `repeated-identical-calls` / budget-exhausted. This was invisible
 * to every existing test because none required the model to CONSUME a tool result. A live
 * MCP/compaction turn surfaced it. This test captures the exact request input round 2 receives.
 */
describe('TurnEngine: multi-round conversation carries the function-call, not just its output', () => {
  const THREAD_P = 'thr_00pair' as ThreadId;
  const CORR_P = 'cor_00pair' as CorrelationId;

  it('round 2 input contains the function-call paired before its function-output', async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const ids = new SequentialIds();
    const store = new EventStore({ path: ':memory:', clock, ids });
    store.append({
      threadId: THREAD_P,
      correlationId: CORR_P,
      permissionProfile: 'yolo',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });

    // Records the `input` given to each stream() call.
    const inputs: unknown[][] = [];
    const provider: ModelProvider = {
      capabilities: freezeCapabilities({
        textStreaming: true,
        reasoningSummary: false,
        reasoningEffortGranularity: 'none',
        incrementalToolArgs: false,
        background: false,
        structuredOutput: false,
        toolStream: false,
      }),
      async *stream(request): AsyncGenerator<ProviderStreamEvent> {
        inputs.push([...request.input]);
        if (inputs.length === 1) {
          // Round 1: call a tool.
          yield {
            type: 'tool-call-complete',
            itemId: 'it_call1',
            callId: 'call_pair01',
            toolName: 'read_file',
            argumentsJson: '{"path":"a.ts"}',
            arguments: { path: 'a.ts' },
          } as ProviderStreamEvent;
          yield { type: 'done', finishReason: 'tool_calls' } as ProviderStreamEvent;
        } else {
          // Round 2: the model saw the result, answers, stops.
          yield { type: 'text-done', itemId: 'm', text: 'done' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };

    const engine = new TurnEngine({
      provider,
      tools: recordingExecutor(),
      sink: {
        append: (e) => store.append({ ...e, causationId: (e.causationId ?? null) as never }),
        mayExecute: (key) => store.mayExecute(key),
      },
      ids,
      clock,
    });
    const result = await engine.run({
      threadId: THREAD_P,
      correlationId: CORR_P,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'read a.ts',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(result.state).toBe('completed');
    expect(inputs.length).toBe(2); // exactly two rounds — it converged, did not loop

    // The round-2 input must contain BOTH the function-call and its function-output, call first.
    const round2 = inputs[1] as Array<{ type: string; callId?: string }>;
    const callIdx = round2.findIndex(
      (i) => i.type === 'function-call' && i.callId === 'call_pair01',
    );
    const outIdx = round2.findIndex(
      (i) => i.type === 'function-output' && i.callId === 'call_pair01',
    );
    expect(
      callIdx,
      'function-call for the tool call must be present in round-2 input',
    ).toBeGreaterThanOrEqual(0);
    expect(outIdx, 'function-output must be present').toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeLessThan(outIdx); // call before output — a valid pairing
  });
});
