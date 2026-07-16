import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import type {
  ModelInputItem,
  ModelProvider,
  ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { ManualClock, MODEL_ACTOR, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authorityForProfile, createHarnessRuntime } from '../../src/index.ts';
import { inProcessSurface, type UserInteraction } from '../../src/in-process-tools.ts';

/**
 * TL-02 (I / end-to-end): the two in-process tools driven through the REAL `TurnEngine`, the REAL
 * policy engine and the REAL event store. Only the model and the user channel are scripted; every
 * component that could hide a security bug is the production one.
 *
 * The point is that these tools are ordinary tool calls: the engine wraps them in the same
 * hook -> policy -> intent -> execute -> result order as any built-in, so a policy-decision and a
 * durable tool-result item exist for each, and the content/answer really flows back to the model.
 */

const client = new ToolWorkerClient();
const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;
const NOW = 1_700_000_000_000;

interface Scripted extends ModelProvider {
  readonly inputs: ModelInputItem[][];
}

function scriptedProvider(rounds: ProviderStreamEvent[][]): Scripted {
  let i = 0;
  const inputs: ModelInputItem[][] = [];
  return {
    inputs,
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: true,
      reasoningEffortGranularity: 'graded',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream(request) {
      inputs.push([...request.input]);
      const round = rounds[i++] ?? [{ type: 'done', finishReason: 'stop' }];
      for (const event of round) yield event;
    },
  };
}

const toolCall = (
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): ProviderStreamEvent => ({
  type: 'tool-call-complete',
  itemId: `it_${callId}`,
  callId,
  toolName,
  argumentsJson: JSON.stringify(args),
  arguments: args,
});

const text = (t: string): ProviderStreamEvent[] => [
  { type: 'text-done', itemId: 'm', text: t },
  { type: 'done', finishReason: 'stop' },
];

describe('in-process tools through the real engine (TL-02 I)', () => {
  let workspace: string;
  let store: EventStore;
  let ids: SequentialIds;
  let clock: ManualClock;

  const authority = authorityForProfile('ask');

  const runtimeWith = (provider: ModelProvider, ui: UserInteraction) => {
    const policy = new PolicyEngine();
    const policyContext = (): PolicyContext => ({
      profile: authority.profile,
      managedPolicy: authority.managedPolicy,
      rules: authority.rules,
      grants: [],
      workspaceRoot: workspace,
      homeDir: '/home/nonexistent',
      now: clock.now(),
      actor: MODEL_ACTOR,
    });
    const inProcess = inProcessSurface({
      blob: store,
      userInteraction: ui,
      policy,
      policyContext,
      workspaceRoot: workspace,
      clock: { now: () => clock.now() },
    });
    return createHarnessRuntime({
      workspaceRoot: workspace,
      authority,
      model: 'scripted',
      instructions: 'be careful',
      homeDir: '/home/nonexistent',
      clock,
      ids,
      store,
      policy,
      provider,
      client,
      inProcess,
    });
  };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-inproc-'));
    ids = new SequentialIds();
    clock = new ManualClock(NOW);
    store = new EventStore({ path: ':memory:', clock, ids });
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
    });
  });
  afterEach(() => {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('retrieve_output fetches a previously offloaded blob back to the model', async () => {
    // Simulate the TL-10 offload: the full output lives in the durable blob store under a digest.
    store.putBlob('blb_offloaded', 'THE FULL OFFLOADED OUTPUT');

    const provider = scriptedProvider([
      [
        toolCall('call_r1', 'retrieve_output', { ref: 'blb_offloaded' }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      text('I retrieved it.'),
    ]);

    const result = await runtimeWith(provider, {
      ask: () => Promise.resolve(null),
    }).runTurn({ threadId: THREAD, correlationId: CORR, userText: 'get the output' });

    expect(result.state).toBe('completed');

    // The content really flowed back to the model, paired to its own call id.
    const secondRound = provider.inputs[1] ?? [];
    const output = secondRound.find(
      (item) => item.type === 'function-output' && item.callId === 'call_r1',
    );
    expect(output && 'output' in output ? output.output : '').toBe('THE FULL OFFLOADED OUTPUT');

    // It ran through the engine's normal wrapping: a policy-decision and a durable tool-result exist.
    const events = store.readThread(THREAD);
    const decision = events.find(
      (e) => e.payload.type === 'policy-decision' && e.payload.callId === 'call_r1',
    );
    expect(decision).toBeTruthy();
    const toolResult = events.find(
      (e) =>
        e.payload.type === 'item-appended' &&
        e.payload.item.type === 'tool-result' &&
        e.payload.item.callId === 'call_r1',
    );
    expect(toolResult).toBeTruthy();
  });

  it('ask_user asks the scripted channel and returns the answer to the model', async () => {
    const asked: string[] = [];
    const ui: UserInteraction = {
      ask: (question) => {
        asked.push(question);
        return Promise.resolve('Blue.');
      },
    };

    const provider = scriptedProvider([
      [
        toolCall('call_a1', 'ask_user', { question: 'What is your favourite colour?' }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      text('Thanks.'),
    ]);

    const result = await runtimeWith(provider, ui).runTurn({
      threadId: THREAD,
      correlationId: CORR,
      userText: 'ask me something',
    });

    expect(result.state).toBe('completed');
    expect(asked).toEqual(['What is your favourite colour?']);

    const secondRound = provider.inputs[1] ?? [];
    const output = secondRound.find(
      (item) => item.type === 'function-output' && item.callId === 'call_a1',
    );
    expect(output && 'output' in output ? output.output : '').toBe('Blue.');
  });

  it('ask_user with a headless channel returns a typed unavailable result, not a fake answer', async () => {
    const provider = scriptedProvider([
      [
        toolCall('call_a2', 'ask_user', { question: 'anyone there?' }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      text('No channel — understood.'),
    ]);

    const result = await runtimeWith(provider, { ask: () => Promise.resolve(null) }).runTurn({
      threadId: THREAD,
      correlationId: CORR,
      userText: 'ask me something',
    });

    expect(result.state).toBe('completed');
    const events = store.readThread(THREAD);
    const toolResult = events.find(
      (e) =>
        e.payload.type === 'item-appended' &&
        e.payload.item.type === 'tool-result' &&
        e.payload.item.callId === 'call_a2',
    );
    expect(toolResult).toBeTruthy();
    if (toolResult && toolResult.payload.type === 'item-appended') {
      const item = toolResult.payload.item;
      expect(item.type === 'tool-result' && item.ok).toBe(false);
      expect(item.type === 'tool-result' && item.errorCategory).toBe('unsupported');
    }
  });
});
