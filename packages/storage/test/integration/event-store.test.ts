import { beforeEach, describe, expect, it } from 'vitest';

import type {
  CorrelationId,
  ItemId,
  SideEffectId,
  ThreadId,
  ToolCallId,
  TurnId,
} from '@qwen-harness/protocol';
import { MODEL_ACTOR, SequentialIds, USER_ACTOR, ManualClock } from '@qwen-harness/testkit';

import {
  EventStore,
  InjectedFailure,
  exportJsonl,
  importJsonl,
  replayInto,
  type FailureBoundary,
} from '../../src/index.ts';

const THREAD = 'thr_000001' as ThreadId;
const TURN = 'trn_000001' as TurnId;
const CORR = 'cor_000001' as CorrelationId;

function newStore(failAt?: FailureBoundary) {
  return new EventStore({
    path: ':memory:',
    clock: new ManualClock(1_700_000_000_000),
    ids: new SequentialIds(),
    failAt,
  });
}

/** Drives a complete, realistic turn: user -> model -> tool intent -> tool result -> done. */
function completeTurn(store: EventStore) {
  const base = {
    threadId: THREAD,
    correlationId: CORR,
    permissionProfile: 'ask' as const,
  };

  store.append({
    ...base,
    actor: USER_ACTOR,
    payload: {
      type: 'thread-created',
      cwd: '/workspace',
      canonicalRepo: '/workspace',
      name: null,
    },
  });
  store.append({
    ...base,
    actor: USER_ACTOR,
    turnId: TURN,
    payload: { type: 'turn-started', userText: 'fix the bug' },
  });
  store.append({
    ...base,
    actor: MODEL_ACTOR,
    turnId: TURN,
    payload: {
      type: 'turn-state-changed',
      from: 'preparing',
      to: 'model-streaming',
    },
  });
  store.append({
    ...base,
    actor: MODEL_ACTOR,
    turnId: TURN,
    itemId: 'itm_000001' as ItemId,
    payload: {
      type: 'item-appended',
      item: {
        type: 'tool-call',
        id: 'itm_000001' as ItemId,
        turnId: TURN,
        threadId: THREAD,
        seq: 0,
        createdAt: 1_700_000_000_000,
        callId: 'call_000001' as ToolCallId,
        toolName: 'write_file',
        argumentsJson: '{"path":"a.ts"}',
        arguments: { path: 'a.ts' },
      },
    },
  });
  store.append({
    ...base,
    actor: MODEL_ACTOR,
    turnId: TURN,
    payload: {
      type: 'side-effect-intent',
      intent: {
        sideEffectId: 'sfx_000001' as SideEffectId,
        idempotencyKey: 'write:/workspace/a.ts:sha-abc',
        kind: 'file-write',
        destructive: true,
        normalizedAction: 'write /workspace/a.ts',
      },
    },
  });
  store.append({
    ...base,
    actor: MODEL_ACTOR,
    turnId: TURN,
    payload: {
      type: 'side-effect-started',
      sideEffectId: 'sfx_000001' as SideEffectId,
    },
  });
  store.append({
    ...base,
    actor: MODEL_ACTOR,
    turnId: TURN,
    payload: {
      type: 'side-effect-settled',
      sideEffectId: 'sfx_000001' as SideEffectId,
      state: 'known-complete',
      resultDigest: 'sha-def',
    },
  });
  store.append({
    ...base,
    actor: MODEL_ACTOR,
    turnId: TURN,
    payload: {
      type: 'turn-ended',
      state: 'completed',
      reason: 'natural-completion',
    },
  });
}

describe('EventStore: append and projection', () => {
  let store: EventStore;
  beforeEach(() => {
    store = newStore();
  });

  it('assigns a gap-free monotonic per-thread sequence', () => {
    completeTurn(store);
    const events = store.readThread(THREAD);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('projects the thread, turn, and item from the log', () => {
    completeTurn(store);

    const thread = store.getThread(THREAD);
    expect(thread).toMatchObject({
      id: THREAD,
      cwd: '/workspace',
      archived: false,
    });

    const turn = store.db.prepare('SELECT * FROM turns WHERE id = ?').get(TURN) as {
      state: string;
      termination_reason: string;
    };
    expect(turn.state).toBe('completed');
    expect(turn.termination_reason).toBe('natural-completion');

    const items = store.db.prepare('SELECT * FROM items').all();
    expect(items).toHaveLength(1);
  });

  it('refuses two writers claiming the same sequence (single-writer guard)', () => {
    completeTurn(store);
    // Simulate a second, independent writer trying to interleave the thread by forcing a
    // duplicate (thread_id, seq). The UNIQUE constraint — not a lock we hope is held — rejects it.
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO events (id, schema_version, thread_id, seq, timestamp, actor_kind, actor_id,
             correlation_id, permission_profile, payload_type, payload)
           VALUES ('evt_dupe', 1, ?, 3, 0, 'user', 'act_x', 'cor_x', 'ask', 'x', '{}')`,
        )
        .run(THREAD),
    ).toThrow(/UNIQUE/i);
  });
});

describe('EventStore: deterministic projection rebuild (SS-01, SS-06)', () => {
  it('rebuilds byte-identical projections by replaying the log', () => {
    const store = newStore();
    completeTurn(store);

    const snapshot = () => ({
      threads: store.db.prepare('SELECT * FROM threads ORDER BY id').all(),
      turns: store.db.prepare('SELECT * FROM turns ORDER BY id').all(),
      items: store.db.prepare('SELECT * FROM items ORDER BY id').all(),
      sideEffects: store.db.prepare('SELECT * FROM side_effects ORDER BY id').all(),
    });

    const before = snapshot();
    const result = store.rebuildProjections();
    const after = snapshot();

    expect(result.events).toBe(8);
    // Not "equivalent" — identical. If a projection were order-dependent or non-deterministic,
    // this is where it would show up.
    expect(after).toEqual(before);
  });
});

describe('EventStore: crash boundaries (acceptance.md reliability gate)', () => {
  const boundaries: FailureBoundary[] = [
    'before-event-insert',
    'after-event-insert-before-projection',
    'after-projection-before-commit',
  ];

  it.each(boundaries)(
    'rolls back atomically at "%s" — the event and its projection are all-or-nothing',
    (boundary) => {
      const store = new EventStore({
        path: ':memory:',
        clock: new ManualClock(0),
        ids: new SequentialIds(),
        failAt: boundary,
      });

      expect(() =>
        store.append({
          threadId: THREAD,
          correlationId: CORR,
          permissionProfile: 'ask',
          actor: USER_ACTOR,
          payload: {
            type: 'thread-created',
            cwd: '/w',
            canonicalRepo: null,
            name: null,
          },
        }),
      ).toThrow(InjectedFailure);

      // The whole point: after a crash at ANY boundary, the log and the projection agree —
      // both are empty. There is no state where the event exists but the thread does not.
      const events = store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      const threads = store.db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
      expect(events.n).toBe(0);
      expect(threads.n).toBe(0);
    },
  );
});

describe('EventStore: side-effect recovery — never replay a completed action (SS-05)', () => {
  it('refuses to re-run a known-complete side effect', () => {
    const store = newStore();
    completeTurn(store);

    const verdict = store.mayExecute('write:/workspace/a.ts:sha-abc');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/already completed/i);
  });

  it('allows a fresh action and a known-failed retry', () => {
    const store = newStore();
    completeTurn(store);
    expect(store.mayExecute('write:/workspace/never-seen.ts').allowed).toBe(true);

    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      turnId: TURN,
      actor: MODEL_ACTOR,
      payload: {
        type: 'side-effect-intent',
        intent: {
          sideEffectId: 'sfx_000002' as SideEffectId,
          idempotencyKey: 'shell:npm-test',
          kind: 'shell',
          destructive: false,
          normalizedAction: 'npm test',
        },
      },
    });
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      turnId: TURN,
      actor: MODEL_ACTOR,
      payload: {
        type: 'side-effect-settled',
        sideEffectId: 'sfx_000002' as SideEffectId,
        state: 'known-failed',
        resultDigest: null,
      },
    });

    expect(store.mayExecute('shell:npm-test').allowed).toBe(true);
  });

  it('promotes an interrupted in-flight action to INDETERMINATE and refuses to replay it', () => {
    const store = newStore();
    const base = {
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask' as const,
      turnId: TURN,
    };

    store.append({
      ...base,
      actor: USER_ACTOR,
      payload: {
        type: 'thread-created',
        cwd: '/w',
        canonicalRepo: null,
        name: null,
      },
    });
    store.append({
      ...base,
      actor: MODEL_ACTOR,
      payload: {
        type: 'side-effect-intent',
        intent: {
          sideEffectId: 'sfx_000009' as SideEffectId,
          idempotencyKey: 'shell:rm -rf build',
          kind: 'shell',
          destructive: true,
          normalizedAction: 'rm -rf build',
        },
      },
    });
    // We started it... and then the process died. No settle event was ever written.
    store.append({
      ...base,
      actor: MODEL_ACTOR,
      payload: {
        type: 'side-effect-started',
        sideEffectId: 'sfx_000009' as SideEffectId,
      },
    });

    expect(store.sideEffectState('shell:rm -rf build')).toBe('in-flight');

    // Recovery runs on restart.
    const { promoted } = store.recoverInterrupted();
    expect(promoted).toBe(1);
    expect(store.sideEffectState('shell:rm -rf build')).toBe('indeterminate');

    // The critical assertion. We do NOT know whether `rm -rf build` ran. Guessing "failed" and
    // re-running it is exactly the bug this ledger exists to prevent.
    const verdict = store.mayExecute('shell:rm -rf build');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/indeterminate/i);

    const pending = store.listIndeterminate(THREAD);
    expect(pending).toEqual([
      { id: 'sfx_000009', normalizedAction: 'rm -rf build', destructive: true },
    ]);
  });
});

describe('EventStore: JSONL export and replay (SS-06)', () => {
  it('round-trips a complete turn into an identical projection', () => {
    const source = newStore();
    completeTurn(source);

    const jsonl = exportJsonl(source, { exportedAt: 1_700_000_000_000 });
    const parsed = importJsonl(jsonl);
    expect(parsed.header.eventCount).toBe(8);
    expect(parsed.unknownCount).toBe(0);

    // Replay into a *fresh* database and compare the resulting projections.
    const target = newStore();
    replayInto(target, parsed.events);

    const strip = (rows: unknown[]) => JSON.parse(JSON.stringify(rows)) as unknown;
    expect(strip(target.db.prepare('SELECT * FROM threads ORDER BY id').all())).toEqual(
      strip(source.db.prepare('SELECT * FROM threads ORDER BY id').all()),
    );
    expect(strip(target.db.prepare('SELECT * FROM turns ORDER BY id').all())).toEqual(
      strip(source.db.prepare('SELECT * FROM turns ORDER BY id').all()),
    );
    expect(strip(target.db.prepare('SELECT * FROM side_effects ORDER BY id').all())).toEqual(
      strip(source.db.prepare('SELECT * FROM side_effects ORDER BY id').all()),
    );

    // And the recovered store still refuses to replay the completed side effect.
    expect(target.mayExecute('write:/workspace/a.ts:sha-abc').allowed).toBe(false);
  });

  it('preserves an event from a FUTURE build across export -> import (RT-09)', () => {
    const store = newStore();
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: {
        type: 'thread-created',
        cwd: '/w',
        canonicalRepo: null,
        name: null,
      },
    });

    // An event this build has never heard of, written directly as a newer build would.
    store.db
      .prepare(
        `INSERT INTO events (id, schema_version, thread_id, seq, timestamp, actor_kind, actor_id,
           correlation_id, permission_profile, payload_type, payload)
         VALUES ('evt_future', 99, ?, 1, 123, 'model', 'act_model1', 'cor_000001', 'ask',
                 'holographic-projection', '{"type":"holographic-projection","depth":7}')`,
      )
      .run(THREAD);

    const jsonl = exportJsonl(store, { exportedAt: 0 });
    const parsed = importJsonl(jsonl);

    expect(parsed.unknownCount).toBe(1);
    const unknown = parsed.events.find((e) => e.payload.type === 'unknown');
    expect(unknown?.payload).toMatchObject({
      originalType: 'holographic-projection',
      raw: { type: 'holographic-projection', depth: 7 },
    });
    // Data survived. An older build did not silently destroy a newer build's event.
  });
});
