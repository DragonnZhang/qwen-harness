import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { authorityForProfile, createHarnessRuntime, type HarnessRuntime } from '@qwen-harness/cli';
import { DashScopeProvider } from '@qwen-harness/provider-dashscope';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { FixtureRepo, SequentialIds } from '@qwen-harness/testkit';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * GOLDEN PATH 9 (Live model) — the credentialed acceptance path.
 *
 * The real `qwen3.7-max`, through the REAL composition (`createHarnessRuntime`), drives a coding
 * loop against a REAL sandboxed workspace: it reads a failing test, reads the buggy source, edits
 * the fix, runs the test, and sees it pass. Nothing here is scripted except the auto-approval a
 * human would give at the prompt — the model, its tool choices, the sandbox, and the durable log
 * are all real.
 *
 * This is a BUDGETED live test: a handful of real API calls. It fails CLOSED (skipped) when no key
 * is present and is excluded from `pnpm check` — the deterministic `evals/e2e/coding-loop.test.ts`
 * proves the same loop offline. The value here is the L-lane evidence: that the actual model, not a
 * fixture, completes the task and that no secret leaks into the durable trace.
 */

const hasKey = Boolean(process.env['DASHSCOPE_API_KEY']);
const client = new ToolWorkerClient();
const sandboxOk = client.detect().available;

/** Auto-approve exactly what a user would say yes to. A live headless run has no terminal. */
const autoApprove = {
  request: () => Promise.resolve({ kind: 'approved' as const, scope: 'session' as const }),
};

describe.skipIf(!hasKey || !sandboxOk)('live coding loop (qwen3.7-max, real sandbox)', () => {
  let repo: FixtureRepo;
  let store: EventStore;
  let ids: SequentialIds;

  beforeEach(() => {
    // A buggy `multiply` that adds, and a test that fails until it is fixed.
    repo = FixtureRepo.create({
      'math.mjs': 'export function multiply(a, b) {\n  return a + b;\n}\n',
      'math.test.mjs':
        "import assert from 'node:assert';\nimport { multiply } from './math.mjs';\nassert.equal(multiply(6, 7), 42);\nconsole.log('PASS');\n",
    });
    ids = new SequentialIds();
    store = new EventStore({
      path: ':memory:',
      clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      ids,
    });
  });

  afterEach(() => {
    store.close();
    repo.dispose();
  });

  function runtimeFor(provider?: DashScopeProvider): HarnessRuntime {
    return createHarnessRuntime({
      workspaceRoot: repo.root,
      // A real ceiling that permits sandboxed edits + shell, approved via the gate below.
      authority: authorityForProfile('ask'),
      model: 'qwen3.7-max',
      instructions:
        'You are a terse coding assistant in a sandboxed workspace. Fix the failing test by ' +
        'editing the source, then run the test to confirm it passes. Use the provided tools.',
      homeDir: homedir(),
      clock: { now: () => Date.now() },
      ids,
      store,
      client,
      approvals: autoApprove,
      ...(provider ? { provider } : {}),
    });
  }

  it('the real model fixes the bug and the fixture test passes', async () => {
    const threadId = ids.next('thr') as ThreadId;
    const correlationId = ids.next('cor') as CorrelationId;
    store.append({
      threadId,
      correlationId,
      permissionProfile: 'ask',
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: repo.root, canonicalRepo: repo.root, name: null },
    });

    const runtime = runtimeFor();
    const result = await runtime.runTurn({
      threadId,
      correlationId,
      userText:
        'The test in math.test.mjs is failing. Fix multiply() in math.mjs so the test passes, ' +
        'then run the test to confirm.',
    });

    // The turn completed (not blocked, not failed).
    expect(result.state, `terminated ${result.state}: ${result.finalText ?? ''}`).toBe('completed');

    // The fix really landed on disk: multiply now multiplies.
    const source = readFileSync(repo.path('math.mjs'), 'utf8');
    expect(source).toMatch(/a\s*\*\s*b/);

    // And the fixture test really passes now.
    const out = execFileSync('/usr/bin/env', ['node', 'math.test.mjs'], {
      cwd: repo.root,
      encoding: 'utf8',
    });
    expect(out).toContain('PASS');

    // No secret anywhere in the durable log (the whole thread, as persisted).
    const dump = JSON.stringify(store.readThread(threadId));
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  }, 300_000);

  it('survives a transient retryable provider fault and still completes', async () => {
    // Fail ONCE with a dropped connection (a thrown transport error, which the provider classifies
    // `retryable` with `sideEffectCertainty: not-started`), then delegate to the real service. This
    // proves the newly-wired turn-engine retry recovers against the LIVE endpoint — a real fault,
    // real recovery. (The retry RULES are proven deterministically in
    // packages/runtime/test/integration/turn-engine.test.ts; this is the live end of it.)
    let failed = false;
    const realFetch = globalThis.fetch;
    const flakyFetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!failed) {
        failed = true;
        return Promise.reject(new TypeError('fetch failed: ECONNRESET (injected transient fault)'));
      }
      return realFetch(url, init);
    }) as typeof fetch;

    const provider = new DashScopeProvider({ fetchImpl: flakyFetch });
    const threadId = ids.next('thr') as ThreadId;
    const correlationId = ids.next('cor') as CorrelationId;
    store.append({
      threadId,
      correlationId,
      permissionProfile: 'ask',
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: repo.root, canonicalRepo: repo.root, name: null },
    });

    const runtime = runtimeFor(provider);
    const result = await runtime.runTurn({
      threadId,
      correlationId,
      userText: 'Reply with the single word: ready.',
    });

    expect(failed).toBe(true); // the injected fault actually fired
    expect(result.state, `terminated ${result.state}`).toBe('completed');
  }, 300_000);
});
