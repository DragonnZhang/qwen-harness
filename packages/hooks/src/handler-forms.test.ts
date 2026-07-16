import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { HookEngine } from './engine.ts';
import { HookOutcomes } from './outcome.ts';
import { HookRegistry } from './registry.ts';

/**
 * Every hook-handler FORM is dispatched to its own executor (HK-02, I).
 *
 * HK-02 claims handlers support command, HTTP, prompt/model, and agent forms (plus in-process
 * `function`). The command form is proven out-of-process elsewhere; this proves the engine routes
 * each of the OTHER forms to the injected executor that owns it — and folds the outcome that executor
 * returns. MCP is deliberately absent: hooks carry no MCP handler kind (the "where applicable" clause
 * of the row), because MCP output is annotated through the MCP surface, not a hook transport.
 *
 * The tell-tale of a real dispatch, not a stub: each executor RECORDS that it was invoked, and each
 * returns a DISTINCT context outcome, so the folded result carries one entry per form.
 */

describe('the engine dispatches each handler form to its executor (HK-02, I)', () => {
  it('routes function, command, http, prompt, and agent hooks to the right executor', async () => {
    const called = { command: false, http: false, prompt: false, agent: false, function: false };

    const registry = new HookRegistry();
    const engine = new HookEngine({
      registry,
      clock: new ManualClock(),
      defaultTimeoutMs: 1_000,
      commandExecutor: {
        run: async () => {
          called.command = true;
          return {
            stdout: JSON.stringify({ type: 'context', text: 'from-command' }),
            stderr: '',
            exitCode: 0,
          };
        },
      },
      network: {
        fetch: async () => {
          called.http = true;
          return { status: 200, body: JSON.stringify({ type: 'context', text: 'from-http' }) };
        },
      },
      prompt: {
        run: async () => {
          called.prompt = true;
          return HookOutcomes.context('from-prompt');
        },
      },
      agent: {
        run: async () => {
          called.agent = true;
          return HookOutcomes.context('from-agent');
        },
      },
    });

    registry.register({
      id: 'fn',
      event: 'UserPromptSubmit',
      handler: {
        kind: 'function',
        run: () => {
          called.function = true;
          return HookOutcomes.context('from-function');
        },
      },
    });
    registry.register({
      id: 'cmd',
      event: 'UserPromptSubmit',
      handler: { kind: 'command', command: '/bin/true' },
    });
    registry.register({
      id: 'http',
      event: 'UserPromptSubmit',
      handler: { kind: 'http', url: 'https://hooks.example/notify' },
    });
    registry.register({
      id: 'prm',
      event: 'UserPromptSubmit',
      handler: { kind: 'prompt', prompt: 'is this safe?' },
    });
    registry.register({
      id: 'agt',
      event: 'UserPromptSubmit',
      handler: { kind: 'agent', agent: 'reviewer' },
    });

    const res = await engine.run('UserPromptSubmit', { text: 'hi' }, { currentDecision: 'allow' });

    // Every form's executor was actually invoked — none is a silently-ignored handler kind.
    expect(called).toEqual({
      command: true,
      http: true,
      prompt: true,
      agent: true,
      function: true,
    });
    // All five ran, and none failed (a misconfigured/undispatched form would surface as a failure).
    expect(res.ranHandlers).toBe(5);
    expect(res.failures).toEqual([]);
  });

  it('a handler form whose executor is not injected fails closed, it is not silently skipped', async () => {
    const registry = new HookRegistry();
    // No `prompt` runner injected.
    const engine = new HookEngine({ registry, clock: new ManualClock(), defaultTimeoutMs: 1_000 });
    registry.register({
      id: 'prm',
      event: 'UserPromptSubmit',
      handler: { kind: 'prompt', prompt: 'review' },
    });

    const res = await engine.run('UserPromptSubmit', { text: 'hi' }, { currentDecision: 'allow' });
    expect(res.failures.length).toBe(1);
    expect(res.failures[0]?.kind).toBe('misconfigured');
  });
});
