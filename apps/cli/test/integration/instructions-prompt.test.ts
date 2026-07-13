import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import type { ModelProvider, ModelRequest, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composePrompt, loadGuidance } from '../../src/instructions.ts';
import { authorityForProfile } from '../../src/policy-from-config.ts';
import { createHarnessRuntime } from '../../src/wiring.ts';

/**
 * Repository instructions and prompt composition (IN-06, IN-07, IN-08, IN-10).
 *
 * Before this work `main.ts` passed the engine one hard-coded string literal as the entire system
 * prompt, and `AGENTS.md` was never read by anything. These tests hold the replacement to the
 * standard the matrix sets:
 *
 *   IN-06  layered discovery with provenance and deterministic precedence
 *   IN-07  a prompt COMPOSED from sections built from real runtime state, not one mutable string
 *   IN-08  deterministic cache keys, with a stable prefix a dynamic change does not invalidate
 *   IN-10  the instruction text is on EVERY provider request — not just the first
 */

/** Captures the `ModelRequest` of every round, which is where IN-10 is actually observable. */
function capturingProvider(rounds: ProviderStreamEvent[][]): {
  provider: ModelProvider;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    requests,
    provider: {
      capabilities: freezeCapabilities({
        textStreaming: true,
        reasoningSummary: true,
        reasoningEffortGranularity: 'graded',
        incrementalToolArgs: false,
        background: false,
        structuredOutput: false,
        toolStream: false,
      }),
      async *stream(request: ModelRequest) {
        requests.push(request);
        const round = rounds[i++] ?? [{ type: 'done', finishReason: 'stop' }];
        for (const e of round) yield e;
      },
    },
  };
}

describe('repository instructions are discovered, ranked, and composed', () => {
  let workspace: string;
  let home: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-instr-'));
    home = mkdtempSync(join(tmpdir(), 'qh-home-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('finds nothing, and says so, when a repository has no AGENTS.md', () => {
    const guidance = loadGuidance({ workspaceRoot: workspace, homeDir: home });
    expect(guidance.sources).toEqual([]);
  });

  it('ranks user < repo-root < nested, most specific last (IN-06)', () => {
    mkdirSync(join(home, '.qwen-harness'), { recursive: true });
    writeFileSync(join(home, '.qwen-harness', 'AGENTS.md'), 'USER SCOPE GUIDANCE');

    writeFileSync(join(workspace, 'AGENTS.md'), 'REPO ROOT GUIDANCE');

    mkdirSync(join(workspace, 'src', 'api'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'api', 'AGENTS.md'), 'NESTED API GUIDANCE');

    const guidance = loadGuidance({ workspaceRoot: workspace, homeDir: home });
    const scopes = guidance.sources.map((s) => s.scope);

    // Ascending precedence: the most specific instruction is LAST, so it wins.
    expect(scopes).toEqual(['user', 'repo-root', 'nested']);
    expect(guidance.loaded.rootText).toContain('USER SCOPE GUIDANCE');
    expect(guidance.loaded.rootText).toContain('REPO ROOT GUIDANCE');

    // The nested one is path-SCOPED: it is not always-on. It joins the prompt only once a file under
    // its directory has been touched (defaults.md's reattachment rule), so a fresh turn that has not
    // looked at `src/api` does not carry `src/api`'s instructions.
    expect(guidance.loaded.rootText).not.toContain('NESTED API GUIDANCE');
  });

  it('a path-scoped instruction attaches once a matching path is accessed (IN-06)', () => {
    mkdirSync(join(workspace, 'src', 'api'), { recursive: true });
    writeFileSync(join(workspace, 'AGENTS.md'), 'ROOT');
    writeFileSync(join(workspace, 'src', 'api', 'AGENTS.md'), 'NESTED API GUIDANCE');

    const guidance = loadGuidance({ workspaceRoot: workspace, homeDir: home });
    const inputs = {
      agentName: 'qwen-harness',
      model: 'qwen3.7-max',
      profile: 'ask' as const,
      workspaceRoot: workspace,
      repo: workspace,
      toolNames: ['read_file'],
      threadId: 'thr_000001',
      turn: 1,
      memory: null,
      mcp: null,
    };

    const cold = composePrompt(guidance, inputs, []);
    expect(cold.instructions).not.toContain('NESTED API GUIDANCE');

    const warm = composePrompt(guidance, inputs, [join(workspace, 'src', 'api', 'handler.ts')]);
    expect(warm.instructions).toContain('NESTED API GUIDANCE');
  });
});

describe('the system prompt is composed from sections with cache keys (IN-07, IN-08)', () => {
  let workspace: string;
  let home: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-prompt-'));
    home = mkdtempSync(join(tmpdir(), 'qh-home-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const base = (over: Record<string, unknown> = {}) => ({
    agentName: 'qwen-harness',
    model: 'qwen3.7-max',
    profile: 'ask' as const,
    workspaceRoot: workspace,
    repo: workspace,
    toolNames: ['read_file', 'run_shell'],
    threadId: 'thr_000001',
    turn: 1,
    memory: null,
    mcp: null,
    ...over,
  });

  it('is sections, not a string: identity/tools/workspace are stable, memory/session dynamic', () => {
    const guidance = loadGuidance({ workspaceRoot: workspace, homeDir: home });
    const { composed } = composePrompt(guidance, base() as never);

    const ids = composed.sections.map((s) => s.id);
    expect(ids).toContain('identity');
    expect(ids).toContain('tools');
    expect(ids).toContain('workspace');

    const kinds = new Map(composed.sections.map((s) => [s.id, s.kind]));
    expect(kinds.get('identity')).toBe('stable');
    expect(kinds.get('tools')).toBe('stable');
    expect(kinds.get('workspace')).toBe('stable');
    expect(kinds.get('session')).toBe('dynamic');

    // Every section has a deterministic cache key.
    for (const section of composed.sections) {
      expect(composed.cacheKeys[section.id]).toBeTypeOf('string');
    }
  });

  it('the same state produces the same keys; a DYNAMIC change leaves the stable prefix intact', () => {
    const guidance = loadGuidance({ workspaceRoot: workspace, homeDir: home });

    const a = composePrompt(guidance, base() as never).composed;
    const b = composePrompt(guidance, base() as never).composed;
    // Determinism: identical state, identical keys. Otherwise a cache would never hit.
    expect(b.cacheKeys).toEqual(a.cacheKeys);

    // Turn 2 of the same session: only the DYNAMIC `session` section changed.
    const next = composePrompt(guidance, base({ turn: 2 }) as never).composed;
    expect(next.cacheKeys['session']).not.toBe(a.cacheKeys['session']);
    // ...and the cacheable prefix is byte-identical, which is the entire point of the split (IN-08).
    expect(next.stablePrefix).toBe(a.stablePrefix);
    expect(next.cacheKeys['identity']).toBe(a.cacheKeys['identity']);
    expect(next.cacheKeys['tools']).toBe(a.cacheKeys['tools']);
  });

  it('a STABLE change (a new tool) does invalidate the prefix', () => {
    const guidance = loadGuidance({ workspaceRoot: workspace, homeDir: home });
    const a = composePrompt(guidance, base() as never).composed;
    const withMcp = composePrompt(
      guidance,
      base({ toolNames: ['read_file', 'run_shell', 'mcp__fs__read'] }) as never,
    ).composed;

    expect(withMcp.cacheKeys['tools']).not.toBe(a.cacheKeys['tools']);
    expect(withMcp.stablePrefix).not.toBe(a.stablePrefix);
  });
});

describe('instruction text is sent on EVERY provider request (IN-10)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-in10-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('a two-round turn puts the identical instructions on both requests', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'ALWAYS RUN THE TESTS BEFORE YOU CLAIM SUCCESS');

    const guidance = loadGuidance({ workspaceRoot: workspace, homeDir: workspace });
    const { instructions } = composePrompt(
      guidance,
      {
        agentName: 'qwen-harness',
        model: 'qwen3.7-max',
        profile: 'ask',
        workspaceRoot: workspace,
        repo: workspace,
        toolNames: ['read_file'],
        threadId: 'thr_000001',
        turn: 1,
        memory: null,
        mcp: null,
      },
      [],
    );

    // The composed prompt really does carry the repository's guidance.
    expect(instructions).toContain('ALWAYS RUN THE TESTS BEFORE YOU CLAIM SUCCESS');

    const readArgs = { path: 'AGENTS.md' };
    const { provider, requests } = capturingProvider([
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_1',
          callId: 'call_1',
          toolName: 'read_file',
          argumentsJson: JSON.stringify(readArgs),
          arguments: readArgs,
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-done', itemId: 'it_2', text: 'done' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const store = new EventStore({
      path: join(workspace, 'sessions.sqlite'),
      clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
      ids: new SequentialIds(),
    });

    try {
      const runtime = createHarnessRuntime({
        workspaceRoot: workspace,
        authority: authorityForProfile('yolo'),
        model: 'qwen3.7-max',
        instructions,
        homeDir: workspace,
        clock: { now: () => Date.now() },
        ids: new SequentialIds(),
        store,
        provider,
      });

      const threadId = 'thr_000001' as ThreadId;
      store.append({
        threadId,
        correlationId: 'cor_000001' as CorrelationId,
        permissionProfile: 'yolo',
        actor: { kind: 'user', id: 'act_user01' as never },
        payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
      });

      const result = await runtime.runTurn({
        threadId,
        correlationId: 'cor_000002' as CorrelationId,
        userText: 'read the instructions',
      });
      expect(result.state).toBe('completed');

      // TWO rounds really happened — otherwise "sent on every request" is a claim about one request.
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.instructions).toBe(instructions);
        expect(request.instructions).toContain('ALWAYS RUN THE TESTS BEFORE YOU CLAIM SUCCESS');
      }
    } finally {
      store.close();
    }
  });
});
