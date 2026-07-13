import type { Summarizer } from '@qwen-harness/context';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import {
  freezeCapabilities,
  type ModelInputItem,
  type ModelProvider,
  type ModelRequest,
  type ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { TurnEngine, type EventSink, type ToolExecutor } from '@qwen-harness/runtime';
import { EventStore } from '@qwen-harness/storage';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import { createContextManager } from '../../src/context.ts';

/**
 * Golden path 4 (long context), at the seam that makes it real: the REAL `TurnEngine` driving the
 * REAL `EventStore` through the REAL context manager. A scripted provider returns large tool outputs
 * round after round, growing the transcript past the budget on its own — no forced compaction flag.
 * The engine calls the context manager before every model round and adopts the leaner conversation
 * it returns.
 *
 * The test proves what the golden path demands after compaction: the goal, constraints, tasks, and
 * active files still reach the model, the transcript actually shrank, the offloaded output is
 * durably retrievable, and permissions are unchanged.
 */

const THREAD = 'thr_cmp0001' as ThreadId;
const CORR = 'cor_cmp0001' as CorrelationId;

/**
 * A provider that records every request it is given (so the test can inspect exactly what reached
 * the model), calls a tool for the first `toolRounds` rounds, then finishes with text.
 */
function recordingProvider(toolRounds: number): ModelProvider & { inputs: ModelInputItem[][] } {
  const inputs: ModelInputItem[][] = [];
  let round = 0;
  return {
    inputs,
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: false,
      reasoningEffortGranularity: 'graded',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      inputs.push([...request.input]);
      const n = round++;
      if (n < toolRounds) {
        // Distinct arguments per round: the engine's loop guard stops a model that repeats the SAME
        // call with no progress, which is not what this test is about.
        const path = `chunk_${n}.ts`;
        yield {
          type: 'tool-call-complete',
          itemId: `t${n}`,
          callId: `call_read_${n}0000000`,
          toolName: 'read_file',
          argumentsJson: `{"path":"${path}"}`,
          arguments: { path },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text-done', itemId: `m${n}`, text: 'All done.' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

/** A tool executor whose result is large, so each round meaningfully grows the transcript. */
function bigOutputExecutor(bytes: number): ToolExecutor {
  return {
    evaluate: (c) =>
      Promise.resolve({
        status: 'allow' as const,
        actionDigest: `digest:${c.callId}`,
        description: c.toolName,
        risk: 'low' as const,
        reason: 'allow',
        source: 'test',
      }),
    intentFor: (c) => ({
      // Unique per call, so the SS-05 recovery guard never suppresses a later identical read.
      idempotencyKey: `${c.toolName}:${c.callId}`,
      destructive: false,
      kind: 'other' as const,
      normalizedAction: c.toolName,
    }),
    execute: (c) => {
      const body = `contents of server.ts and server.test.ts\n` + 'Q'.repeat(bytes);
      return Promise.resolve({
        ok: true,
        modelText: body,
        userText: body,
        errorCategory: null,
        resultDigest: `res:${c.callId}`,
        outputRef: null,
        truncated: false,
        durationMs: 1,
      });
    },
  };
}

const richSummarizer: Summarizer = () => ({
  prose: 'read the server so far',
  preserved: {
    goal: 'implement the feature in server.ts',
    constraints: ['do not touch .git', 'keep tests green'],
    plan: ['read server.ts', 'edit the handler'],
    tasks: ['task-1: wire the request handler'],
    activeFiles: ['server.ts', 'server.test.ts'],
    decisions: [],
    errors: [],
    obligations: ['update the changelog'],
  },
});

describe('compaction golden path (CX-01..CX-05) through the real TurnEngine', () => {
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
    append: (input) => store.append({ ...input, causationId: (input.causationId ?? null) as never }),
    mayExecute: (key) => store.mayExecute(key),
  });

  it('grows the transcript with real tool output, compacts, and preserves goal/constraints/tasks/files', async () => {
    const provider = recordingProvider(8);
    const context = createContextManager({
      store,
      contextWindow: 1200, // small window so real growth crosses the 85% threshold as rounds add up
      clock,
      ids,
      actor: MODEL_ACTOR,
      summarizer: richSummarizer,
      offloadThresholdChars: 1500,
    });

    const engine = new TurnEngine({ provider, tools: bigOutputExecutor(2000), sink: sink(), ids, clock, context });
    const result = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'implement the feature in server.ts',
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(result.state).toBe('completed');

    // Compaction actually fired, and is durable and observable (CX-03/CX-04).
    const compactions = store
      .readThread(THREAD)
      .map((e) => e.payload)
      .filter((p) => p.type === 'item-appended' && p.item.type === 'compaction');
    expect(compactions.length).toBeGreaterThanOrEqual(2); // boundary marker + final summary item

    // The model actually received the summary after compaction: some request input carries a message
    // that preserves goal, constraints, tasks, and active files (CX-03/CX-05).
    const flat = provider.inputs.map((input) =>
      input
        .map((i) => (i.type === 'message' ? i.text : i.type === 'function-output' ? i.output : ''))
        .join('\n'),
    );
    const withSummary = flat.filter((text) => text.includes('# Compaction summary'));
    expect(withSummary.length).toBeGreaterThan(0);
    const summaryText = withSummary[withSummary.length - 1]!;
    expect(summaryText).toContain('implement the feature in server.ts'); // goal
    expect(summaryText).toContain('do not touch .git'); // constraint
    expect(summaryText).toContain('task-1: wire the request handler'); // task
    expect(summaryText).toContain('server.ts'); // active file
    expect(summaryText).toContain('update the changelog'); // obligation

    // The transcript genuinely shrank: the final request the model saw is smaller than the peak.
    const sizes = provider.inputs.map((input) =>
      input.reduce((n, i) => n + (i.type === 'message' ? i.text.length : i.type === 'function-output' ? i.output.length : 0), 0),
    );
    const peak = Math.max(...sizes);
    const last = sizes[sizes.length - 1]!;
    expect(last).toBeLessThan(peak);

    // The offloaded large output is durably retrievable, not a dangling reference.
    const blobCount = store.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number };
    expect(blobCount.n).toBeGreaterThan(0);

    // Permissions are unchanged by compaction: every event still carries the run's profile.
    const profiles = new Set(store.readThread(THREAD).map((e) => e.permissionProfile));
    expect([...profiles]).toEqual(['ask']);
  });

  it('does not compact when the transcript stays small (no thrashing on a short turn)', async () => {
    const provider = recordingProvider(1);
    const context = createContextManager({
      store,
      contextWindow: 1_000_000, // a real, large window: a short turn never crosses the threshold
      clock,
      ids,
      actor: MODEL_ACTOR,
      summarizer: richSummarizer,
    });

    const engine = new TurnEngine({ provider, tools: bigOutputExecutor(100), sink: sink(), ids, clock, context });
    await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      model: 'qwen3.7-max',
      instructions: 'be terse',
      history: [],
      userText: 'small task',
      tools: [],
      actor: MODEL_ACTOR,
    });

    const compactions = store
      .readThread(THREAD)
      .map((e) => e.payload)
      .filter((p) => p.type === 'item-appended' && p.item.type === 'compaction');
    expect(compactions.length).toBe(0);
  });
});
