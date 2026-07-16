import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAtMost } from '@qwen-harness/policy';
import type { ActorId, CorrelationId, PermissionProfile, ThreadId } from '@qwen-harness/protocol';
import {
  freezeCapabilities,
  type ModelInputItem,
  type ModelProvider,
  type ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { headlessUserInteraction, inProcessSurface } from '../../src/in-process-tools.ts';
import { authorityForProfile } from '../../src/policy-from-config.ts';
import {
  childRunAuthority,
  createDelegateSurface,
  runAuthorityToAuthority,
} from '../../src/subagent-tool.ts';
import { createHarnessRuntime, type HarnessRuntime } from '../../src/wiring.ts';

/**
 * AG-02 (I, F): the production `delegate` tool spawns a REAL subagent — a nested `TurnEngine` running
 * one bounded turn — and returns only its bounded conclusion, all through the normal engine gating.
 *
 *  - I: a model that calls `delegate` fresh+foreground gets the child's conclusion back; the child ran
 *       a real turn (its events are in the store) and its authority never exceeds the parent's.
 *  - I (bg): `delegate` timing=background returns immediately; `joinAll` collects the conclusion.
 *  - F: a child whose turn fails → `delegate` returns ok:false with the reason and the parent turn
 *       continues (no crash, no leaked active slot).
 */

const CAPS = freezeCapabilities({
  textStreaming: true,
  reasoningSummary: false,
  reasoningEffortGranularity: 'none',
  incrementalToolArgs: false,
  background: false,
  structuredOutput: false,
  toolStream: false,
});

const CHILD_MARKER = 'CHILD_TASK_XYZ';
const CHILD_RESULT = 'CHILD_RESULT_42';
const MODEL_ACTOR = { kind: 'model' as const, id: 'act_model1' as ActorId };

/**
 * A request is the CHILD's turn iff a USER-role message carries the child-prompt marker. The parent's
 * delegate call puts that marker only inside a function-call's argumentsJson (never a user message),
 * so this holds even for a forked child whose seed includes the parent's function-call.
 */
function isChildRequest(input: readonly ModelInputItem[]): boolean {
  return input.some(
    (i) => i.type === 'message' && i.role === 'user' && i.text.includes(CHILD_MARKER),
  );
}

/** True once the parent already holds the delegate's result (its second, concluding round). */
function parentHasChildResult(input: readonly ModelInputItem[]): boolean {
  return input.some((i) => i.type === 'function-output');
}

const delegateCall = (timing: 'foreground' | 'background'): ProviderStreamEvent[] => {
  const args = { label: 'sub', prompt: `do the thing: ${CHILD_MARKER}`, timing };
  return [
    {
      type: 'tool-call-complete',
      itemId: 'it_delegate',
      callId: 'call_delegate_1',
      toolName: 'delegate',
      argumentsJson: JSON.stringify(args),
      arguments: args,
    },
    { type: 'done', finishReason: 'tool_calls' },
  ];
};

/**
 * One provider that serves BOTH the parent and the child turns (they share the runtime's provider).
 * The child branch is selected by the marker; `childText` lets a test make the child SUCCEED (text +
 * clean stop) or FAIL (no text, a length finish that ends the turn without a conclusion is not
 * needed — a thrown provider models a genuinely broken child turn).
 */
function makeProvider(opts: {
  timing: 'foreground' | 'background';
  childFails?: boolean;
}): ModelProvider {
  return {
    capabilities: CAPS,
    async *stream(request) {
      if (isChildRequest(request.input)) {
        if (opts.childFails) {
          throw new Error('child model exploded');
        }
        yield { type: 'text-done', itemId: 'it_child', text: CHILD_RESULT };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      if (parentHasChildResult(request.input)) {
        // The concluding parent round: echo that it used the child's result.
        const out = request.input.find((i) => i.type === 'function-output');
        const childText = out && out.type === 'function-output' ? String(out.output) : '';
        yield { type: 'text-done', itemId: 'it_parent2', text: `parent used: ${childText}` };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      for (const ev of delegateCall(opts.timing)) yield ev;
    },
  };
}

interface Harness {
  runtime: HarnessRuntime;
  supervisor: ReturnType<typeof createDelegateSurface>['supervisor'];
  threadId: ThreadId;
  store: EventStore;
}

function buildHarness(opts: {
  cwd: string;
  clock: ManualClock;
  ids: SequentialIds;
  provider: ModelProvider;
  profile?: PermissionProfile;
}): Harness {
  const store = new EventStore({ path: ':memory:', clock: opts.clock, ids: opts.ids });
  const authority = authorityForProfile(opts.profile ?? 'yolo');
  const threadId = opts.ids.next('thr') as ThreadId;
  store.append({
    threadId,
    correlationId: opts.ids.next('cor') as CorrelationId,
    permissionProfile: authority.profile,
    actor: { kind: 'user', id: 'act_user01' as ActorId },
    payload: { type: 'thread-created', cwd: opts.cwd, canonicalRepo: opts.cwd, name: null },
  });

  const policy = new PolicyEngine();
  const clock = { now: () => opts.clock.now() };
  const policyContext = (): PolicyContext => ({
    profile: authority.profile,
    managedPolicy: authority.managedPolicy,
    rules: authority.rules,
    grants: [],
    workspaceRoot: opts.cwd,
    homeDir: opts.cwd,
    now: opts.clock.now(),
    actor: MODEL_ACTOR,
  });

  const delegateSurface = createDelegateSurface({
    parentAuthority: authority,
    workspaceRoot: opts.cwd,
    homeDir: opts.cwd,
    instructions: () => 'you are a helpful agent',
    clock,
    ids: opts.ids,
    store,
    policy,
    provider: opts.provider,
    parentThreadId: threadId,
    model: 'test-model',
    parentModelCalls: 20,
    parentWallMs: 60_000,
  });

  const inProcess = inProcessSurface({
    blob: store,
    userInteraction: headlessUserInteraction(),
    policy,
    policyContext,
    workspaceRoot: opts.cwd,
    clock,
    delegate: delegateSurface.delegate,
  });

  const runtime = createHarnessRuntime({
    workspaceRoot: opts.cwd,
    authority,
    model: 'test-model',
    instructions: 'you are a helpful agent',
    homeDir: opts.cwd,
    clock,
    ids: opts.ids,
    store,
    policy,
    provider: opts.provider,
    inProcess,
  });

  return { runtime, supervisor: delegateSurface.supervisor, threadId, store };
}

describe('AG-02 (I) — delegate spawns a real subagent through the normal gating', () => {
  let cwd: string;
  let clock: ManualClock;
  let ids: SequentialIds;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-delegate-'));
    clock = new ManualClock(1_700_000_000_000);
    ids = new SequentialIds();
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('fresh+foreground: the child runs a real turn and its conclusion returns to the parent', async () => {
    const h = buildHarness({ cwd, clock, ids, provider: makeProvider({ timing: 'foreground' }) });
    const result = await h.runtime.runTurn({
      threadId: h.threadId,
      correlationId: ids.next('cor') as CorrelationId,
      userText: 'delegate a subtask then summarize',
      history: [],
    });

    expect(result.state).toBe('completed');
    // The parent USED the child's conclusion (the child's text flowed back through the tool result).
    expect(result.finalText).toContain(CHILD_RESULT);

    const events = h.store.readAll();

    // The delegate tool result on the PARENT thread is ok and carries the child's summary.
    const delegateResult = events
      .map((e) => e.payload)
      .find(
        (p) =>
          p.type === 'item-appended' &&
          p.item.type === 'tool-result' &&
          p.item.callId === 'call_delegate_1',
      );
    expect(delegateResult).toBeTruthy();
    if (delegateResult && delegateResult.type === 'item-appended') {
      expect(delegateResult.item.type === 'tool-result' && delegateResult.item.ok).toBe(true);
    }

    // The child ran a REAL turn: a DIFFERENT thread exists with its own model round and assistant text.
    const childThreads = new Set(
      events.filter((e) => e.threadId !== h.threadId).map((e) => e.threadId),
    );
    expect(childThreads.size).toBe(1);
    const childThreadId = [...childThreads][0] as ThreadId;
    const childEvents = h.store.readThread(childThreadId);
    expect(childEvents.some((e) => e.payload.type === 'model-request-completed')).toBe(true);
    expect(
      childEvents.some(
        (e) =>
          e.payload.type === 'item-appended' &&
          e.payload.item.type === 'assistant-message' &&
          e.payload.item.text.includes(CHILD_RESULT),
      ),
    ).toBe(true);

    // No active slots leaked.
    expect(h.supervisor.activeCount).toBe(0);
    expect(h.supervisor.totalSpawned).toBe(1);
  });

  it('background: delegate returns immediately and joinAll collects the conclusion', async () => {
    const h = buildHarness({ cwd, clock, ids, provider: makeProvider({ timing: 'background' }) });
    const result = await h.runtime.runTurn({
      threadId: h.threadId,
      correlationId: ids.next('cor') as CorrelationId,
      userText: 'delegate in the background',
      history: [],
    });

    expect(result.state).toBe('completed');
    // The parent got an immediate "started in background as <id>" note, NOT the child's result yet.
    expect(result.finalText).toContain('started in background');
    expect(result.finalText).not.toContain(CHILD_RESULT);

    // The parent collects the background conclusion at turn end.
    const conclusions = await h.supervisor.joinAll();
    expect(conclusions).toHaveLength(1);
    expect(conclusions[0]?.ok).toBe(true);
    expect(conclusions[0]?.summary).toContain(CHILD_RESULT);
    expect(h.supervisor.activeCount).toBe(0);
  });

  it('F: a child whose turn fails returns ok:false and the parent turn continues', async () => {
    const h = buildHarness({
      cwd,
      clock,
      ids,
      provider: makeProvider({ timing: 'foreground', childFails: true }),
    });
    const result = await h.runtime.runTurn({
      threadId: h.threadId,
      correlationId: ids.next('cor') as CorrelationId,
      userText: 'delegate a subtask that will fail',
      history: [],
    });

    // The parent turn did NOT crash — it completed and used the (failed) tool result.
    expect(result.state).toBe('completed');

    const failed = h.store
      .readAll()
      .map((e) => e.payload)
      .find(
        (p) =>
          p.type === 'item-appended' &&
          p.item.type === 'tool-result' &&
          p.item.callId === 'call_delegate_1',
      );
    expect(failed).toBeTruthy();
    if (failed && failed.type === 'item-appended' && failed.item.type === 'tool-result') {
      expect(failed.item.ok).toBe(false);
    }

    // No active slot leaked despite the failure.
    expect(h.supervisor.activeCount).toBe(0);
  });
});

describe('AG-02 (S) — a child can never gain an authority the parent lacks', () => {
  it('the child authority is at most the parent, even when a wider one is requested', () => {
    // A restrictive parent: `ask` profile, no network.
    const parent = authorityForProfile('ask');
    const parentAuthority = runAuthorityToAuthority(parent, '/workspace');

    // The supervisor intersects requested ∩ parent ∩ managed. We ask, via the delegate surface, for
    // the parent's OWN authority — so the intersected child equals the parent's clamped authority.
    const ids = new SequentialIds();
    const store = new EventStore({ path: ':memory:', clock: new ManualClock(0), ids });
    try {
      const surface = createDelegateSurface({
        parentAuthority: parent,
        workspaceRoot: '/workspace',
        homeDir: '/home',
        instructions: () => '',
        clock: { now: () => 0 },
        ids,
        store,
        policy: new PolicyEngine(),
        parentThreadId: 'thr_x' as ThreadId,
        model: 'm',
        parentModelCalls: 10,
        parentWallMs: 1000,
      });
      const intersected = surface.supervisor.childAuthority(parentAuthority);
      // The intersected child, mapped back, must be at most the parent — never wider.
      const child = childRunAuthority(parent, intersected);
      expect(isAtMost(runAuthorityToAuthority(child, '/workspace'), parentAuthority)).toBe(true);

      // And a child that tries to REQUEST more than the parent (yolo + network) is clamped down.
      const greedy = runAuthorityToAuthority(authorityForProfile('yolo'), '/workspace');
      const clamped = surface.supervisor.childAuthority(greedy);
      expect(isAtMost(clamped, parentAuthority)).toBe(true);
      // The parent had no network / a restrictive profile; the clamped child cannot have gained it.
      expect(clamped.networkAllowed).toBe(parentAuthority.networkAllowed || false);
    } finally {
      store.close();
    }
  });
});
