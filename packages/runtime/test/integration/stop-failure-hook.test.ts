import { harnessError, type CorrelationId, type ThreadId } from '@qwen-harness/protocol';
import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { TurnEngine, type ToolExecutor, type TurnHooks } from '../../src/index.ts';

/**
 * HK-01: `StopFailure` fires on a NON-clean terminal path, distinct from the `Stop` that fires on
 * EVERY terminal path. A clean turn fires `Stop` only. Driven through a REAL turn (scripted provider,
 * real store) with a recording `fireLifecycle`, so the assertion FAILS if StopFailure stops firing —
 * or if it ever fires on a clean completion.
 */

const THREAD = 'thr_sf00001' as ThreadId;
const CORR = 'cor_sf00001' as CorrelationId;

const CAPS = freezeCapabilities({
  textStreaming: true,
  reasoningSummary: false,
  reasoningEffortGranularity: 'none',
  incrementalToolArgs: false,
  background: false,
  structuredOutput: false,
  toolStream: false,
});

function newStore(): EventStore {
  const store = new EventStore({
    path: ':memory:',
    clock: new ManualClock(1_700_000_000_000),
    ids: new SequentialIds(),
  });
  store.append({
    threadId: THREAD,
    correlationId: CORR,
    permissionProfile: 'ask',
    actor: USER_ACTOR,
    payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
  });
  return store;
}

const noTools: ToolExecutor = {
  intentFor: () => ({
    idempotencyKey: 'x',
    destructive: false,
    kind: 'other',
    normalizedAction: 'x',
  }),
  evaluate: () =>
    Promise.resolve({
      status: 'allow',
      actionDigest: 'd',
      description: 'x',
      risk: 'low',
      reason: null,
      source: 't:0',
    }),
  execute: () =>
    Promise.resolve({
      ok: true,
      modelText: '',
      userText: '',
      errorCategory: null,
      resultDigest: null,
      outputRef: null,
      truncated: false,
      durationMs: 0,
    }),
};

/** A recording lifecycle observer: records the ordered stream of lifecycle events the engine fires. */
function recordingHooks(): TurnHooks & { lifecycle: string[] } {
  const lifecycle: string[] = [];
  return {
    preToolUse: () => Promise.resolve({ blocked: false, reason: null }),
    postToolUse: () => Promise.resolve(),
    fireLifecycle: (event: string) => {
      lifecycle.push(event);
      return Promise.resolve();
    },
    lifecycle,
  };
}

function engineWith(
  provider: ModelProvider,
  hooks: TurnHooks,
  store: EventStore,
  clock: ManualClock,
  ids: SequentialIds,
): TurnEngine {
  const engine = new TurnEngine({
    provider,
    tools: noTools,
    sink: { append: (e) => store.append({ ...e, causationId: (e.causationId ?? null) as never }) },
    ids,
    clock,
    rng: () => 0.5,
    hooks,
  });
  (clock as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  return engine;
}

const runInput = {
  threadId: THREAD,
  correlationId: CORR,
  permissionProfile: 'ask' as const,
  model: 'fake',
  instructions: '',
  history: [],
  userText: 'go',
  tools: [],
  actor: MODEL_ACTOR,
};

describe('StopFailure lifecycle hook (HK-01)', () => {
  it('fires BOTH Stop and StopFailure on a failed turn', async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const ids = new SequentialIds();
    const store = newStore();
    // A non-retryable provider fault ends the turn `failed`.
    const provider: ModelProvider = {
      capabilities: CAPS,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ProviderStreamEvent> {
        throw harnessError({
          origin: 'provider',
          category: 'provider.auth.invalid_key',
          message: 'invalid api key',
          retryable: false,
          userActionRequired: true,
        });
      },
    };
    const hooks = recordingHooks();

    const result = await engineWith(provider, hooks, store, clock, ids).run(runInput);

    expect(result.state).toBe('failed');
    expect(hooks.lifecycle).toContain('Stop');
    expect(hooks.lifecycle).toContain('StopFailure');
  });

  it('fires Stop but NOT StopFailure on a clean completion (non-vacuous)', async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const ids = new SequentialIds();
    const store = newStore();
    const provider: ModelProvider = {
      capabilities: CAPS,
      async *stream(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: 'text-done', itemId: 'm', text: 'all done' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const hooks = recordingHooks();

    const result = await engineWith(provider, hooks, store, clock, ids).run(runInput);

    expect(result.state).toBe('completed');
    expect(hooks.lifecycle).toContain('Stop');
    expect(hooks.lifecycle).not.toContain('StopFailure');
  });
});
