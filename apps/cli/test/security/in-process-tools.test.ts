import {
  PolicyEngine,
  type NormalizedAction,
  type PolicyContext,
  type PolicyRule,
} from '@qwen-harness/policy';
import type { ToolEvaluation, ToolExecutionResult, ToolExecutor } from '@qwen-harness/runtime';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, MODEL_ACTOR, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IN_PROCESS_TOOL_NAMES,
  inProcessExecutor,
  inProcessSurface,
  type BlobPort,
  type UserInteraction,
} from '../../src/in-process-tools.ts';
import { authorityForProfile } from '../../src/policy-from-config.ts';
import { compositeExecutor, type McpSurface } from '../../src/wiring.ts';

/**
 * TL-02 (S): the security boundary of the third executor.
 *
 *   (a) The in-process allowlist is FIXED and CLOSED: only `retrieve_output`/`ask_user` route to it.
 *       Any other name — including a mutating built-in or an invented one — reaches the sandbox
 *       branch, never the in-process one. The model cannot make an arbitrary name run in-process.
 *   (b) `retrieve_output` reads ONLY the blob store, by digest. It has no way to name a filesystem
 *       path: a "path-shaped" ref is just a digest lookup that misses.
 *   (c) `evaluate` is a genuine policy decision through the SHARED engine — a deny rule denies it —
 *       not a hardcoded allow that would dodge the gate.
 */

const WORKSPACE = '/workspace';
const NOW = 1_700_000_000_000;

/** A `ToolExecutor` that records every name it was asked about, so routing is observable. */
function spyExecutor(label: string, seen: string[]): ToolExecutor {
  const record = (name: string): ToolExecutor => {
    seen.push(`${label}:${name}`);
    return stub;
  };
  const result: ToolExecutionResult = {
    ok: true,
    modelText: label,
    userText: label,
    errorCategory: null,
    resultDigest: null,
    outputRef: null,
    truncated: false,
    durationMs: 0,
  };
  const evaluation: ToolEvaluation = {
    status: 'allow',
    actionDigest: '',
    description: label,
    risk: 'low',
    reason: label,
    source: label,
  };
  const stub: ToolExecutor = {
    intentFor: () => ({
      idempotencyKey: label,
      destructive: false,
      kind: 'other',
      normalizedAction: label,
    }),
    evaluate: () => Promise.resolve(evaluation),
    execute: () => Promise.resolve(result),
  };
  return {
    intentFor: (c) => record(c.toolName).intentFor(c),
    evaluate: (c) => record(c.toolName).evaluate(c),
    execute: (c) => record(c.toolName).execute(c),
  };
}

const call = (toolName: string) => ({
  callId: 'call_1',
  toolName,
  arguments: {} as Record<string, unknown>,
  argumentsJson: '{}',
  signal: new AbortController().signal,
});

describe('TL-02 (S) — the in-process allowlist is fixed and closed', () => {
  it('only retrieve_output and ask_user are in the hardcoded allowlist', () => {
    expect([...IN_PROCESS_TOOL_NAMES].sort()).toEqual(['ask_user', 'retrieve_output']);
  });

  it('compositeExecutor routes ONLY the two allowlisted names in-process; everything else falls through', async () => {
    const seen: string[] = [];
    const builtin = spyExecutor('builtin', seen);
    const mcp: McpSurface = {
      tools: [{ name: 'mcp__srv__echo', description: '', parameters: {} }],
      executor: spyExecutor('mcp', seen),
    };
    const inProcess = {
      tools: [],
      names: IN_PROCESS_TOOL_NAMES,
      executor: spyExecutor('inprocess', seen),
    };
    const composite = compositeExecutor(builtin, mcp, inProcess);

    for (const name of [
      'retrieve_output',
      'ask_user',
      'run_shell',
      'write_file',
      'edit_file',
      'evil_tool',
      'retrieve_output_evil', // a prefix, NOT the exact name — must not route in-process
      'mcp__srv__echo',
    ]) {
      await composite.execute(call(name));
    }

    // The two exact names, and ONLY those, went in-process.
    expect(seen).toContain('inprocess:retrieve_output');
    expect(seen).toContain('inprocess:ask_user');
    expect(seen.filter((s) => s.startsWith('inprocess:'))).toHaveLength(2);

    // A mutating built-in, an invented name, and a mere prefix all reached the sandbox branch.
    expect(seen).toContain('builtin:run_shell');
    expect(seen).toContain('builtin:write_file');
    expect(seen).toContain('builtin:edit_file');
    expect(seen).toContain('builtin:evil_tool');
    expect(seen).toContain('builtin:retrieve_output_evil');

    // MCP still routes by its namespace.
    expect(seen).toContain('mcp:mcp__srv__echo');
  });

  it('without an in-process surface, retrieve_output/ask_user are NOT special — they hit the sandbox', async () => {
    const seen: string[] = [];
    const builtin = spyExecutor('builtin', seen);
    const composite = compositeExecutor(builtin);
    await composite.execute(call('retrieve_output'));
    await composite.execute(call('ask_user'));
    expect(seen).toEqual(['builtin:retrieve_output', 'builtin:ask_user']);
  });
});

describe('TL-02 (S) — retrieve_output reads only the blob store, never the filesystem', () => {
  let store: EventStore;
  let clock: ManualClock;
  let ids: SequentialIds;
  const authority = authorityForProfile('ask');
  const ctx = (): PolicyContext => ({
    profile: authority.profile,
    managedPolicy: authority.managedPolicy,
    rules: authority.rules,
    grants: [],
    workspaceRoot: WORKSPACE,
    homeDir: '/home/nobody',
    now: NOW,
    actor: MODEL_ACTOR,
  });
  const stringUI: UserInteraction = { ask: () => Promise.resolve('x') };

  beforeEach(() => {
    clock = new ManualClock(NOW);
    ids = new SequentialIds();
    store = new EventStore({ path: ':memory:', clock, ids });
  });
  afterEach(() => store.close());

  it('a filesystem-path-shaped ref is just a digest lookup that misses — no file is read', async () => {
    const lookedUp: string[] = [];
    const spyBlob: BlobPort = {
      readBlob: (digest) => {
        lookedUp.push(digest);
        return store.readBlob(digest); // the ONLY thing the tool can do with a ref
      },
    };
    const exec = inProcessExecutor({
      blob: spyBlob,
      userInteraction: stringUI,
      policy: new PolicyEngine(),
      policyContext: ctx,
      workspaceRoot: WORKSPACE,
      clock: { now: () => clock.now() },
    });

    const result = await exec.execute({
      callId: 'c',
      toolName: 'retrieve_output',
      arguments: { ref: '/etc/passwd' },
      argumentsJson: '{"ref":"/etc/passwd"}',
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('not-found');
    // The path was treated purely as a digest key — the only host access performed was readBlob.
    expect(lookedUp).toEqual(['/etc/passwd']);
    expect(result.modelText).not.toContain('root:');
  });
});

describe('TL-02 (S) — evaluate is a real shared-policy decision, not a hardcoded allow', () => {
  const authority = authorityForProfile('ask');
  const stringUI: UserInteraction = { ask: () => Promise.resolve('x') };
  const denyReads: PolicyRule = {
    id: 'test-deny-reads',
    scope: 'user',
    effect: 'deny',
    match: { kinds: ['file-read'] },
    reason: 'test: reads are denied',
  };

  const makeExecutor = (rules: readonly PolicyRule[]) => {
    const policy = new PolicyEngine();
    const ctx = (): PolicyContext => ({
      profile: authority.profile,
      managedPolicy: authority.managedPolicy,
      rules,
      grants: [],
      workspaceRoot: WORKSPACE,
      homeDir: '/home/nobody',
      now: NOW,
      actor: MODEL_ACTOR,
    });
    return inProcessExecutor({
      blob: { readBlob: () => undefined },
      userInteraction: stringUI,
      policy,
      policyContext: ctx,
      workspaceRoot: WORKSPACE,
      clock: { now: () => NOW },
    });
  };

  it('with no restricting rule, evaluate allows (a workspace read)', async () => {
    const e = await makeExecutor(authority.rules).evaluate({
      callId: 'c',
      toolName: 'ask_user',
      arguments: {},
    });
    expect(e.status).toBe('allow');
  });

  it('a deny rule on file-read genuinely flips the in-process decision to deny', async () => {
    const e = await makeExecutor([...authority.rules, denyReads]).evaluate({
      callId: 'c',
      toolName: 'retrieve_output',
      arguments: { ref: 'blb_x' },
    });
    // Proof the executor consults the shared engine: the SAME evaluate now denies. A hardcoded
    // allow could never do this.
    expect(e.status).toBe('deny');
    void ({} as NormalizedAction);
  });
});

/** A tiny sanity check that the surface helper wires the fixed allowlist through unchanged. */
describe('TL-02 (S) — inProcessSurface exposes the fixed allowlist', () => {
  it('the surface names are exactly the frozen set', () => {
    const surface = inProcessSurface({
      blob: { readBlob: () => undefined },
      userInteraction: { ask: () => Promise.resolve(null) },
      policy: new PolicyEngine(),
      policyContext: () => authorityForProfile('ask') as unknown as PolicyContext,
      workspaceRoot: WORKSPACE,
      clock: { now: () => NOW },
    });
    expect(surface.names).toBe(IN_PROCESS_TOOL_NAMES);
    expect([...surface.names].sort()).toEqual(['ask_user', 'retrieve_output']);
  });
});
