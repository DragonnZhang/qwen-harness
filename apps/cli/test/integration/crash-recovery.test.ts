import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import type { ProviderStreamEvent } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { CANARY_API_KEY, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listStuck, recoverInterrupted, resolveSideEffect } from '../../src/side-effects.ts';

/**
 * INDETERMINATE SIDE-EFFECT RECOVERY, PROVED WITH A REAL CORPSE (SS-05).
 *
 * A simulated crash — setting a flag, calling a function, asserting on a fixture — would prove
 * nothing here, because the entire question is what the DATABASE looks like when a process dies
 * without getting to write anything. So this test kills a real OS process, with SIGKILL (which
 * cannot be caught, blocked, or handled), at the exact moment a real side effect is executing.
 *
 * The sequence:
 *
 *   1. A real CLI process starts a turn under `yolo` and calls `run_shell`.
 *   2. The shell command writes a marker file and then SLEEPS. The marker is how the test knows the
 *      side effect is genuinely in flight — the engine has persisted `side-effect-started` and the
 *      command is running, but `side-effect-settled` has NOT been written and never will be.
 *   3. The test SIGKILLs the process group. No cleanup. No summary. No final event.
 *   4. The test reopens the database from a fresh process and asserts what recovery does.
 *
 * The properties that matter, all asserted below:
 *
 *   - the row is left `in-flight`, and `mayExecute` already refuses it (the safety property held
 *     even before recovery existed — this is the invariant we must not regress);
 *   - `recoverInterrupted()` promotes it to `indeterminate`, NOT to `known-failed`. Guessing
 *     "failed" is what causes a double-write, and it is the single most dangerous thing recovery
 *     could do;
 *   - it is never replayed — the shell command does not run a second time;
 *   - an operator can SEE it (`listStuck`) and RESOLVE it with what they found.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const FIXTURE = join(REPO, 'apps', 'cli', 'test', 'fixtures', 'scripted-cli.ts');

function openStore(workspace: string): EventStore {
  return new EventStore({
    path: join(workspace, '.qwen-harness', 'sessions.sqlite'),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
    ids: new SequentialIds(),
  });
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A marker unique to this test run: `$pid`, the wall clock, and randomness. Two things depend on it
 * being unique — no PARALLEL integration file can mistake one of its own sandboxed children for our
 * orphan, and `pgrep -f <marker>` can only ever match a process WE spawned. (The security suite runs
 * `fileParallelism: false` for exactly this reason; a unique tag lets us stay honest in the parallel
 * integration project instead.)
 */
function uniqueMarker(tag: string): string {
  return `qh-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Count HOST processes whose command line contains `m`. This is the real process table (SB-*). */
function countHostProcesses(m: string): number {
  try {
    return Number.parseInt(execFileSync('pgrep', ['-fc', m], { encoding: 'utf8' }).trim(), 10) || 0;
  } catch {
    // pgrep exits non-zero when nothing matches — that is a count of zero, not an error.
    return 0;
  }
}

/** Poll the process table until `m` is gone, or throw after `timeoutMs` (a real leak, not a race). */
async function waitForNoHostProcess(m: string, timeoutMs = 8_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = countHostProcesses(m);
  while (count > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    count = countHostProcesses(m);
  }
  return count;
}

describe('a side effect interrupted by a real crash becomes indeterminate, never replayed', () => {
  let workspace: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-crash-'));
    mkdirSync(join(workspace, '.qwen-harness'), { recursive: true });
  });

  afterEach(() => {
    if (child?.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    child = undefined;
    rmSync(workspace, { recursive: true, force: true });
  });

  it('SIGKILL mid-execution leaves in-flight; recovery promotes it to indeterminate', async () => {
    // The markers are workspace-RELATIVE. The sandbox gives the tool its own mount namespace, so an
    // absolute host path like `/tmp/xxx/marker` does not exist inside it; the workspace does, bound
    // at `cwd`. (Writing an absolute path here silently produced an ENOENT and a side effect that
    // never started — which would have made this test pass for entirely the wrong reason.)
    const startedRel = 'side-effect-started.marker';
    const ranRel = 'ran-count.marker';
    const started = join(workspace, startedRel);
    const ranCount = join(workspace, ranRel);

    // The side effect: append to a counter file (so a REPLAY would show up as a second line), then
    // sleep long enough for us to kill the process while the command is still running.
    const shellArgs = {
      command: '/usr/bin/env',
      argv: [
        'node',
        '-e',
        `const fs=require('fs');` +
          `fs.appendFileSync(${JSON.stringify(ranRel)}, 'ran\\n');` +
          `fs.writeFileSync(${JSON.stringify(startedRel)}, 'in-flight');` +
          `setTimeout(()=>{}, 60000);`,
      ],
      cwd: '.',
    };

    const script: ProviderStreamEvent[][] = [
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_1',
          callId: 'call_kill',
          toolName: 'run_shell',
          argumentsJson: JSON.stringify(shellArgs),
          arguments: shellArgs,
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ];
    const scriptPath = join(workspace, 'script.json');
    writeFileSync(scriptPath, JSON.stringify(script));

    // --- 1. a REAL process, running the REAL CLI --------------------------------------------
    child = spawn(TSX, [FIXTURE, 'run', '--profile', 'yolo', 'do the thing'], {
      cwd: workspace,
      env: { ...process.env, QH_SCRIPT: scriptPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so SIGKILL takes the sandboxed grandchild with it and nothing survives
      // to finish the side effect behind our backs.
      detached: true,
    });

    // --- 2. wait until the side effect is genuinely IN FLIGHT ---------------------------------
    await waitForFile(started);

    // --- 3. kill it. SIGKILL cannot be caught: no cleanup, no final event. --------------------
    expect(child.pid).toBeDefined();
    process.kill(-child.pid!, 'SIGKILL');
    await new Promise<void>((r) => child!.on('exit', () => r()));

    // --- 4. a fresh process inspects the wreckage ---------------------------------------------
    const store = openStore(workspace);
    try {
      const threads = store.listThreads();
      expect(threads).toHaveLength(1);
      const threadId = threads[0]!.id;

      // The intent was persisted BEFORE the command ran, and the result never was.
      const events = store.readThread(threadId);
      const intent = events.find((e) => e.payload.type === 'side-effect-intent');
      expect(intent, 'the engine must persist intent before executing').toBeDefined();
      expect(
        events.find((e) => e.payload.type === 'side-effect-started'),
        'the engine must record that the side effect started',
      ).toBeDefined();
      expect(
        events.find((e) => e.payload.type === 'side-effect-settled'),
        'the killed process cannot have settled it — that is the whole scenario',
      ).toBeUndefined();

      const key =
        intent!.payload.type === 'side-effect-intent'
          ? intent!.payload.intent.idempotencyKey
          : '(none)';

      // BEFORE recovery: the row is `in-flight`, and execution is ALREADY refused. This is the
      // invariant that held by accident before this work; it must not regress now that recovery
      // exists.
      expect(store.sideEffectState(key)).toBe('in-flight');
      expect(store.mayExecute(key).allowed).toBe(false);

      // RECOVERY. Promotes to `indeterminate` — honest. NOT `known-failed`, which would say "safe to
      // retry" about a command that may well have completed.
      const recovered = recoverInterrupted(store);
      expect(recovered.promoted).toBe(1);
      expect(store.sideEffectState(key)).toBe('indeterminate');
      expect(store.sideEffectState(key)).not.toBe('known-failed');

      // Still refused. Recovery makes a stuck side effect VISIBLE; it does not make it runnable.
      expect(store.mayExecute(key).allowed).toBe(false);

      // The operator can now SEE it — which, before this work, they could not.
      const stuck = listStuck(store, threadId);
      expect(stuck).toHaveLength(1);
      expect(stuck[0]!.destructive).toBe(true);
      expect(stuck[0]!.normalizedAction).toContain('run_shell');

      // Recovery is idempotent: running it again promotes nothing, because nothing is in flight.
      expect(recoverInterrupted(store).promoted).toBe(0);

      // --- resolution: the operator looked, and says it FAILED --------------------------------
      const resolved = resolveSideEffect(store, {
        threadId,
        sideEffectId: stuck[0]!.id,
        finding: 'failed',
        correlationId: 'cor_000002' as CorrelationId,
        actorId: 'act_user01',
      });
      expect(resolved.state).toBe('known-failed');
      expect(store.listIndeterminate(threadId)).toHaveLength(0);
      // Only NOW may it run again — because a human said so, not because we guessed.
      expect(store.mayExecute(key).allowed).toBe(true);

      // The decision is durable HISTORY, not a projection patch: a rebuild reproduces it.
      store.rebuildProjections();
      expect(store.sideEffectState(key)).toBe('known-failed');
    } finally {
      store.close();
    }

    // NOTHING REPLAYED IT. The side effect ran exactly once — when the dead process ran it.
    expect(existsSync(ranCount)).toBe(true);
    const ranLines = readFileSync(ranCount, 'utf8').trim().split('\n');
    expect(ranLines, 'the interrupted side effect must never be re-executed').toHaveLength(1);
  });

  it('a `completed` finding refuses to let the action run again', async () => {
    // The other direction of the asymmetry. An operator who looked and found the action HAD landed
    // marks it complete; `mayExecute` must then refuse forever, because re-running it would apply
    // the side effect a second time.
    const store = openStore(workspace);
    try {
      const threadId = 'thr_000001' as ThreadId;
      store.append({
        threadId,
        correlationId: 'cor_000001' as CorrelationId,
        permissionProfile: 'yolo',
        actor: { kind: 'user', id: 'act_user01' as never },
        payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
      });
      store.append({
        threadId,
        turnId: 'trn_000001' as never,
        correlationId: 'cor_000001' as CorrelationId,
        permissionProfile: 'yolo',
        actor: { kind: 'model', id: 'act_model1' as never },
        payload: {
          type: 'side-effect-intent',
          intent: {
            sideEffectId: 'sfx_000001' as never,
            idempotencyKey: 'shell:danger',
            kind: 'shell',
            destructive: true,
            normalizedAction: 'run_shell rm -rf /tmp/x',
          },
        },
      });
      store.append({
        threadId,
        turnId: 'trn_000001' as never,
        correlationId: 'cor_000001' as CorrelationId,
        permissionProfile: 'yolo',
        actor: { kind: 'model', id: 'act_model1' as never },
        payload: { type: 'side-effect-started', sideEffectId: 'sfx_000001' as never },
      });

      recoverInterrupted(store);
      expect(store.sideEffectState('shell:danger')).toBe('indeterminate');

      resolveSideEffect(store, {
        threadId,
        sideEffectId: 'sfx_000001',
        finding: 'completed',
        correlationId: 'cor_000002' as CorrelationId,
        actorId: 'act_user01',
      });

      expect(store.sideEffectState('shell:danger')).toBe('known-complete');
      const may = store.mayExecute('shell:danger');
      expect(may.allowed).toBe(false);
      expect(may.reason).toContain('duplicate');
    } finally {
      store.close();
    }
  });

  it('SIGKILL of an interrupted turn leaves NO orphan process — a real grandchild sleeper is reaped', async () => {
    // The recovery tests prove the LEDGER is honest after a crash. This one proves the PROCESS TABLE
    // is clean after the same crash: an interrupted turn that spawned a sandboxed child which itself
    // spawned a GRANDCHILD sleeper must leave nothing behind. It is asserted against the real host
    // process table (`pgrep`), not a flag — the sandbox security suite reaps a grandchild sleeper the
    // same way, and this is that technique carried into the crash/recovery path (SB-*, ER-07).
    //
    // The reaping chain under test is not trivial: the tool worker is spawned inside bubblewrap with
    // `--die-with-parent` and `--unshare-pid`, so when the CLI dies its bwrap child dies, and the
    // kernel tears down the whole PID namespace — the child AND the grandchild with it. If any link
    // failed, the tagged `sleep 600` would still be running when we look.
    const tag = uniqueMarker('orphan');
    const startedRel = 'orphan-started.marker';
    const started = join(workspace, startedRel);

    // The sandboxed side effect: background a GRANDCHILD sleeper tagged via `$0` (so the numeric
    // `sleep` argument stays clean while `pgrep -f <tag>` can still find a survivor), announce it is
    // in flight, then the parent sleeps too. Both are 600s: far longer than the test, so anything the
    // test still sees afterwards is a genuine orphan, never a slow natural exit.
    const shellArgs = {
      command: '/usr/bin/env',
      argv: [
        'sh',
        '-c',
        `sh -c 'sleep 600' ${tag}-gc & printf inflight > ${startedRel}; sleep 600`,
        `${tag}-root`,
      ],
      cwd: '.',
    };
    const script: ProviderStreamEvent[][] = [
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_1',
          callId: 'call_orphan',
          toolName: 'run_shell',
          argumentsJson: JSON.stringify(shellArgs),
          arguments: shellArgs,
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ];
    const scriptPath = join(workspace, 'script.json');
    writeFileSync(scriptPath, JSON.stringify(script));

    child = spawn(TSX, [FIXTURE, 'run', '--profile', 'yolo', 'do the thing'], {
      cwd: workspace,
      env: { ...process.env, QH_SCRIPT: scriptPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    try {
      // Wait until the side effect is genuinely in flight, then PROVE the marker technique can see
      // the sandboxed grandchild while it lives. Without this, an assertion that "nothing survives"
      // would pass vacuously even if `pgrep` never matched anything at all.
      await waitForFile(started);
      expect(
        countHostProcesses(tag),
        'the tagged sandboxed process tree must be visible on the host while alive',
      ).toBeGreaterThan(0);

      // The crash: SIGKILL the whole CLI process group. No cleanup, no final event.
      expect(child.pid).toBeDefined();
      process.kill(-child.pid!, 'SIGKILL');
      await new Promise<void>((r) => child!.on('exit', () => r()));

      // Recovery runs, exactly as a surviving supervisor would run it.
      const store = openStore(workspace);
      try {
        recoverInterrupted(store);
      } finally {
        store.close();
      }

      // The load-bearing assertion: no orphan survives the crash. If the teardown chain leaked, the
      // tagged `sleep 600` would still be on the host and this stays > 0 until the deadline.
      const survivors = await waitForNoHostProcess(tag);
      expect(survivors, 'a crashed turn must leave NO orphan process on the host').toBe(0);
    } finally {
      // Belt and braces: never leave a real sleeper on the host, even if an assertion above threw
      // because of a genuine leak.
      try {
        execFileSync('pkill', ['-9', '-f', tag]);
      } catch {
        /* nothing matched — good */
      }
    }
  });

  it('a secret in an interrupted side effect is redacted from the durable log and the recovery artifact', async () => {
    // The generic redaction suite proves secrets never land in the store on the HAPPY path. This one
    // proves the same on the CRASH/recovery path (ER-07, S): a credential that appears in a side
    // effect which is then interrupted mid-flight must be scrubbed from the durable log AND from
    // anything recovery surfaces about the stuck action. The credential VALUE seeds the store's
    // redactor exactly as the real CLI seeds it (`DASHSCOPE_API_KEY`, read once at the provider
    // boundary), so this is the production redaction path, not a test double.
    const startedRel = 'canary-started.marker';
    const started = join(workspace, startedRel);

    // The model runs a shell command whose ARGV carries the canary. The tool-call item (argv and all)
    // is persisted BEFORE the command executes, so the secret genuinely reaches durable storage and
    // the redactor is the only thing that can keep it out of the SQLite file.
    const shellArgs = {
      command: '/usr/bin/env',
      argv: ['sh', '-c', `printf inflight > ${startedRel}; sleep 600`, CANARY_API_KEY],
      cwd: '.',
    };
    const script: ProviderStreamEvent[][] = [
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_1',
          callId: 'call_canary',
          toolName: 'run_shell',
          argumentsJson: JSON.stringify(shellArgs),
          arguments: shellArgs,
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ];
    const scriptPath = join(workspace, 'script.json');
    writeFileSync(scriptPath, JSON.stringify(script));

    child = spawn(TSX, [FIXTURE, 'run', '--profile', 'yolo', 'do the thing'], {
      cwd: workspace,
      // The canary is the live credential for this run. The provider never actually calls out (the
      // model is scripted), but the redactor is seeded from exactly this value.
      env: { ...process.env, QH_SCRIPT: scriptPath, DASHSCOPE_API_KEY: CANARY_API_KEY },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    // In flight, then crash.
    await waitForFile(started);
    expect(child.pid).toBeDefined();
    process.kill(-child.pid!, 'SIGKILL');
    await new Promise<void>((r) => child!.on('exit', () => r()));

    // A fresh process (NO secret seeded here — we inspect the raw bytes) recovers and reads the log.
    const store = openStore(workspace);
    try {
      const threads = store.listThreads();
      expect(threads).toHaveLength(1);
      const threadId = threads[0]!.id;

      recoverInterrupted(store);

      const events = store.readThread(threadId);
      const logDump = JSON.stringify(events);
      const stuck = listStuck(store, threadId);
      const recoveryDump = JSON.stringify(stuck);

      // Non-vacuous: the command really did reach the durable log (so there was a secret TO leak) and
      // recovery really did surface the stuck side effect (so there is a recovery artifact TO check).
      expect(logDump, 'the interrupted tool call must be in the durable log').toContain(
        'run_shell',
      );
      expect(stuck, 'recovery must surface the interrupted side effect').toHaveLength(1);

      // The property: the credential is nowhere in the durable log, nor in the recovery artifact.
      expect(logDump, 'the durable log must not contain the credential').not.toContain(
        CANARY_API_KEY,
      );
      expect(recoveryDump, 'the recovery artifact must not contain the credential').not.toContain(
        CANARY_API_KEY,
      );

      // And it was REDACTED, not merely never written — the placeholder proves the argv was persisted
      // and scrubbed in place, so the assertions above cannot pass for the wrong reason.
      expect(logDump, 'the credential must have been redacted where it was written').toContain(
        '[REDACTED]',
      );
    } finally {
      store.close();
    }
  });
});
