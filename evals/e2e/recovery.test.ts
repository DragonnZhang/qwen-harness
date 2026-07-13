import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import {
  TurnEngine,
  type EventSink,
  type NormalizedToolCall,
  type ToolExecutor,
} from '@qwen-harness/runtime';
import { EventStore, InjectedFailure } from '@qwen-harness/storage';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * CHECKPOINT-10 GOLDEN PATH 2 — RECOVERY.
 *
 * "Disconnect during streaming, kill runtime during a journal write and during a child process,
 *  resume, and prove no completed side effect ran twice."
 *
 * The proof is not an assertion about intent — it is a real SIGKILL of a real process and a counter
 * file on disk that would read `2` if any of these paths ever double-executed. Every scenario drives
 * the production side-effect ledger (`@qwen-harness/storage`), whose central invariant is:
 *
 *   a crash leaves work `in-flight`; recovery promotes it to `indeterminate`; and the ledger
 *   REFUSES to blind-replay an indeterminate (or known-complete) row.
 *
 * That refusal is the only thing standing between a crash and a duplicated destructive action, so
 * these tests attack it from three directions: an injected failure at the exact commit boundary
 * (the journal write), a real SIGKILL mid-side-effect (the child process), and a mid-stream provider
 * disconnect driven through the real `TurnEngine`.
 */

const WORKER = fileURLToPath(new URL('./recovery-worker.mjs', import.meta.url));
const EVALS_DIR = fileURLToPath(new URL('..', import.meta.url));

const THREAD = 'thr_recovery1' as ThreadId;
const CORR = 'cor_recovery1' as CorrelationId;

function freshStore(path: string): EventStore {
  return new EventStore({ path, clock: new ManualClock(1_700_000_000_000), ids: new SequentialIds() });
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function onExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
}

function readCounter(path: string): number {
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) || 0 : 0;
}

describe('checkpoint-10 golden path 2: recovery never double-executes a side effect', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-recovery-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // -----------------------------------------------------------------------------------------
  // (a) Kill the runtime during a JOURNAL WRITE — deterministic failure injection at the commit
  //     boundary of the `settled` record. The write must be all-or-nothing.
  // -----------------------------------------------------------------------------------------
  it('a crash while journaling the settle leaves the ledger in-flight, and recovery refuses to replay it', () => {
    const dbPath = join(dir, 'events.db');
    const key = 'sfx:delete-production-db';

    // Record intent + started durably. This is the state a real runtime reaches right before it
    // performs the side effect.
    {
      const store = freshStore(dbPath);
      store.append({
        threadId: THREAD,
        correlationId: CORR,
        permissionProfile: 'yolo',
        actor: USER_ACTOR,
        payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
      });
      store.append({
        threadId: THREAD,
        turnId: 'trn_jrnl01' as TurnId,
        correlationId: CORR,
        permissionProfile: 'yolo',
        actor: MODEL_ACTOR,
        payload: {
          type: 'side-effect-intent',
          intent: {
            sideEffectId: 'sfx_00a001' as never,
            idempotencyKey: key,
            kind: 'other',
            destructive: true,
            normalizedAction: 'delete the production database',
          },
        },
      });
      store.append({
        threadId: THREAD,
        turnId: 'trn_jrnl01' as TurnId,
        correlationId: CORR,
        permissionProfile: 'yolo',
        actor: MODEL_ACTOR,
        payload: { type: 'side-effect-started', sideEffectId: 'sfx_00a001' as never },
      });
      expect(store.sideEffectState(key)).toBe('in-flight');
      store.close();
    }

    const eventsBefore = (() => {
      const s = freshStore(dbPath);
      const n = s.readThread(THREAD).length;
      s.close();
      return n;
    })();

    // The runtime is killed AS IT writes the settle: the transaction throws at the commit boundary.
    {
      const crashing = new EventStore({
        path: dbPath,
        clock: new ManualClock(1_700_000_000_000),
        // A distinct id source: a real restart continues its id stream, so the settle event does
        // not collide with an id the previous process already wrote.
        ids: { next: (prefix) => `${prefix}_crashwrite` },
        failAt: 'after-projection-before-commit',
      });
      expect(() =>
        crashing.append({
          threadId: THREAD,
          turnId: 'trn_jrnl01' as TurnId,
          correlationId: CORR,
          permissionProfile: 'yolo',
          actor: MODEL_ACTOR,
          payload: {
            type: 'side-effect-settled',
            sideEffectId: 'sfx_00a001' as never,
            state: 'known-complete',
            resultDigest: null,
          },
        }),
      ).toThrow(InjectedFailure);
      crashing.close();
    }

    // Reopen, as a fresh process would. The settle NEVER became durable — the log and the
    // projection agree, because they commit together or not at all.
    const store = freshStore(dbPath);
    expect(store.readThread(THREAD)).toHaveLength(eventsBefore); // no partial event row
    expect(store.sideEffectState(key)).toBe('in-flight');

    // Recovery is honest about what it does not know: in-flight -> indeterminate, never a guess of
    // failed (guessing failed is what causes a double-write).
    expect(store.recoverInterrupted().promoted).toBe(1);
    expect(store.sideEffectState(key)).toBe('indeterminate');

    const may = store.mayExecute(key);
    expect(may.allowed).toBe(false);
    expect(may.reason).toContain('indeterminate');

    // And it is surfaced for inspection rather than silently retried.
    const pending = store.listIndeterminate(THREAD);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.destructive).toBe(true);

    // Rebuilding projections replays the LOG, which honestly records `in-flight` — the
    // `indeterminate` promotion is a recovery decision, never a forged log entry. Re-running
    // recovery after a rebuild lands on the same conservative verdict, deterministically (SS-06).
    store.rebuildProjections();
    expect(store.sideEffectState(key)).toBe('in-flight');
    expect(store.recoverInterrupted().promoted).toBe(1);
    expect(store.sideEffectState(key)).toBe('indeterminate');
    store.close();
  });

  // -----------------------------------------------------------------------------------------
  // (b) Kill the runtime during a CHILD PROCESS — a real SIGKILL, mid-side-effect. The counter
  //     proves the increment happened exactly once and is NOT replayed on recovery.
  // -----------------------------------------------------------------------------------------
  it('SIGKILL mid-side-effect leaves an indeterminate row; a resume refuses it and the counter stays 1', async () => {
    const dbPath = join(dir, 'events.db');
    const counterPath = join(dir, 'counter');
    const readyPath = join(dir, 'ready');
    const key = 'sfx:charge-the-card';

    const child = spawn(
      process.execPath,
      [WORKER, dbPath, counterPath, readyPath, 'crash-after-increment', key, THREAD],
      { cwd: EVALS_DIR, stdio: 'ignore' },
    );

    // The child has performed the side effect (counter -> 1) but has NOT settled it. Kill it there.
    await waitForFile(readyPath);
    expect(readCounter(counterPath)).toBe(1);
    child.kill('SIGKILL');
    const exit = await onExit(child);
    expect(exit.signal).toBe('SIGKILL');

    // A surviving process recovers the ledger. The interrupted work is indeterminate.
    const store = freshStore(dbPath);
    expect(store.sideEffectState(key)).toBe('in-flight'); // as the dead process left it
    expect(store.recoverInterrupted().promoted).toBe(1);
    expect(store.mayExecute(key).allowed).toBe(false);
    store.close();

    // Now RESUME: a fresh worker with the same idempotency key. It must honour the ledger and NOT
    // perform the side effect again. It exits 3 (skipped) and the counter is still 1.
    const resumed = spawn(
      process.execPath,
      [WORKER, dbPath, counterPath, readyPath, 'complete', key, THREAD],
      { cwd: EVALS_DIR, stdio: 'ignore' },
    );
    const resumedExit = await onExit(resumed);
    expect(resumedExit.code).toBe(3); // the mayExecute guard refused it
    expect(readCounter(counterPath)).toBe(1); // EXACTLY once, across a real crash
  });

  // -----------------------------------------------------------------------------------------
  // (c) A fully completed child, then a resume. A known-complete row is never re-run.
  // -----------------------------------------------------------------------------------------
  it('a known-complete side effect is refused on resume — the counter stays 1', async () => {
    const dbPath = join(dir, 'events.db');
    const counterPath = join(dir, 'counter');
    const readyPath = join(dir, 'ready');
    const key = 'sfx:send-the-email';

    const first = spawn(
      process.execPath,
      [WORKER, dbPath, counterPath, readyPath, 'complete', key, THREAD],
      { cwd: EVALS_DIR, stdio: 'ignore' },
    );
    expect((await onExit(first)).code).toBe(0);
    expect(readCounter(counterPath)).toBe(1);

    const store = freshStore(dbPath);
    expect(store.sideEffectState(key)).toBe('known-complete');
    expect(store.mayExecute(key).allowed).toBe(false);
    store.close();

    // Resume attempt: refused by the ledger, counter unchanged.
    const second = spawn(
      process.execPath,
      [WORKER, dbPath, counterPath, readyPath, 'complete', key, THREAD],
      { cwd: EVALS_DIR, stdio: 'ignore' },
    );
    expect((await onExit(second)).code).toBe(3);
    expect(readCounter(counterPath)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// (d) Disconnect DURING STREAMING, driven through the real TurnEngine + real EventStore. A
//     completed side-effecting tool from an earlier round is never replayed when the resume
//     re-offers the same call (PV-06 / SS-05).
// ---------------------------------------------------------------------------------------------
describe('checkpoint-10 golden path 2: a mid-stream disconnect never replays a completed tool', () => {
  const KEY = 'apply_patch:{"file":"server.ts"}';

  /** A ToolExecutor whose `execute` is a REAL side effect: it increments its own `execCount`. */
  function ledgerExecutor(): ToolExecutor & { execCount: number } {
    const exec: ToolExecutor & { execCount: number } = {
      execCount: 0,
      evaluate: () =>
        Promise.resolve({
          status: 'allow' as const,
          actionDigest: 'digest:apply_patch',
          description: 'apply_patch server.ts',
          risk: 'low' as const,
          reason: 'allowed for the golden path',
          source: 'test:golden',
        }),
      intentFor: () => ({
        idempotencyKey: KEY,
        destructive: true,
        kind: 'patch' as const,
        normalizedAction: 'apply_patch server.ts',
      }),
      execute: () => {
        exec.execCount++;
        return Promise.resolve({
          ok: true,
          modelText: 'patch applied',
          userText: 'patch applied',
          errorCategory: null,
          resultDigest: 'sha-applied',
          outputRef: null,
          truncated: false,
          durationMs: 3,
        });
      },
    };
    return exec;
  }

  const APPLY_CALL: NormalizedToolCall = {
    callId: 'call_apply0001',
    toolName: 'apply_patch',
    argumentsJson: '{"file":"server.ts"}',
    arguments: { file: 'server.ts' },
  };

  function capable() {
    return freezeCapabilities({
      textStreaming: true,
      reasoningSummary: true,
      reasoningEffortGranularity: 'graded',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    });
  }

  it('round 1 executes the tool; round 2 disconnects; resume re-offers the call and it is skipped', async () => {
    const store = new EventStore({
      path: ':memory:',
      clock: new ManualClock(1_700_000_000_000),
      ids: new SequentialIds(),
    });
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
    const sink: EventSink = {
      append: (input) => store.append({ ...input, causationId: (input.causationId ?? null) as never }),
      mayExecute: (key) => store.mayExecute(key),
    };

    const exec = ledgerExecutor();
    const ids = new SequentialIds();
    const clock = new ManualClock(1_700_000_000_000);

    // The provider: round 1 asks for the side-effecting tool; round 2's stream DISCONNECTS mid-way.
    let call = 0;
    const disconnecting: ModelProvider = {
      capabilities: capable(),
      async *stream() {
        call++;
        if (call === 1) {
          yield {
            type: 'tool-call-complete',
            itemId: 't',
            callId: APPLY_CALL.callId,
            toolName: APPLY_CALL.toolName,
            argumentsJson: APPLY_CALL.argumentsJson,
            arguments: APPLY_CALL.arguments,
          } satisfies ProviderStreamEvent;
          yield { type: 'done', finishReason: 'tool_calls' } satisfies ProviderStreamEvent;
          return;
        }
        // Round 2: a few bytes arrive, then the connection drops.
        yield { type: 'text-delta', itemId: 'm', delta: 'Working on ' } satisfies ProviderStreamEvent;
        throw new Error('stream disconnected mid-response');
      },
    };

    const engine = new TurnEngine({ provider: disconnecting, tools: exec, sink, ids, clock });
    const run = await engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: '',
      history: [],
      userText: 'apply the patch',
      tools: [],
      actor: MODEL_ACTOR,
    });

    // The turn failed on the disconnect — but the round-1 side effect completed exactly once and is
    // now known-complete in the durable ledger.
    expect(run.state).toBe('failed');
    expect(run.terminationReason).toBe('internal-error');
    expect(exec.execCount).toBe(1);
    expect(store.mayExecute(KEY).allowed).toBe(false);

    // RESUME the same turn. Recovery re-offers the interrupted round's call (it cannot know the
    // result reached the model). The engine records intent, consults the ledger, and SKIPS execution
    // — the tool never runs a second time. Then the model finishes cleanly.
    const afterReconnect: ModelProvider = {
      capabilities: capable(),
      async *stream() {
        yield { type: 'text-done', itemId: 'm', text: 'All done — patch already applied.' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const engine2 = new TurnEngine({ provider: afterReconnect, tools: exec, sink, ids, clock });
    const resumed = await engine2.resume({
      threadId: THREAD,
      turnId: run.turnId,
      correlationId: CORR,
      permissionProfile: 'yolo',
      model: 'qwen3.7-max',
      instructions: '',
      history: [],
      pendingCalls: [APPLY_CALL],
      tools: [],
      actor: MODEL_ACTOR,
    });

    expect(resumed.state).toBe('completed');
    expect(resumed.terminationReason).toBe('natural-completion');
    // The load-bearing assertion: the side effect ran EXACTLY once across the disconnect + resume.
    expect(exec.execCount).toBe(1);

    // The durable log shows the resume attempted the intent again but settled it as known-complete
    // WITHOUT a second `side-effect-started` executing the body.
    const settles = store
      .readThread(THREAD)
      .filter((e) => e.payload.type === 'side-effect-settled');
    expect(settles.length).toBeGreaterThanOrEqual(2); // round-1 real settle + resume's skip settle
    store.close();
  });
});
