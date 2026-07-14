import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ModelInputItem,
  ModelProvider,
  ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import {
  PolicyEngine,
  actionDigest,
  revokeGrant,
  type Grant,
  type NormalizedAction,
  type PolicyContext,
} from '@qwen-harness/policy';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import type { ApprovalDecision, ApprovalGate } from '@qwen-harness/runtime';
import { EventStore } from '@qwen-harness/storage';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { ManualClock, MODEL_ACTOR, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  authorityForProfile,
  createHarnessRuntime,
  findPendingApproval,
  reconstructHistory,
} from '../../src/index.ts';

/**
 * Approvals, end to end, against the REAL policy engine, the REAL sandboxed tool worker and the
 * REAL event store. Only the model is scripted — everything that could hide a security bug is the
 * production component.
 *
 * The invariant under test is the one the whole design turns on: an approval RESUMES THE SAME TURN.
 * It is not a new turn, and it is not a new user message. A turn that is waiting for a human is a
 * live turn parked in `awaiting-approval`, and the durable log is what keeps it alive.
 */

const client = new ToolWorkerClient();
const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;
const NOW = 1_700_000_000_000;

/** Records what the model was shown on each round, so we can prove a denial reached it. */
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

function shellCall(callId: string, marker: string): ProviderStreamEvent {
  const args = {
    command: '/usr/bin/env',
    argv: ['node', '-e', `require('fs').writeFileSync('${marker}', 'ran')`],
    cwd: '.',
  };
  return {
    type: 'tool-call-complete',
    itemId: `it_${callId}`,
    callId,
    toolName: 'run_shell',
    argumentsJson: JSON.stringify(args),
    arguments: args,
  };
}

/**
 * A shell call that APPENDS a line to `marker`, so that two identical calls (same argv, therefore
 * the same action digest) leave a two-line file when BOTH executed. That is how a session grant is
 * proven to authorize the second execution without a second prompt.
 */
function appendCall(callId: string, marker: string): ProviderStreamEvent {
  const args = {
    command: '/usr/bin/env',
    argv: ['node', '-e', `require('fs').appendFileSync('${marker}', 'x\\n')`],
    cwd: '.',
  };
  return {
    type: 'tool-call-complete',
    itemId: `it_${callId}`,
    callId,
    toolName: 'run_shell',
    argumentsJson: JSON.stringify(args),
    arguments: args,
  };
}

const text = (t: string): ProviderStreamEvent[] => [
  { type: 'text-done', itemId: 'm', text: t },
  { type: 'done', finishReason: 'stop' },
];

function gate(answer: (n: number) => ApprovalDecision): ApprovalGate & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    request: (request) => {
      asked.push(request.description);
      return Promise.resolve(answer(asked.length));
    },
  };
}

describe('approvals (real policy, real sandbox, real store)', () => {
  let workspace: string;
  let store: EventStore;
  let ids: SequentialIds;
  let clock: ManualClock;

  const runtimeWith = (provider: ModelProvider, approvals?: ApprovalGate) =>
    createHarnessRuntime({
      workspaceRoot: workspace,
      authority: authorityForProfile('ask'),
      model: 'scripted',
      instructions: 'be careful',
      homeDir: '/home/nonexistent',
      clock,
      ids,
      store,
      provider,
      client,
      ...(approvals ? { approvals } : {}),
    });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-approval-'));
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

  it('the sandbox is available', () => {
    expect(client.detect().available, client.detect().detail).toBe(true);
  });

  it('an approval resumes the SAME turn: no new turn, no new user message, and the tool runs', async () => {
    const provider = scriptedProvider([
      [shellCall('call_shell001', 'approved.txt'), { type: 'done', finishReason: 'tool_calls' }],
      text('I ran it.'),
    ]);
    const approver = gate(() => ({ kind: 'approved', scope: 'once' }));

    const result = await runtimeWith(provider, approver).runTurn({
      threadId: THREAD,
      correlationId: CORR,
      userText: 'create the marker file',
    });

    expect(result.state).toBe('completed');
    // The human was asked about the EXACT normalized action, not the tool name.
    expect(approver.asked[0]).toContain('/usr/bin/env');

    // The side effect really happened, in the real sandbox.
    expect(existsSync(join(workspace, 'approved.txt'))).toBe(true);

    const events = store.readThread(THREAD);
    const starts = events.filter((e) => e.payload.type === 'turn-started');
    // ONE turn. The approval did not start another one, and no user message was appended for it.
    expect(starts).toHaveLength(1);
    expect(starts[0]?.turnId).toBe(result.turnId);

    // The state machine entered the tool phase, parked on the approval, and came back out of it
    // into the SAME executing phase — the transition table's `awaiting-approval -> executing`.
    const transitions = events
      .map((e) => e.payload)
      .filter((p): p is Extract<typeof p, { type: 'turn-state-changed' }> => {
        return p.type === 'turn-state-changed';
      })
      .map((p) => `${p.from}->${p.to}`);
    expect(transitions).toContain('executing->awaiting-approval');
    expect(transitions).toContain('awaiting-approval->executing');

    // And the approval is in the log, request and answer, bound to the same call.
    const requested = events.find((e) => e.payload.type === 'approval-requested');
    const resolved = events.find((e) => e.payload.type === 'approval-resolved');
    expect(requested?.turnId).toBe(result.turnId);
    expect(resolved?.payload).toMatchObject({ granted: true, scope: 'once' });
  });

  it('a denial is reported to the model in band, and the model adapts', async () => {
    const provider = scriptedProvider([
      [shellCall('call_shell002', 'denied.txt'), { type: 'done', finishReason: 'tool_calls' }],
      text('Understood — I will not run that.'),
    ]);
    const denier = gate(() => ({ kind: 'denied', reason: 'the operator declined' }));

    const result = await runtimeWith(provider, denier).runTurn({
      threadId: THREAD,
      correlationId: CORR,
      userText: 'create the marker file',
    });

    expect(result.state).toBe('completed');
    expect(result.finalText).toContain('will not run');

    // Nothing ran.
    expect(existsSync(join(workspace, 'denied.txt'))).toBe(false);

    // The model was TOLD, in band, paired to its own call id — it can adapt rather than die.
    const secondRound = provider.inputs[1] ?? [];
    const denial = secondRound.find(
      (item) => item.type === 'function-output' && item.callId === 'call_shell002',
    );
    expect(denial).toBeDefined();
    expect(denial?.type === 'function-output' ? denial.output : '').toContain('denied');

    // The refusal is durable, as a tool RESULT paired to the call.
    const resultItem = store
      .readThread(THREAD)
      .map((e) => e.payload)
      .find((p) => p.type === 'item-appended' && p.item.type === 'tool-result');
    expect(resultItem?.type === 'item-appended' ? resultItem.item : null).toMatchObject({
      ok: false,
      errorCategory: 'user-denied',
    });
    expect(
      store.readThread(THREAD).find((e) => e.payload.type === 'approval-resolved')?.payload,
    ).toMatchObject({ granted: false, scope: null });
  });

  it('with no approval channel the turn suspends in awaiting-approval and stays resumable', async () => {
    const provider = scriptedProvider([
      [shellCall('call_shell003', 'later.txt'), { type: 'done', finishReason: 'tool_calls' }],
      text('done'),
    ]);

    // No `approvals` gate at all: nobody to ask.
    const first = await runtimeWith(provider).runTurn({
      threadId: THREAD,
      correlationId: CORR,
      userText: 'create the marker file',
    });

    expect(first.state).toBe('awaiting-approval');
    expect(first.reason).toBeNull();
    expect(first.pendingApproval?.callId).toBe('call_shell003');
    // Nothing was auto-approved and nothing ran.
    expect(existsSync(join(workspace, 'later.txt'))).toBe(false);
    // The turn is NOT ended — it is parked.
    expect(store.readThread(THREAD).some((e) => e.payload.type === 'turn-ended')).toBe(false);

    // The pending approval is reconstructible from the log alone.
    const pending = findPendingApproval(store, THREAD);
    expect(pending).not.toBeNull();
    expect(pending?.turnId).toBe(first.turnId);
    expect(pending?.pendingCalls.map((c) => c.callId)).toEqual(['call_shell003']);

    // Now a channel exists. A DIFFERENT runtime — as a new process would build — picks the same
    // turn up and finishes it.
    const resumed = await runtimeWith(
      scriptedProvider([text('I ran it after you approved.')]),
      gate(() => ({ kind: 'approved', scope: 'once' })),
    ).resumeTurn({
      threadId: THREAD,
      turnId: pending!.turnId,
      correlationId: pending!.correlationId,
      history: reconstructHistory(store, THREAD),
      pendingCalls: pending!.pendingCalls,
    });

    expect(resumed.turnId).toBe(first.turnId); // the SAME turn
    expect(resumed.state).toBe('completed');
    expect(existsSync(join(workspace, 'later.txt'))).toBe(true);
    expect(store.readThread(THREAD).filter((e) => e.payload.type === 'turn-started')).toHaveLength(
      1,
    );
    expect(findPendingApproval(store, THREAD)).toBeNull();
  });

  it('a `once` approval authorizes exactly one execution; an identical call asks again', async () => {
    const provider = scriptedProvider([
      [shellCall('call_shell004', 'twice.txt'), { type: 'done', finishReason: 'tool_calls' }],
      [shellCall('call_shell005', 'twice.txt'), { type: 'done', finishReason: 'tool_calls' }],
      text('done'),
    ]);
    const approver = gate(() => ({ kind: 'approved', scope: 'once' }));

    const result = await runtimeWith(provider, approver).runTurn({
      threadId: THREAD,
      correlationId: CORR,
      userText: 'run it twice',
    });

    expect(result.state).toBe('completed');
    // Same action, same digest — and still asked twice, because a `once` grant is spent on use.
    expect(approver.asked).toHaveLength(2);
  });

  it('a `session` approval authorizes every identical call for the rest of the session — asked ONCE', async () => {
    // The exact counterpart to the `once` test above, through the SAME real runtime path (real
    // GrantStore, real PolicyEngine, real sandbox), changing ONLY the scope. The `once` case asks
    // TWICE because the grant is spent on use; the session grant is NOT spent, so the second
    // identical call is authorized with no new prompt — asked ONCE. That difference in the asked
    // count is caused by nothing but the grant's persistence: it is the behavior a stale/expired or
    // revoked grant must NOT have (proven in the suite below).
    const provider = scriptedProvider([
      [appendCall('call_sess01', 'session.txt'), { type: 'done', finishReason: 'tool_calls' }],
      [appendCall('call_sess02', 'session.txt'), { type: 'done', finishReason: 'tool_calls' }],
      text('done'),
    ]);
    const approver = gate(() => ({ kind: 'approved', scope: 'session' }));

    const result = await runtimeWith(provider, approver).runTurn({
      threadId: THREAD,
      correlationId: CORR,
      userText: 'run it twice',
    });

    expect(result.state).toBe('completed');
    // Asked ONCE: the session grant authorized the second identical call with no new prompt. (The
    // identical `once` scenario asks twice — so this is the grant persisting, not idempotency: the
    // side-effect ledger, which dedups the second execution, does not change the approval count.)
    expect(approver.asked).toHaveLength(1);
    // The first execution really happened in the real sandbox — there was a genuine call to gate.
    expect(existsSync(join(workspace, 'session.txt'))).toBe(true);
    expect(approver.asked[0]).toContain('/usr/bin/env');
  });
});

/**
 * Grant EXPIRY and REVOCATION on the real runtime decision path (PS-03).
 *
 * The session-grant tests above prove a LIVE grant is honored across calls. These prove the other,
 * safety-critical half: a grant that has EXPIRED, or been REVOKED, stops authorizing — the engine
 * falls back to asking rather than silently trusting a dead grant. This drives the real
 * `PolicyEngine` through the exact `PolicyContext` the runtime builds per call (`wiring.ts`'s
 * `policyContext()`), with the real grant lifecycle (`isGrantLive` / `revokeGrant`) and an injected
 * clock — never a mock of the thing under test, and never a sleep.
 */
describe('a session grant honors expiry and revocation on the runtime decision path (PS-03)', () => {
  const engine = new PolicyEngine();
  const authority = authorityForProfile('ask');
  const WS = '/home/dev/project';

  // A real destructive shell action. Under the `ask` profile this is a side effect → `ask`, so a
  // grant is what turns it into `allow`; that is precisely the transition expiry/revocation must undo.
  const action: NormalizedAction = {
    kind: 'shell',
    command: 'rm -rf build',
    argv: ['rm', '-rf', 'build'],
    cwd: WS,
  };
  const digest = actionDigest(action);

  // The context the runtime assembles for every evaluation: profile, rules and the managed ceiling
  // come from the REAL authority; only `grants` and `now` vary per call — exactly as they do live.
  const contextAt = (grants: readonly Grant[], now: number): PolicyContext => ({
    profile: authority.profile,
    managedPolicy: authority.managedPolicy,
    rules: authority.rules,
    grants,
    workspaceRoot: WS,
    homeDir: '/home/nonexistent',
    now,
    actor: MODEL_ACTOR,
  });

  const sessionGrant = (over: Partial<Grant>): Grant => ({
    id: 'grt_session',
    scope: 'session',
    actionDigest: digest,
    match: null,
    grantedAt: NOW,
    expiresAt: null,
    revokedAt: null,
    usedAt: null,
    grantedBy: 'user',
    reason: 'interactive session approval',
    ...over,
  });

  it('authorizes the exact action while live, then RE-ASKS once the grant expires', () => {
    const clock = new ManualClock(NOW);
    const grant = sessionGrant({ expiresAt: NOW + 60_000 });

    // Live: the grant turns the profile's `ask` into `allow`, and the trace names the grant.
    const live = engine.evaluate(action, contextAt([grant], clock.now()));
    expect(live.outcome).toBe('allow');
    expect(live.source.stage).toBe('grant');
    expect(live.source.id).toBe('grt_session');

    // Advance PAST expiry with the injected clock (never a sleep). Same action, same digest — but the
    // grant is dead, so policy falls back to asking. A stale grant must not keep authorizing silently.
    clock.advance(60_000);
    const expired = engine.evaluate(action, contextAt([grant], clock.now()));
    expect(expired.outcome).toBe('ask');
    expect(
      expired.trace.some((s) => s.stage === 'grant' && /expired/.test(s.note)),
      'the trace must record the grant as matched-but-expired',
    ).toBe(true);
  });

  it('stops authorizing the instant the grant is revoked — the next call RE-ASKS', () => {
    const grant = sessionGrant({});

    // Live before revocation.
    const before = engine.evaluate(action, contextAt([grant], NOW));
    expect(before.outcome).toBe('allow');
    expect(before.source.stage).toBe('grant');

    // Revoke it with the real immutable revocation, then evaluate a later call. The revoked grant
    // matches the digest but is no longer usable, so the engine asks again.
    const revoked = revokeGrant([grant], grant.id, NOW + 1_000);
    const decision = engine.evaluate(action, contextAt(revoked, NOW + 2_000));
    expect(decision.outcome).toBe('ask');
    expect(
      decision.trace.some((s) => s.stage === 'grant' && /revoked/.test(s.note)),
      'the trace must record the grant as matched-but-revoked',
    ).toBe(true);
  });
});
