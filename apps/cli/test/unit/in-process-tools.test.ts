import { PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, MODEL_ACTOR, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inProcessExecutor,
  MAX_RETRIEVE_CHARS,
  type UserInteraction,
} from '../../src/in-process-tools.ts';
import { authorityForProfile } from '../../src/policy-from-config.ts';

/**
 * TL-02 (U): the two in-process tool handlers in ISOLATION, against a REAL in-memory `EventStore`
 * (so `retrieve_output` reads a genuinely `putBlob`'d blob) and a fake `UserInteraction`.
 *
 * These prove the handlers' contracts: a hit returns the full content, a miss is a `not-found`, a
 * huge blob is bounded, an answer is returned verbatim, and no channel is a typed `unsupported` —
 * never a fabricated answer.
 */

const WORKSPACE = '/workspace';
const NOW = 1_700_000_000_000;

const stringUI: UserInteraction = { ask: () => Promise.resolve('the user typed this') };
const nullUI: UserInteraction = { ask: () => Promise.resolve(null) };

const call = (toolName: string, args: Record<string, unknown>) => ({
  callId: 'call_0001',
  toolName,
  arguments: args,
  argumentsJson: JSON.stringify(args),
  signal: new AbortController().signal,
});

describe('in-process tools (real store, fake user channel)', () => {
  let store: EventStore;
  let clock: ManualClock;
  let ids: SequentialIds;

  const authority = authorityForProfile('ask');
  const policyContext = (): PolicyContext => ({
    profile: authority.profile,
    managedPolicy: authority.managedPolicy,
    rules: authority.rules,
    grants: [],
    workspaceRoot: WORKSPACE,
    homeDir: '/home/nobody',
    now: NOW,
    actor: MODEL_ACTOR,
  });

  const makeExecutor = (ui: UserInteraction) =>
    inProcessExecutor({
      blob: store,
      userInteraction: ui,
      policy: new PolicyEngine(),
      policyContext,
      workspaceRoot: WORKSPACE,
      clock: { now: () => clock.now() },
    });

  beforeEach(() => {
    clock = new ManualClock(NOW);
    ids = new SequentialIds();
    store = new EventStore({ path: ':memory:', clock, ids });
  });
  afterEach(() => store.close());

  it('retrieve_output returns the full content of an offloaded blob (hit)', async () => {
    store.putBlob('blb_hit', 'the full offloaded output');
    const result = await makeExecutor(stringUI).execute(
      call('retrieve_output', { ref: 'blb_hit' }),
    );
    expect(result.ok).toBe(true);
    expect(result.modelText).toBe('the full offloaded output');
    expect(result.outputRef).toBe('blb_hit');
    expect(result.errorCategory).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('retrieve_output on an unknown ref is a typed not-found (miss)', async () => {
    const result = await makeExecutor(stringUI).execute(
      call('retrieve_output', { ref: 'blb_missing' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('not-found');
    expect(result.modelText).toContain('blb_missing');
  });

  it('retrieve_output bounds an oversized blob and marks it truncated', async () => {
    const big = 'x'.repeat(MAX_RETRIEVE_CHARS + 5000);
    store.putBlob('blb_big', big);
    const result = await makeExecutor(stringUI).execute(
      call('retrieve_output', { ref: 'blb_big' }),
    );
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.modelText.length).toBeLessThan(big.length);
    expect(result.modelText).toContain('truncated');
  });

  it('retrieve_output rejects malformed arguments as invalid-input', async () => {
    const result = await makeExecutor(stringUI).execute(call('retrieve_output', { nope: 1 }));
    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('invalid-input');
  });

  it('ask_user returns the answer when a channel is present', async () => {
    const result = await makeExecutor(stringUI).execute(
      call('ask_user', { question: 'what is your name?' }),
    );
    expect(result.ok).toBe(true);
    expect(result.modelText).toBe('the user typed this');
    expect(result.errorCategory).toBeNull();
  });

  it('ask_user with no channel is a typed unsupported, never a fabricated answer', async () => {
    const result = await makeExecutor(nullUI).execute(
      call('ask_user', { question: 'what is your name?' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('unsupported');
  });

  it('a signal already aborted yields no answer (null), not a made-up one', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // A UserInteraction that would answer if asked — the CLI channel returns null when aborted.
    const wouldAnswer: UserInteraction = {
      ask: (_q, signal) => Promise.resolve(signal.aborted ? null : 'nope'),
    };
    const result = await makeExecutor(wouldAnswer).execute({
      callId: 'call_x',
      toolName: 'ask_user',
      arguments: { question: 'q' },
      argumentsJson: '{"question":"q"}',
      signal: ctrl.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('unsupported');
  });

  it('evaluate is a REAL policy decision (allow for a workspace read) with a real source', async () => {
    const evaluation = await makeExecutor(stringUI).evaluate({
      callId: 'call_0001',
      toolName: 'retrieve_output',
      arguments: { ref: 'blb_hit' },
    });
    expect(evaluation.status).toBe('allow');
    // The digest is the file-read action's real digest, and the source names a genuine policy stage
    // (`stage:id`) — not a hardcoded literal.
    expect(evaluation.actionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluation.source).toContain(':');
  });
});
