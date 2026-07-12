import { ManualClock } from '@qwen-harness/protocol';
import type { DecisionOutcome } from '@qwen-harness/policy';
import { describe, expect, it } from 'vitest';

import { HookEngine } from './engine.ts';
import { HookOutcomes, type HookOutcome } from './outcome.ts';
import { HookRegistry, type FunctionHandler } from './registry.ts';

function fnHandler(run: FunctionHandler['run']): FunctionHandler {
  return { kind: 'function', run };
}

function makeEngine(clock = new ManualClock()): { engine: HookEngine; registry: HookRegistry } {
  const registry = new HookRegistry();
  const engine = new HookEngine({ registry, clock, defaultTimeoutMs: 1_000 });
  return { engine, registry };
}

/** Register a function hook that always returns `outcome`. */
function always(registry: HookRegistry, id: string, event: string, outcome: HookOutcome): void {
  registry.register({ id, event: event as never, handler: fnHandler(() => outcome) });
}

describe('hook engine fold (HK-03, HK-04)', () => {
  it('with no hooks, returns the input decision unchanged', async () => {
    const { engine } = makeEngine();
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    expect(res.decision).toBe('ask');
    expect(res.decisionChanged).toBe(false);
    expect(res.ranHandlers).toBe(0);
  });

  it('the most restrictive permission opinion wins', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'a', 'PreToolUse', HookOutcomes.ask('a', 'ask'));
    always(registry, 'b', 'PreToolUse', HookOutcomes.deny('b', 'deny'));
    always(registry, 'c', 'PreToolUse', HookOutcomes.continue());
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'allow' });
    expect(res.decision).toBe('deny');
    expect(res.decisionChanged).toBe(true);
  });

  it('a block short-circuits: later hooks do not run', async () => {
    const { engine, registry } = makeEngine();
    let ranSecond = false;
    registry.register({
      id: 'blocker',
      event: 'PreToolUse',
      handler: fnHandler(() => HookOutcomes.block('policy', 'no')),
    });
    registry.register({
      id: 'after',
      event: 'PreToolUse',
      handler: fnHandler(() => {
        ranSecond = true;
        return HookOutcomes.continue();
      }),
    });
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    expect(res.blocked).toBe(true);
    expect(res.blockReason?.hookId).toBe('blocker');
    expect(res.decision).toBe('deny'); // a blocked action is denied
    expect(ranSecond).toBe(false);
    expect(res.ranHandlers).toBe(1);
    expect(res.audit.at(-1)?.outcome).toBe('skipped');
  });

  it('modify returns a proposal flagged for revalidation and never applied', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'm', 'PreToolUse', HookOutcomes.modify({ command: 'ls -a' }));
    const res = await engine.run(
      'PreToolUse',
      { toolName: 'Bash', toolInput: { command: 'ls' } },
      { currentDecision: 'ask' },
    );
    expect(res.modifiedInput).toBeDefined();
    expect(res.modifiedInput?.needsRevalidation).toBe(true);
    expect(res.modifiedInput?.hookId).toBe('m');
    expect(res.modifiedInput?.toolInput).toEqual({ command: 'ls -a' });
    // Decision is unaffected by a modify; the caller must re-run policy on the proposal.
    expect(res.decision).toBe('ask');
  });

  it('context output is sanitized and attributed', async () => {
    const { engine, registry } = makeEngine();
    // An ANSI/OSC injection: clear-screen + a fake OSC-52 clipboard write.
    const payload = '[2Jinjected]52;c;ZXZpbA==';
    always(registry, 'ctx', 'UserPromptSubmit', HookOutcomes.context(payload));
    const res = await engine.run('UserPromptSubmit', {}, {});
    expect(res.injectedContext).toHaveLength(1);
    const injected = res.injectedContext[0]!;
    expect(injected.hookId).toBe('ctx');
    expect(injected.sanitized).toBe(true);
    expect(injected.text).not.toContain('');
    expect(injected.text).toContain('injected');
  });

  it('annotate output is attributed', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'ann', 'PostToolUse', HookOutcomes.annotate([{ key: 'risk', value: 'low' }]));
    const res = await engine.run('PostToolUse', { toolName: 'mcp__x__y' }, {});
    expect(res.annotations[0]?.hookId).toBe('ann');
    expect(res.annotations[0]?.annotations).toEqual([{ key: 'risk', value: 'low' }]);
  });
});

describe('no-elevation invariant (HK-04)', () => {
  it('a hook allow cannot flip a policy deny to allow', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'evil', 'PreToolUse', HookOutcomes.allow('please'));
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'deny' });
    expect(res.decision).toBe('deny');
    expect(res.ignoredElevations).toHaveLength(1);
    expect(res.ignoredElevations[0]?.hookId).toBe('evil');
    expect(res.ignoredElevations[0]?.requested).toBe('allow');
  });

  it('a hook allow cannot flip a policy ask to allow', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'evil', 'PreToolUse', HookOutcomes.allow());
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    expect(res.decision).toBe('ask');
    expect(res.ignoredElevations).toHaveLength(1);
  });

  it('a hook passthrough cannot loosen either', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'evil', 'PreToolUse', HookOutcomes.passthrough());
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    expect(res.decision).toBe('ask');
    expect(res.ignoredElevations[0]?.requested).toBe('passthrough');
  });

  it('property: the folded decision is never looser than the input, for any hook opinion', async () => {
    const rank: Record<DecisionOutcome, number> = { passthrough: 0, allow: 0, ask: 1, deny: 2 };
    const bases: DecisionOutcome[] = ['passthrough', 'allow', 'ask', 'deny'];
    const opinions: HookOutcome[] = [
      HookOutcomes.allow(),
      HookOutcomes.passthrough(),
      HookOutcomes.ask('c', 'm'),
      HookOutcomes.deny('c', 'm'),
      HookOutcomes.continue(),
      HookOutcomes.context('x'),
    ];
    for (const base of bases) {
      for (const opinion of opinions) {
        const { engine, registry } = makeEngine();
        always(registry, 'h', 'PreToolUse', opinion);
        const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: base });
        expect(rank[res.decision]).toBeGreaterThanOrEqual(rank[base]);
      }
    }
  });
});

describe('failures are visible (HK-05)', () => {
  it('a throwing hook is surfaced, not swallowed, and does not allow', async () => {
    const { engine, registry } = makeEngine();
    registry.register({
      id: 'boom',
      event: 'PreToolUse',
      handler: fnHandler(() => {
        throw new Error('kaboom');
      }),
    });
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]?.hookId).toBe('boom');
    expect(res.failures[0]?.kind).toBe('exception');
    // The failure did not silently allow: the decision is still as restrictive as it was.
    expect(res.decision).toBe('ask');
  });

  it('a hook that exceeds its deadline is cancelled and surfaced as a timeout', async () => {
    const clock = new ManualClock();
    const { engine, registry } = makeEngine(clock);
    registry.register({
      id: 'slow',
      event: 'PreToolUse',
      handler: fnHandler(
        (inv) =>
          new Promise<HookOutcome>((resolve) => {
            // Only resolves if cancelled — proving the engine's deadline is what ends the wait.
            inv.signal.addEventListener('abort', () => resolve(HookOutcomes.continue()), {
              once: true,
            });
          }),
      ),
    });
    const promise = engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    clock.advance(1_000);
    const res = await promise;
    expect(res.failures[0]?.kind).toBe('timeout');
    expect(res.decision).toBe('ask');
  });
});

describe('stop re-entry protection (HK-05)', () => {
  it('a Stop hook that returns stop is refused, not re-entered', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 's', 'Stop', HookOutcomes.stop('again', 'loop'));
    const res = await engine.run('Stop', {}, {});
    expect(res.stopReentryRefused).toBe(true);
    expect(res.stopped).toBe(false);
  });

  it('a Stop hook that recursively calls run(Stop) gets a refusal', async () => {
    const { engine, registry } = makeEngine();
    let inner: Awaited<ReturnType<HookEngine['run']>> | undefined;
    registry.register({
      id: 'reentrant',
      event: 'Stop',
      handler: fnHandler(async () => {
        inner = await engine.run('Stop', {}, {});
        return HookOutcomes.continue();
      }),
    });
    const outer = await engine.run('Stop', {}, {});
    expect(inner?.stopReentryRefused).toBe(true);
    expect(inner?.ranHandlers).toBe(0);
    expect(outer.stopReentryRefused).toBe(false);
  });

  it('a post-tool hook can stop continuation without corrupting the durable result', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'p', 'PostToolUse', HookOutcomes.stop('enough', 'stop here'));
    const res = await engine.run('PostToolUse', { toolName: 'Bash' }, {});
    expect(res.stopped).toBe(true);
    expect(res.resultDurable).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.stopReason?.hookId).toBe('p');
  });

  it('a block on a post-tool event becomes a continuation stop, not a block of the completed action', async () => {
    const { engine, registry } = makeEngine();
    always(registry, 'p', 'PostToolUse', HookOutcomes.block('late', 'too late to block'));
    const res = await engine.run('PostToolUse', { toolName: 'Bash' }, {});
    expect(res.blocked).toBe(false);
    expect(res.stopped).toBe(true);
    expect(res.resultDurable).toBe(true);
  });
});
