import { EventStore } from '@qwen-harness/storage';
import { type CorrelationId, type ThreadId } from '@qwen-harness/protocol';
import type {
  ModelProvider,
  ModelInputItem,
  ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  TURN_ORDER,
  TurnEngine,
  type EventSink,
  type NotificationDrain,
  type ToolExecutor,
  type TurnHooks,
} from '../../src/index.ts';

/**
 * RT-05 (I): the turn engine executes phases in the canonical `TURN_ORDER`, end to end, over the
 * REAL event store. A `fireLifecycle` spy records lifecycle events in call order; a `notifications`
 * dep supplies one queued notification. We assert:
 *   (a) `QueuedNotifications` fires (the phase-2 drain ran);
 *   (b) the drained summary reaches the model (captured from the provider's request input);
 *   (c) the recorded lifecycle order is consistent with TURN_ORDER — `QueuedNotifications` before any
 *       `PreToolUse`, and `Stop` last (after every PreToolUse/PostToolUse/PostToolBatch);
 * plus a backward-compat case: no `notifications` dep still runs and still fires `Stop`.
 */

const THREAD = 'thr_00ord1' as ThreadId;
const CORR = 'cor_00ord1' as CorrelationId;

const CAPS = freezeCapabilities({
  textStreaming: true,
  reasoningSummary: false,
  reasoningEffortGranularity: 'none',
  incrementalToolArgs: false,
  background: false,
  structuredOutput: false,
  toolStream: false,
});

/** A provider that plays back a fixed script of rounds AND captures the input it was sent. */
function capturingProvider(rounds: ProviderStreamEvent[][]): ModelProvider & {
  inputs: ModelInputItem[][];
} {
  let i = 0;
  const inputs: ModelInputItem[][] = [];
  return {
    inputs,
    capabilities: CAPS,
    async *stream(request): AsyncGenerator<ProviderStreamEvent> {
      inputs.push([...request.input]);
      const round = rounds[i++] ?? [{ type: 'done', finishReason: 'stop' }];
      for (const e of round) yield e;
    },
  };
}

/** A tool executor that allows everything and returns a canned success. */
function recordingExecutor(): ToolExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
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
      destructive: false,
      kind: 'other' as const,
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

/**
 * Hooks that record EVERY hook interaction into one ordered stream, in call order. PreToolUse and
 * PostToolUse are engine hook callbacks (not `fireLifecycle` events), so we record them alongside the
 * `fireLifecycle` events (QueuedNotifications, PostToolBatch, Stop, ...) to observe cross-phase order.
 */
function spyHooks(): TurnHooks & { lifecycle: string[] } {
  const lifecycle: string[] = [];
  return {
    lifecycle,
    preToolUse: () => {
      lifecycle.push('PreToolUse');
      return Promise.resolve({ blocked: false, reason: null });
    },
    postToolUse: () => {
      lifecycle.push('PostToolUse');
      return Promise.resolve();
    },
    fireLifecycle: (event) => {
      lifecycle.push(event);
      return Promise.resolve();
    },
  };
}

/** A single-round-then-done tool script: round 1 calls `read_file`, round 2 concludes. */
const toolThenDone: ProviderStreamEvent[][] = [
  [
    {
      type: 'tool-call-complete',
      itemId: 't',
      callId: 'call_ord0001',
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
];

describe('TurnEngine executes phases in TURN_ORDER (RT-05)', () => {
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

  it('drains a notification into the model at turn start and fires Stop last', async () => {
    const provider = capturingProvider(toolThenDone);
    const exec = recordingExecutor();
    const hooks = spyHooks();
    const notifications: NotificationDrain = {
      drain: () => [{ summary: 'background task build-42 finished' }],
    };

    const engine = new TurnEngine({
      provider,
      tools: exec,
      sink: sink(),
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
      userText: 'read a.ts',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(result.state).toBe('completed');
    expect(exec.calls).toEqual(['read_file']);

    // (a) the phase-2 drain fired its lifecycle event.
    expect(hooks.lifecycle).toContain('QueuedNotifications');

    // (b) the drained summary reached the model — it is in the FIRST round's input, at turn start.
    const round1 = provider.inputs[0]!;
    const surfaced = round1.some(
      (item) =>
        item.type === 'message' &&
        item.role === 'user' &&
        item.text === 'Notification (while you were away): background task build-42 finished',
    );
    expect(surfaced, 'the notification summary must be surfaced to the model at turn start').toBe(
      true,
    );

    // (c) lifecycle order is consistent with TURN_ORDER: QueuedNotifications before any PreToolUse,
    // and Stop strictly last (after every PreToolUse/PostToolUse/PostToolBatch).
    const qn = hooks.lifecycle.indexOf('QueuedNotifications');
    const firstPre = hooks.lifecycle.indexOf('PreToolUse');
    expect(qn).toBeGreaterThanOrEqual(0);
    expect(firstPre).toBeGreaterThan(qn);
    expect(hooks.lifecycle).toContain('PostToolUse');
    expect(hooks.lifecycle).toContain('PostToolBatch');
    expect(hooks.lifecycle[hooks.lifecycle.length - 1]).toBe('Stop');
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolBatch', 'QueuedNotifications']) {
      expect(hooks.lifecycle.lastIndexOf(event), `${event} must fire before Stop`).toBeLessThan(
        hooks.lifecycle.lastIndexOf('Stop'),
      );
    }

    // Sanity: the queued-notifications phase sits at index 1 of the canonical order.
    expect(TURN_ORDER[1]).toBe('queued-notifications');
  });

  it('a turn with NO notifications dep still runs and still fires Stop (backward compat)', async () => {
    const provider = capturingProvider(toolThenDone);
    const exec = recordingExecutor();
    const hooks = spyHooks();

    const engine = new TurnEngine({
      provider,
      tools: exec,
      sink: sink(),
      ids,
      clock,
      hooks,
    });

    const result = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'read a.ts',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(result.state).toBe('completed');
    expect(exec.calls).toEqual(['read_file']);

    // No notifications dep -> the phase is a no-op: QueuedNotifications never fires.
    expect(hooks.lifecycle).not.toContain('QueuedNotifications');
    // But the turn still ends cleanly through the stop-hooks phase.
    expect(hooks.lifecycle[hooks.lifecycle.length - 1]).toBe('Stop');

    // And no away-time context leaked into the model input.
    const round1 = provider.inputs[0]!;
    expect(
      round1.some((item) => item.type === 'message' && item.text.startsWith('Notification')),
    ).toBe(false);
  });

  it('a cancelled turn still fires Stop last — stop-hooks is the final phase of EVERY ending', async () => {
    const provider = capturingProvider(toolThenDone);
    const exec = recordingExecutor();
    const hooks = spyHooks();

    const engine = new TurnEngine({
      provider,
      tools: exec,
      sink: sink(),
      ids,
      clock,
      hooks,
    });

    // An already-aborted signal: the turn cancels at the top of the drive loop, routing through
    // #cancel — the path that must ALSO fire Stop for the order to hold universally (RT-05).
    const aborted = new AbortController();
    aborted.abort();

    const result = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'read a.ts',
      tools: [],
      actor: MODEL_ACTOR,
      signal: aborted.signal,
    });

    expect(result.state).toBe('cancelled');
    expect(result.terminationReason).toBe('user-cancelled');
    // The turn ended by cancellation, NOT through #endTurn — yet Stop still fired, and last.
    expect(hooks.lifecycle[hooks.lifecycle.length - 1]).toBe('Stop');
  });
});
