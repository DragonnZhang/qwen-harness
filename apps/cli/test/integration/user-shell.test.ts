import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelProvider } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import type { ManagedPolicy } from '@qwen-harness/policy';
import type { CorrelationId, Item, ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { CANARY_API_KEY, ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authorityForProfile, createHarnessRuntime, type RunAuthority } from '../../src/index.ts';

/**
 * UI-04 (I + S) — the `!` DIRECT USER SHELL ACTION, through the REAL pipeline, REAL policy engine,
 * and REAL sandboxed tool worker. Only the model is a stub — and the whole point is that it is NEVER
 * called: a `!` command is a user action, not a model turn.
 *
 * Proven here:
 *   - it runs a real command in the sandbox and captures its output;
 *   - it appends a durable `user-shell` AUDIT item attributed to the USER actor;
 *   - it starts NO model turn (the provider is never streamed, no `turn-started` is logged);
 *   - MANAGED DENY: an administrator rule forbidding shell stops the command — it never executes,
 *     and the denial is still audited;
 *   - REDACTION: a secret in the output is scrubbed from the persisted audit item.
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;
const NOW = 1_700_000_000_000;

const client = new ToolWorkerClient();

/** A provider that records whether it was ever streamed. For a `!` action it must stay untouched. */
function spyProvider(): ModelProvider & { called: boolean } {
  const state = {
    called: false,
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: false,
      reasoningEffortGranularity: 'none',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream() {
      state.called = true;
      throw new Error('a ! action must never call the model');
    },
  };
  return state;
}

function userShellItems(store: EventStore): Item[] {
  return store
    .readThread(THREAD)
    .map((e) => e.payload)
    .filter((p) => p.type === 'item-appended' && p.item.type === 'user-shell')
    .map((p) => (p.type === 'item-appended' ? p.item : null))
    .filter((i): i is Item => i !== null);
}

describe('! direct user shell action (real pipeline, real sandbox, real store)', () => {
  let workspace: string;
  let store: EventStore;
  let ids: SequentialIds;
  let clock: ManualClock;

  const runtimeWith = (authority: RunAuthority, provider: ModelProvider) =>
    createHarnessRuntime({
      workspaceRoot: workspace,
      authority,
      model: 'scripted',
      instructions: 'unused',
      homeDir: '/home/nonexistent',
      clock,
      ids,
      store,
      provider,
      client,
    });

  const freshStore = (secrets: (string | undefined)[] = []): EventStore => {
    const s = new EventStore({ path: ':memory:', clock, ids, secrets });
    s.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
    });
    return s;
  };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-usershell-'));
    ids = new SequentialIds();
    clock = new ManualClock(NOW);
    store = freshStore();
  });

  afterEach(() => {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('the sandbox is available', () => {
    expect(client.detect().available, client.detect().detail).toBe(true);
  });

  it('runs a real command, audits a user-shell item, and starts NO model turn', async () => {
    const provider = spyProvider();
    const outcome = await runtimeWith(
      authorityForProfile('auto-accept-edits'),
      provider,
    ).runUserShell({
      threadId: THREAD,
      correlationId: CORR,
      command: 'echo qwen-shell-marker',
    });

    expect(outcome).toEqual({ status: 'executed', exitCode: 0, truncated: false });

    // The audit item: attributed to the user, carrying the command and the real captured output.
    const items = userShellItems(store);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.type === 'user-shell' ? item.command : '').toBe('echo qwen-shell-marker');
    expect(item?.type === 'user-shell' ? item.output : '').toContain('qwen-shell-marker');
    expect(item?.type === 'user-shell' ? item.exitCode : -1).toBe(0);
    const appended = store
      .readThread(THREAD)
      .find((e) => e.payload.type === 'item-appended' && e.payload.item.type === 'user-shell');
    expect(appended?.actor.kind).toBe('user');

    // NO model turn happened.
    expect(provider.called).toBe(false);
    expect(store.readThread(THREAD).some((e) => e.payload.type === 'turn-started')).toBe(false);
  });

  it('SECURITY — a managed shell-deny stops the command: it never runs, but is still audited', async () => {
    const base = authorityForProfile('auto-accept-edits');
    const managedPolicy: ManagedPolicy = {
      ...base.managedPolicy,
      rules: [
        ...base.managedPolicy.rules,
        {
          id: 'test.deny-shell',
          effect: 'deny',
          match: { kinds: ['shell'] },
          reason: 'the administrator forbids direct shell',
        },
      ],
    };
    const denied: RunAuthority = { ...base, managedPolicy };

    const provider = spyProvider();
    const outcome = await runtimeWith(denied, provider).runUserShell({
      threadId: THREAD,
      correlationId: CORR,
      command: 'touch should-not-exist.txt',
    });

    expect(outcome.status).toBe('denied');
    // The command NEVER ran — the file was not created.
    expect(existsSync(join(workspace, 'should-not-exist.txt'))).toBe(false);
    // …and the denial is still on the audit trail as a user-shell item.
    const items = userShellItems(store);
    expect(items).toHaveLength(1);
    expect(items[0]?.type === 'user-shell' ? items[0].output : '').toContain('denied');
    expect(provider.called).toBe(false);
  });

  it('SECURITY — a secret in the command output is redacted in the audit item', async () => {
    store.close();
    store = freshStore([CANARY_API_KEY]); // the store scrubs this exact value on write

    const outcome = await runtimeWith(
      authorityForProfile('auto-accept-edits'),
      spyProvider(),
    ).runUserShell({
      threadId: THREAD,
      correlationId: CORR,
      command: `echo ${CANARY_API_KEY}`,
    });

    expect(outcome.status).toBe('executed');
    const items = userShellItems(store);
    const output = items[0]?.type === 'user-shell' ? items[0].output : '';
    // The literal secret never survives into the durable audit record.
    expect(output).not.toContain(CANARY_API_KEY);
    expect(output).toContain('[REDACTED]');
  });
});
