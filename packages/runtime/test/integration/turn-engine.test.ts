import { EventStore } from '@qwen-harness/storage';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
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
