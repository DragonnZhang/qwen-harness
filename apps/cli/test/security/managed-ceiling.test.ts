import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { SequentialIds } from '@qwen-harness/testkit';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';

import { createHarnessRuntime, loadRunAuthority } from '../../src/index.ts';

/**
 * The managed ceiling must bind a RUN, not just a report.
 *
 * This suite exists because of a real, shipped hole: `createHarnessRuntime` built its
 * `PolicyContext` with `NO_MANAGED_RESTRICTIONS` and `rules: []`, hard-coded. Every unit test of
 * the policy engine passed — the ceiling logic was correct — but nothing ever handed the engine the
 * administrator's policy. `/etc/qwen-harness/managed.json` shaped what `doctor` printed and had no
 * effect whatsoever on what the model was permitted to do. An operator would have been shown a
 * ceiling that did not exist.
 *
 * The lesson generalizes: a security control that is implemented, tested, and never WIRED is worth
 * exactly nothing, and a component test cannot see that. So these tests assert on the authority a
 * run is actually constructed with, loaded from a real managed file on disk.
 */

let dir: string;
let managedPath: string;
let home: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-ceiling-'));
  home = join(dir, 'home');
  project = join(dir, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  managedPath = join(dir, 'managed.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManaged(doc: unknown): void {
  writeFileSync(managedPath, JSON.stringify(doc), 'utf8');
}

function writeProjectConfig(doc: unknown): void {
  const configDir = join(project, '.qwen-harness');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(doc), 'utf8');
}

function authority(cli: Record<string, unknown> = {}) {
  return loadRunAuthority({
    projectRoot: project,
    homeDir: home,
    env: {},
    managedPath,
    cli,
  });
}

describe('the managed ceiling binds the run, not just the report', () => {
  it('clamps a requested yolo down to the administrator maxProfile', () => {
    writeManaged({ maxProfile: 'ask' });

    const run = authority({ permissionProfile: 'yolo' });

    // The REQUEST was yolo. The authority the run executes under is not.
    expect(run.profile).toBe('ask');
    expect(run.managedPolicy.maxProfile).toBe('ask');
  });

  it('a clamped profile cannot reach `disabled` isolation — yolo cannot turn the sandbox off', () => {
    writeManaged({ maxProfile: 'ask', maxIsolation: 'workspace-write' });

    const run = authority({ permissionProfile: 'yolo', isolation: 'disabled' });

    expect(run.profile).toBe('ask');
    expect(run.isolation).not.toBe('disabled');
    expect(run.managedPolicy.maxIsolation).toBe('workspace-write');
  });

  it('denies network everywhere when the administrator forbids it, even under yolo', () => {
    writeManaged({ networkAllowed: false });

    const run = authority({ permissionProfile: 'yolo', network: true });

    expect(run.networkAllowed).toBe(false);
    expect(run.managedPolicy.networkAllowed).toBe(false);
  });

  it('a project config in a hostile repository cannot RELAX the managed ceiling', () => {
    // The malicious-repo threat model: the repository is under the attacker's control.
    writeManaged({ maxProfile: 'plan' });
    writeProjectConfig({ maxProfile: 'yolo', permissionProfile: 'yolo', networkAllowed: true });

    const run = authority();

    expect(run.profile).toBe('plan');
    expect(run.managedPolicy.maxProfile).toBe('plan');
  });

  it('a project config CAN tighten the ceiling further (tighten-only, both directions checked)', () => {
    writeManaged({ maxProfile: 'yolo' });
    writeProjectConfig({ maxProfile: 'plan' });

    const run = authority({ permissionProfile: 'yolo' });

    expect(run.managedPolicy.maxProfile).toBe('plan');
    expect(run.profile).toBe('plan');
  });

  it('config deny entries become MANAGED rules, so no grant or approval can lift them', () => {
    writeManaged({ deny: ['**/.ssh/**', '**/secrets.env'] });

    const run = authority({ permissionProfile: 'yolo' });

    // They must land in the managed policy, NOT in ordinary rules: an ordinary rule can be
    // outranked, a managed rule cannot.
    const denyRule = run.managedPolicy.rules.find((r) => r.id === 'config.deny');
    expect(denyRule).toBeDefined();
    expect(denyRule?.effect).toBe('deny');
    expect(denyRule?.match.paths).toContain('**/.ssh/**');
    expect(denyRule?.match.paths).toContain('**/secrets.env');
    expect(run.rules).toEqual([]);
  });

  it('a deny contributed by a LOWER scope survives a higher scope that omits it', () => {
    writeManaged({ deny: ['**/.ssh/**'] });
    writeProjectConfig({ deny: ['**/build/**'] });

    const run = authority();

    const paths = run.managedPolicy.rules.find((r) => r.id === 'config.deny')?.match.paths ?? [];
    // Deny is a UNION. The project could not drop the administrator's entry by not repeating it.
    expect(paths).toContain('**/.ssh/**');
    expect(paths).toContain('**/build/**');
  });

  it('with no managed file at all, the ceiling is permissive — but it is still explicitly stated', () => {
    const run = authority({ permissionProfile: 'yolo' });

    expect(run.profile).toBe('yolo');
    // The point: even the unrestricted case travels as a real ManagedPolicy value. There is no
    // code path that reaches the policy engine without one.
    expect(run.managedPolicy).toBeDefined();
    expect(run.managedPolicy.maxChildDepth).toBeGreaterThan(0);
  });
});

/**
 * The decisive test. Everything above proves the BRIDGE (config → authority). This proves the
 * ceiling reaches the place that matters: a real turn, real policy engine, real sandboxed worker.
 *
 * The model is scripted to attempt a file write while the caller asks for `yolo` — the profile that
 * would normally auto-approve it. The administrator's managed policy pins `maxProfile: plan`
 * (read-only). The write must not land on disk. If `createHarnessRuntime` ever stops threading the
 * ceiling through again, THIS is the test that goes red — a policy-engine unit test would not.
 */
describe('a clamped ceiling denies a real tool call in a real turn', () => {
  it('yolo asked to write; managed policy said plan; nothing was written', async () => {
    const client = new ToolWorkerClient();
    if (!client.detect().available) {
      throw new Error(
        'the sandbox is unavailable on this host, so this security claim cannot be verified; ' +
          'refusing to report a pass (see docs/execution/checkpoints/00 for prerequisites)',
      );
    }

    const workspace = join(dir, 'ws');
    mkdirSync(workspace, { recursive: true });
    const target = join(workspace, 'victim.txt');
    writeFileSync(target, 'original', 'utf8');

    writeManaged({ maxProfile: 'plan' });
    const run = loadRunAuthority({
      projectRoot: project,
      homeDir: home,
      env: {},
      managedPath,
      cli: { permissionProfile: 'yolo' },
    });
    expect(run.profile).toBe('plan'); // clamped before we even start

    const ids = new SequentialIds();
    const store = new EventStore({
      path: join(dir, 'sessions.sqlite'),
      clock: { now: () => 1_700_000_000_000, sleep: () => Promise.resolve() },
      ids,
    });

    const rounds: ProviderStreamEvent[][] = [
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_call_write001',
          callId: 'call_write001',
          toolName: 'write_file',
          argumentsJson: JSON.stringify({ path: 'victim.txt', content: 'OWNED' }),
          arguments: { path: 'victim.txt', content: 'OWNED' },
        } as ProviderStreamEvent,
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-done', itemId: 'm', text: 'I could not write.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ];
    let round = 0;
    const scripted: ModelProvider = {
      capabilities: freezeCapabilities({
        textStreaming: true,
        reasoningSummary: true,
        reasoningEffortGranularity: 'graded',
        incrementalToolArgs: false,
        background: false,
        structuredOutput: false,
        toolStream: false,
      }),
      async *stream() {
        const r = rounds[round++] ?? [{ type: 'done', finishReason: 'stop' }];
        for (const e of r) yield e;
      },
    };

    const threadId = ids.next('thr') as ThreadId;
    const correlationId = ids.next('cor') as CorrelationId;
    store.append({
      threadId,
      correlationId,
      permissionProfile: run.profile,
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
    });

    const runtime = createHarnessRuntime({
      workspaceRoot: workspace,
      authority: run,
      model: 'scripted',
      instructions: 'try to write',
      homeDir: home,
      clock: { now: () => 1_700_000_000_000 },
      ids,
      store,
      provider: scripted as never,
      client,
    });

    await runtime.runTurn({ threadId, correlationId, userText: 'write to victim.txt' });

    // THE assertion. The administrator's ceiling held against a yolo request, in a real run.
    expect(readFileSync(target, 'utf8')).toBe('original');
    store.close();
  }, 120_000);

  /**
   * The control. Without this, the test above is worthless: if the scripted tool call never
   * actually reached the worker, `victim.txt` would read "original" for the boring reason that
   * nothing ever tried to write it, and the suite would report a security property it had not
   * tested. Same script, same runtime, no managed ceiling — the write MUST land. That is what makes
   * the denial above meaningful.
   */
  it('control: with no ceiling, that very same write DOES land (so the denial above is real)', async () => {
    const client = new ToolWorkerClient();
    if (!client.detect().available) {
      throw new Error('the sandbox is unavailable on this host; refusing to report a pass');
    }

    const workspace = join(dir, 'ws-control');
    mkdirSync(workspace, { recursive: true });
    const target = join(workspace, 'victim.txt');
    writeFileSync(target, 'original', 'utf8');

    // NO managed.json is written here — that is the only difference from the test above.
    const run = loadRunAuthority({
      projectRoot: project,
      homeDir: home,
      env: {},
      managedPath,
      cli: { permissionProfile: 'yolo' },
    });
    expect(run.profile).toBe('yolo');

    const ids = new SequentialIds();
    const store = new EventStore({
      path: join(dir, 'control.sqlite'),
      clock: { now: () => 1_700_000_000_000, sleep: () => Promise.resolve() },
      ids,
    });

    const rounds: ProviderStreamEvent[][] = [
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_call_write001',
          callId: 'call_write001',
          toolName: 'write_file',
          argumentsJson: JSON.stringify({ path: 'victim.txt', content: 'OWNED' }),
          arguments: { path: 'victim.txt', content: 'OWNED' },
        } as ProviderStreamEvent,
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-done', itemId: 'm', text: 'Wrote it.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ];
    let round = 0;
    const scripted: ModelProvider = {
      capabilities: freezeCapabilities({
        textStreaming: true,
        reasoningSummary: true,
        reasoningEffortGranularity: 'graded',
        incrementalToolArgs: false,
        background: false,
        structuredOutput: false,
        toolStream: false,
      }),
      async *stream() {
        const r = rounds[round++] ?? [{ type: 'done', finishReason: 'stop' }];
        for (const e of r) yield e;
      },
    };

    const threadId = ids.next('thr') as ThreadId;
    const correlationId = ids.next('cor') as CorrelationId;
    store.append({
      threadId,
      correlationId,
      permissionProfile: run.profile,
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
    });

    const runtime = createHarnessRuntime({
      workspaceRoot: workspace,
      authority: run,
      model: 'scripted',
      instructions: 'write it',
      homeDir: home,
      clock: { now: () => 1_700_000_000_000 },
      ids,
      store,
      provider: scripted as never,
      client,
    });

    await runtime.runTurn({ threadId, correlationId, userText: 'write to victim.txt' });

    // The scripted call really does reach the worker and really does write.
    expect(readFileSync(target, 'utf8')).toBe('OWNED');
    store.close();
  }, 120_000);
});
