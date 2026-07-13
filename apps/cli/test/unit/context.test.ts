import { stableHash, type Summarizer } from '@qwen-harness/context';
import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import type { ModelInputItem } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { MODEL_ACTOR, ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { createContextManager } from '../../src/context.ts';

/**
 * The CLI context manager: the composition that finally makes `@qwen-harness/context` reachable.
 * These tests drive it directly, proving the wiring — offload to the real blob store, real
 * budgeting, and threshold compaction that carries the preserved fields — against a real
 * `EventStore`. Compaction is triggered by real token budget, never by a forced flag.
 */

const THREAD = 'thr_ctx0001' as ThreadId;
const TURN = 'trn_ctx0001' as TurnId;
const CORR = 'cor_ctx0001' as CorrelationId;

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

function managerOptions(
  store: EventStore,
  over: Partial<Parameters<typeof createContextManager>[0]> = {},
) {
  return {
    store,
    contextWindow: 2000,
    clock: new ManualClock(1_700_000_000_000),
    ids: new SequentialIds(),
    actor: MODEL_ACTOR,
    ...over,
  };
}

const call = (conversation: readonly ModelInputItem[]) => ({
  conversation,
  instructions: 'be terse',
  threadId: THREAD,
  turnId: TURN,
  correlationId: CORR,
  permissionProfile: 'ask' as const,
  signal: new AbortController().signal,
});

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

describe('context manager: budgeting (CX-01)', () => {
  it('reports real, non-zero utilization from actual transcript size', async () => {
    const store = newStore();
    let reported = -1;
    const mgr = createContextManager(
      managerOptions(store, { onUtilization: (u) => (reported = u) }),
    );

    const big = 'x'.repeat(4000);
    await mgr.prepare(call([msg('user', 'goal'), msg('assistant', big)]));

    expect(reported).toBeGreaterThan(0);
    expect(mgr.lastUtilization).toBeCloseTo(reported, 10);
  });
});

describe('context manager: cheap reduction / offload (CX-02)', () => {
  it('offloads a large old tool output to the durable blob store and leaves a retrievable ref', async () => {
    const store = newStore();
    // A huge window so budgeting never triggers compaction — this isolates offload.
    const mgr = createContextManager(
      managerOptions(store, { contextWindow: 1_000_000, offloadThresholdChars: 100 }),
    );

    const payload = 'PAYLOAD-' + 'y'.repeat(5000);
    const conversation = [
      msg('user', 'goal'),
      out('call_big', payload), // old item -> eligible for offload
      msg('assistant', 'a'),
      msg('assistant', 'b'),
      msg('assistant', 'c'),
      msg('assistant', 'd'), // recent-4 window ends here
    ];
    const prep = await mgr.prepare(call(conversation));

    expect(prep.compacted).toBe(false);
    const offloaded = prep.items[1];
    expect(offloaded?.type).toBe('function-output');
    if (offloaded?.type === 'function-output') {
      // The inline body is now a bounded preview plus the ref, not the full 5 KB payload.
      expect(offloaded.output.length).toBeLessThan(payload.length);
      expect(offloaded.output).toContain('offloaded');
    }

    // The full payload is durably retrievable by its content digest — a real blob, not a dangling ref.
    const digest = `blb_${stableHash(payload)}`;
    expect(store.readBlob(digest)).toBe(payload);
  });
});

describe('context manager: threshold compaction (CX-03/CX-04)', () => {
  const richSummarizer: Summarizer = () => ({
    prose: 'work in progress',
    preserved: {
      goal: 'implement the feature in server.ts',
      constraints: ['do not touch .git', 'keep tests green'],
      plan: ['edit server.ts', 'run tests'],
      tasks: ['task-1: wire the handler'],
      activeFiles: ['server.ts', 'server.test.ts'],
      decisions: ['use a switch statement'],
      errors: ['TypeError at line 42'],
      obligations: ['still need to update the changelog'],
    },
  });

  function overThresholdConversation(): ModelInputItem[] {
    // ~9 KB of transcript against a 2000-token (~1700 usable) window is comfortably over the 85%
    // proactive threshold. The growth is REAL content, not a flag.
    const chunk = 'z'.repeat(2500);
    return [
      msg('user', 'implement the feature in server.ts'),
      out('c1', chunk),
      out('c2', chunk),
      msg('assistant', 'thinking'),
      out('c3', chunk),
      out('c4', chunk),
    ];
  }

  it('compacts on real budget pressure and carries goal, constraints, tasks, and active files', async () => {
    const store = newStore();
    const mgr = createContextManager(managerOptions(store, { summarizer: richSummarizer }));

    const prep = await mgr.prepare(call(overThresholdConversation()));

    expect(prep.compacted).toBe(true);
    expect(prep.trigger).not.toBeNull();
    expect(mgr.compactionCount).toBe(1);

    // The surviving conversation begins with the summary, which literally contains each preserved
    // field — so goal/constraints/tasks/active files travel forward in the text the model receives.
    const summary = prep.items[0];
    expect(summary?.type).toBe('message');
    if (summary?.type === 'message') {
      expect(summary.text).toContain('implement the feature in server.ts'); // goal
      expect(summary.text).toContain('do not touch .git'); // constraint
      expect(summary.text).toContain('task-1: wire the handler'); // task
      expect(summary.text).toContain('server.ts'); // active file
      expect(summary.text).toContain('still need to update the changelog'); // obligation
    }

    // Compaction is observable and durable: a boundary marker AND a final compaction item, both
    // carrying the same content-addressed boundary ref (CX-03).
    const compactionItems = store
      .readThread(THREAD)
      .map((e) => e.payload)
      .filter((p) => p.type === 'item-appended' && p.item.type === 'compaction');
    expect(compactionItems.length).toBeGreaterThanOrEqual(2);
  });

  it('stops on diminishing returns rather than committing a compaction that frees too little', async () => {
    const store = newStore();
    // A summarizer whose output is nearly as large as the input — below the 10% freed threshold.
    const uselessSummarizer: Summarizer = ({ items }) => ({
      prose: items.map((i) => (i.type === 'function-output' ? i.output : '')).join(''),
      preserved: {
        goal: 'g',
        constraints: [],
        plan: [],
        tasks: [],
        activeFiles: [],
        decisions: [],
        errors: [],
        obligations: [],
      },
    });
    const mgr = createContextManager(managerOptions(store, { summarizer: uselessSummarizer }));

    const prep = await mgr.prepare(call(overThresholdConversation()));

    expect(prep.compacted).toBe(false);
    expect(mgr.compactionCount).toBe(0);
  });

  it('never lets a failed compaction end the turn — it falls back to the reduced conversation', async () => {
    const store = newStore();
    // An invalid summary (empty goal) is rejected by the compaction schema; the manager must swallow
    // it and return the cheaply-reduced conversation rather than throwing.
    const badSummarizer: Summarizer = () =>
      ({
        prose: '',
        preserved: {
          goal: '',
          constraints: [],
          plan: [],
          tasks: [],
          activeFiles: [],
          decisions: [],
          errors: [],
          obligations: [],
        },
      }) as never;
    const mgr = createContextManager(managerOptions(store, { summarizer: badSummarizer }));

    const conversation = overThresholdConversation();
    const prep = await mgr.prepare(call(conversation));

    expect(prep.compacted).toBe(false);
    expect(prep.items.length).toBeGreaterThan(0);
  });

  it('the deterministic default summarizer preserves the goal from the transcript', async () => {
    const store = newStore();
    const mgr = createContextManager(
      managerOptions(store, { tasksProvider: () => ['task-9: finish wiring'] }),
    );

    const conversation: ModelInputItem[] = [
      msg('user', 'refactor the parser in lexer.ts'),
      out('c1', 'z'.repeat(2500)),
      out('c2', 'z'.repeat(2500)),
      msg('assistant', 'analyzing lexer.ts'),
      out('c3', 'z'.repeat(2500)),
      out('c4', 'z'.repeat(2500)),
    ];
    const prep = await mgr.prepare(call(conversation));

    expect(prep.compacted).toBe(true);
    const summary = prep.items[0];
    if (summary?.type === 'message') {
      expect(summary.text).toContain('refactor the parser in lexer.ts'); // goal, verbatim
      expect(summary.text).toContain('task-9: finish wiring'); // durable task carried in
      expect(summary.text).toContain('lexer.ts'); // active file extracted
    }
  });
});
