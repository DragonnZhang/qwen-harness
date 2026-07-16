import { PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import type { ModelInputItem } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, MODEL_ACTOR, SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { createContextManager } from '../../src/context.ts';
import type { FireHook } from '../../src/hooks.ts';
import { inProcessExecutor, type UserInteraction } from '../../src/in-process-tools.ts';
import { authorityForProfile } from '../../src/policy-from-config.ts';
import { claimTask, completeTask, createTask, openTaskGraph, startTask } from '../../src/tasks.ts';

/**
 * HK-01: the observe-only orchestration hooks fire at their honest sites, driven through the REAL
 * code paths (not by calling `fire()` directly). Each test injects a recording `FireHook` spy and
 * asserts the event is present in the recorded stream a genuine operation produced — so the test
 * FAILS if the firing is removed.
 */

/** A recording fire spy: the same shape the CLI threads into every orchestration site. */
function spy(): FireHook & { events: string[]; data: Record<string, unknown>[] } {
  const events: string[] = [];
  const data: Record<string, unknown>[] = [];
  const fn = ((event: string, d?: Record<string, unknown>) => {
    events.push(event);
    data.push(d ?? {});
    return Promise.resolve();
  }) as FireHook & { events: string[]; data: Record<string, unknown>[] };
  fn.events = events;
  fn.data = data;
  return fn;
}

const THREAD = 'thr_hk000001' as ThreadId;
const CORR = 'cor_hk000001' as CorrelationId;
const TURN = 'trn_hk000001' as TurnId;

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
    actor: MODEL_ACTOR,
    payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
  });
  return store;
}

// -------------------------------------------------------------------------------------------
// TaskCreated / TaskCompleted — the CLI task wrapper (never the tasks package).
// -------------------------------------------------------------------------------------------
describe('tasks wrapper fires TaskCreated / TaskCompleted (HK-01)', () => {
  it('fires TaskCreated when a durable task is created, with its id', async () => {
    const graph = openTaskGraph(newStore(), new ManualClock(1_700_000_000_000));
    const fire = spy();

    const task = await createTask(
      graph,
      { subject: 'do a thing', activeForm: 'doing a thing' },
      fire,
    );

    expect(fire.events).toContain('TaskCreated');
    expect(fire.data[fire.events.indexOf('TaskCreated')]).toMatchObject({ id: task.id });
  });

  it('fires TaskCompleted when a task transitions to completed', async () => {
    const graph = openTaskGraph(newStore(), new ManualClock(1_700_000_000_000));
    const created = await createTask(graph, { subject: 's', activeForm: 'a' });
    claimTask(graph, created.id, 'me');
    startTask(graph, created.id);
    const fire = spy();

    await completeTask(graph, created.id, fire);

    expect(fire.events).toContain('TaskCompleted');
    expect(fire.data[fire.events.indexOf('TaskCompleted')]).toMatchObject({ id: created.id });
  });

  it('does not throw when no fireHook is supplied (observe-only, optional)', async () => {
    const graph = openTaskGraph(newStore(), new ManualClock(1_700_000_000_000));
    await expect(createTask(graph, { subject: 's', activeForm: 'a' })).resolves.toBeDefined();
  });
});

// -------------------------------------------------------------------------------------------
// PreCompact — the CLI context manager, before a real compaction.
// -------------------------------------------------------------------------------------------
describe('context manager fires PreCompact before a real compaction (HK-01)', () => {
  const msg = (role: 'user' | 'assistant', text: string): ModelInputItem => ({
    type: 'message',
    role,
    text,
  });
  const out = (callId: string, output: string): ModelInputItem => ({
    type: 'function-output',
    callId,
    name: 'read_file',
    output,
  });

  const call = (conversation: readonly ModelInputItem[]) => ({
    conversation,
    instructions: 'be terse',
    threadId: THREAD,
    turnId: TURN,
    correlationId: CORR,
    permissionProfile: 'ask' as const,
    signal: new AbortController().signal,
  });

  // ~9 KB of real transcript against a 2000-token window crosses the 85% proactive threshold.
  const chunk = 'z'.repeat(2500);
  const overThreshold = (): ModelInputItem[] => [
    msg('user', 'implement the feature'),
    out('c1', chunk),
    out('c2', chunk),
    msg('assistant', 'thinking'),
    out('c3', chunk),
    out('c4', chunk),
  ];

  it('fires PreCompact exactly when a compaction actually runs', async () => {
    const fire = spy();
    const mgr = createContextManager({
      store: newStore(),
      contextWindow: 2000,
      clock: new ManualClock(1_700_000_000_000),
      ids: new SequentialIds(),
      actor: MODEL_ACTOR,
      fireHook: fire,
    });

    const prep = await mgr.prepare(call(overThreshold()));

    expect(prep.compacted).toBe(true);
    expect(fire.events).toContain('PreCompact');
  });

  it('does NOT fire PreCompact when the conversation is under threshold (non-vacuous)', async () => {
    const fire = spy();
    const mgr = createContextManager({
      store: newStore(),
      contextWindow: 1_000_000, // a large window: a short turn never crosses the threshold
      clock: new ManualClock(1_700_000_000_000),
      ids: new SequentialIds(),
      actor: MODEL_ACTOR,
      fireHook: fire,
    });

    const prep = await mgr.prepare(call([msg('user', 'goal'), msg('assistant', 'short')]));

    expect(prep.compacted).toBe(false);
    expect(fire.events).not.toContain('PreCompact');
  });
});

// -------------------------------------------------------------------------------------------
// Elicitation / ElicitationResult — the in-process ask_user tool.
// -------------------------------------------------------------------------------------------
describe('ask_user fires Elicitation / ElicitationResult (HK-01)', () => {
  const WORKSPACE = '/workspace';
  const NOW = 1_700_000_000_000;
  const authority = authorityForProfile('yolo');
  const ctx = (): PolicyContext => ({
    profile: authority.profile,
    managedPolicy: authority.managedPolicy,
    rules: authority.rules,
    grants: [],
    workspaceRoot: WORKSPACE,
    homeDir: '/home',
    now: NOW,
    actor: MODEL_ACTOR,
  });
  const askCall = (question: string) => ({
    callId: 'call_0001',
    toolName: 'ask_user',
    arguments: { question },
    argumentsJson: JSON.stringify({ question }),
    signal: new AbortController().signal,
  });

  it('fires Elicitation then ElicitationResult{answered:true} when the user answers', async () => {
    const fire = spy();
    const ui: UserInteraction = { ask: () => Promise.resolve('the answer') };
    const exec = inProcessExecutor({
      blob: newStore(),
      userInteraction: ui,
      policy: new PolicyEngine(),
      policyContext: ctx,
      workspaceRoot: WORKSPACE,
      clock: new ManualClock(NOW),
      fireHook: fire,
    });

    const result = await exec.execute(askCall('what is your name?'));

    expect(result.ok).toBe(true);
    expect(fire.events).toEqual(['Elicitation', 'ElicitationResult']);
    expect(fire.data[1]).toMatchObject({ answered: true });
  });

  it('fires ElicitationResult{answered:false} when the channel declines', async () => {
    const fire = spy();
    const ui: UserInteraction = { ask: () => Promise.resolve(null) };
    const exec = inProcessExecutor({
      blob: newStore(),
      userInteraction: ui,
      policy: new PolicyEngine(),
      policyContext: ctx,
      workspaceRoot: WORKSPACE,
      clock: new ManualClock(NOW),
      fireHook: fire,
    });

    const result = await exec.execute(askCall('anything?'));

    expect(result.ok).toBe(false);
    expect(fire.events).toEqual(['Elicitation', 'ElicitationResult']);
    expect(fire.data[1]).toMatchObject({ answered: false });
  });
});
