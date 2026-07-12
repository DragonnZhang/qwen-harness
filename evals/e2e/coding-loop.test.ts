import { readFileSync } from 'node:fs';

import { NO_MANAGED_RESTRICTIONS, PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { registerBuiltins, ToolPipeline } from '@qwen-harness/tools-builtin';
import { ToolRegistry } from '@qwen-harness/tools-core';
import { ToolWorkerClient, type WorkerGrant } from '@qwen-harness/tool-worker';
import { FixtureRepo } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * CHECKPOINT-02 GATE (deterministic).
 *
 * A scripted "model" drives a real coding loop — inspect a failing test, read the buggy source,
 * fix it with an edit, run the test and watch it pass — entirely through the production pipeline:
 *
 *   schema validation  ->  policy (deny-by-default)  ->  the REAL bubblewrap sandbox worker.
 *
 * No mock stands in for the sandbox, the policy engine, or the filesystem. If this passes, the
 * safe vertical loop is real: model-initiated I/O executes only in the sandboxed worker, and a
 * deny-by-default policy gates every side effect.
 */

const MODEL: Actor = { kind: 'model', id: 'act_model1' as ActorId };
const client = new ToolWorkerClient();

const GRANT: WorkerGrant = {
  readable: ['workspace', 'scratch'],
  writable: ['workspace', 'scratch'],
  shell: true,
  network: false,
  limits: { wallMs: 30_000, maxOutputBytes: 2_000_000, maxFileBytes: 10_000_000 },
};

/** One scripted model tool call. */
interface ScriptedCall {
  readonly toolName: string;
  readonly args: unknown;
}

describe('checkpoint-02 coding loop (E2E, real sandbox)', () => {
  it('the sandbox is available — the gate proves a real loop, not a mocked one', () => {
    expect(client.detect().available, client.detect().detail).toBe(true);
  });

  let repo: FixtureRepo;

  beforeEach(() => {
    // A tiny project: a buggy `add` (it subtracts) and a test that will fail until it is fixed.
    repo = FixtureRepo.create({
      'add.mjs': 'export function add(a, b) {\n  return a - b;\n}\n',
      'add.test.mjs':
        "import assert from 'node:assert';\nimport { add } from './add.mjs';\nassert.equal(add(2, 3), 5);\nconsole.log('PASS');\n",
    });
  });

  afterEach(() => repo.dispose());

  function policyContext(profile: PolicyContext['profile']): PolicyContext {
    return {
      profile,
      managedPolicy: NO_MANAGED_RESTRICTIONS,
      rules: [],
      grants: [],
      workspaceRoot: repo.root,
      homeDir: '/home/nonexistent',
      now: 1_700_000_000_000,
      actor: MODEL,
    };
  }

  it('inspects a failing test, fixes the bug, and the test passes — through policy + sandbox', async () => {
    const registry = registerBuiltins(new ToolRegistry());
    const pipeline = new ToolPipeline({ registry, policy: new PolicyEngine(), client });

    // In auto-accept-edits, a workspace file edit auto-allows but shell still asks — so we run the
    // whole loop in `yolo` for determinism (no interactive channel in a headless test). yolo still
    // executes every side effect inside the real sandbox; it does not bypass isolation.
    const ctx = policyContext('yolo');
    const run = (call: ScriptedCall) =>
      pipeline.execute({
        callId: `call_${call.toolName}` as never,
        toolName: call.toolName,
        rawArguments: call.args,
        policyContext: ctx,
        grant: GRANT,
        isolation: 'workspace-write',
      });

    // 1. The model reads the failing test to understand the expectation.
    const readTest = await run({ toolName: 'read_file', args: { path: 'add.test.mjs' } });
    expect(readTest.status).toBe('executed');

    // 2. It runs the test first and observes the failure (assert throws -> non-zero exit).
    const failing = await run({
      toolName: 'run_shell',
      args: { command: '/usr/bin/env', argv: ['node', 'add.test.mjs'], cwd: '.' },
    });
    expect(failing.status).toBe('executed');
    if (failing.status === 'executed' && failing.response.ok) {
      const r = failing.response.result as { exitCode: number };
      expect(r.exitCode).not.toBe(0); // the bug is real
    }

    // 3. It reads the buggy source to locate the fix.
    const readSrc = await run({ toolName: 'read_file', args: { path: 'add.mjs' } });
    expect(readSrc.status).toBe('executed');

    // 4. It fixes the bug with a precise edit (subtraction -> addition).
    const edit = await run({
      toolName: 'edit_file',
      args: { path: 'add.mjs', oldText: 'return a - b;', newText: 'return a + b;' },
    });
    expect(edit.status).toBe('executed');
    // The edit really landed on disk, in the real repo.
    expect(readFileSync(repo.path('add.mjs'), 'utf8')).toContain('a + b');

    // 5. It re-runs the test and watches it pass.
    const passing = await run({
      toolName: 'run_shell',
      args: { command: '/usr/bin/env', argv: ['node', 'add.test.mjs'], cwd: '.' },
    });
    expect(passing.status).toBe('executed');
    if (passing.status === 'executed' && passing.response.ok) {
      const r = passing.response.result as { exitCode: number; stdout: string };
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('PASS');
    }

    // 6. `git diff` shows exactly the one-line fix and nothing else — no unrelated changes.
    const diff = await run({ toolName: 'git_diff', args: { path: '.' } });
    expect(diff.status).toBe('executed');
    if (diff.status === 'executed' && diff.response.ok) {
      const r = diff.response.result as { diff: string };
      expect(r.diff).toContain('-  return a - b;');
      expect(r.diff).toContain('+  return a + b;');
      expect(r.diff).not.toContain('add.test.mjs'); // the test file was untouched
    }
  });

  it('deny-by-default holds: `plan` refuses the edit before it can reach the sandbox', async () => {
    const registry = registerBuiltins(new ToolRegistry());
    const pipeline = new ToolPipeline({ registry, policy: new PolicyEngine(), client });

    // In `plan`, the edit tool is not even offered — and if a call is forced, policy makes the
    // mutation UNAVAILABLE (not merely "ask"). It never reaches the worker.
    const outcome = await pipeline.execute({
      callId: 'call_edit' as never,
      toolName: 'edit_file',
      rawArguments: { path: 'add.mjs', oldText: 'a - b', newText: 'a + b' },
      policyContext: policyContext('plan'),
      grant: GRANT,
      isolation: 'read-only',
    });

    expect(outcome.status).toBe('denied');
    // The file on disk is untouched — the deny happened before any side effect.
    expect(readFileSync(repo.path('add.mjs'), 'utf8')).toContain('a - b');
  });

  it('a malformed tool call is rejected at the schema layer, never executed', async () => {
    const registry = registerBuiltins(new ToolRegistry());
    const pipeline = new ToolPipeline({ registry, policy: new PolicyEngine(), client });

    const outcome = await pipeline.execute({
      callId: 'call_bad' as never,
      toolName: 'write_file',
      rawArguments: { path: '/etc/passwd', content: 'pwned' }, // absolute path -> schema refusal
      policyContext: policyContext('yolo'),
      grant: GRANT,
      isolation: 'workspace-write',
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.stage).toBe('schema');
  });
});
