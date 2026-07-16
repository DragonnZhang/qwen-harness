import { EventStore } from '@qwen-harness/storage';
import { type CorrelationId, type ThreadId } from '@qwen-harness/protocol';
import type {
  ModelProvider,
  ModelInputItem,
  ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import {
  TurnEngine,
  type EventSink,
  type NotificationDrain,
  type ToolExecutor,
  type TurnHooks,
} from '@qwen-harness/runtime';

/**
 * RT-05 (E): a deterministic, scripted end-to-end turn driven through the REAL turn engine and the
 * REAL event store (nothing about the engine is mocked away — only the provider and tool I/O are
 * scripted, as every deterministic e2e here does). A notification is queued before the turn; we
 * assert it is surfaced to the model at turn start and the turn completes with a `Stop` lifecycle.
 */

const THREAD = 'thr_e2eord1' as ThreadId;
const CORR = 'cor_e2eord1' as CorrelationId;

const CAPS = freezeCapabilities({
  textStreaming: true,
  reasoningSummary: false,
  reasoningEffortGranularity: 'none',
  incrementalToolArgs: false,
  background: false,
  structuredOutput: false,
  toolStream: false,
});

function recordingExecutor(): ToolExecutor {
  return {
    evaluate: (call) =>
      Promise.resolve({
        status: 'allow' as const,
        actionDigest: `digest:${call.toolName}`,
        description: call.toolName,
        risk: 'low' as const,
        reason: 'allowed',
        source: 'test:fake',
      }),
    intentFor: (call) => ({
      idempotencyKey: `${call.toolName}:${JSON.stringify(call.arguments)}`,
      destructive: false,
      kind: 'other' as const,
      normalizedAction: `${call.toolName}`,
    }),
    execute: (call) =>
      Promise.resolve({
        ok: true,
        modelText: `${call.toolName} ok`,
        userText: `${call.toolName} ok`,
        errorCategory: null,
        resultDigest: 'sha-result',
        outputRef: null,
        truncated: false,
        durationMs: 5,
      }),
  };
}

describe('a queued notification is surfaced at turn start and the turn ends with Stop (RT-05, E)', () => {
  it('runs a scripted tool turn end to end', async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const ids = new SequentialIds();
    const store = new EventStore({ path: ':memory:', clock, ids });
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });

    // Capture the input the model was actually sent on the first (turn-start) round.
    const inputs: ModelInputItem[][] = [];
    let round = 0;
    const provider: ModelProvider = {
      capabilities: CAPS,
      async *stream(request): AsyncGenerator<ProviderStreamEvent> {
        inputs.push([...request.input]);
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call-complete',
            itemId: 't',
            callId: 'call_e2e01',
            toolName: 'read_file',
            argumentsJson: '{"path":"a.ts"}',
            arguments: { path: 'a.ts' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text-done', itemId: 'm', text: 'all caught up' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };

    const lifecycle: string[] = [];
    const hooks: TurnHooks = {
      preToolUse: () => Promise.resolve({ blocked: false, reason: null }),
      postToolUse: () => Promise.resolve(),
      fireLifecycle: (event) => {
        lifecycle.push(event);
        return Promise.resolve();
      },
    };

    const notifications: NotificationDrain = {
      drain: () => [{ summary: 'scheduled job nightly-sync completed' }],
    };

    const sink: EventSink = {
      append: (input) =>
        store.append({ ...input, causationId: (input.causationId ?? null) as never }),
      mayExecute: (key) => store.mayExecute(key),
    };

    const engine = new TurnEngine({
      provider,
      tools: recordingExecutor(),
      sink,
      ids,
      clock,
      hooks,
      notifications,
    });

    const result = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'what happened while I was away?',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(result.state).toBe('completed');

    // The notification is surfaced to the model at turn start (the first round's input).
    const round1 = inputs[0]!;
    expect(
      round1.some(
        (item) =>
          item.type === 'message' &&
          item.role === 'user' &&
          item.text === 'Notification (while you were away): scheduled job nightly-sync completed',
      ),
      'the queued notification must reach the model at turn start',
    ).toBe(true);

    // The turn ends through the stop-hooks phase: Stop fires, and it fires last.
    expect(lifecycle).toContain('QueuedNotifications');
    expect(lifecycle).toContain('Stop');
    expect(lifecycle[lifecycle.length - 1]).toBe('Stop');

    // The durable log ends exactly once, cleanly.
    const events = store.readThread(THREAD).map((e) => e.payload.type);
    expect(events.filter((t) => t === 'turn-ended')).toHaveLength(1);
  });
});
