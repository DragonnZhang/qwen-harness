import { describe, expect, it } from 'vitest';

import { HookOutcomes, parseHookOutcome } from './outcome.ts';

describe('hook outcome parsing (HK-03)', () => {
  it('parses each outcome variant', () => {
    expect(parseHookOutcome({ type: 'continue' })).toEqual({
      ok: true,
      outcome: { type: 'continue' },
    });
    expect(parseHookOutcome({ type: 'block', reason: { code: 'x', message: 'no' } }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'context', text: 'hi' }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'modify', toolInput: { a: 1 } }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'deny' }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'ask' }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'allow' }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'passthrough' }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'stop', reason: 'done' }).ok).toBe(true);
    expect(parseHookOutcome({ type: 'annotate', annotations: [{ key: 'k', value: 'v' }] }).ok).toBe(
      true,
    );
  });

  it('coerces a bare-string reason into a typed reason', () => {
    const parsed = parseHookOutcome({ type: 'block', reason: 'too risky' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.outcome.type === 'block') {
      expect(parsed.outcome.reason).toEqual({ code: 'hook', message: 'too risky' });
    }
  });

  it('supplies a default reason when a permission outcome omits it', () => {
    const parsed = parseHookOutcome({ type: 'deny' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.outcome.type === 'deny') {
      expect(parsed.outcome.reason).toEqual({ code: 'hook', message: '' });
    }
  });

  it('rejects an unknown outcome type as a visible error, not a silent continue', () => {
    const parsed = parseHookOutcome({ type: 'sudo-make-me-a-sandwich' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('type');
  });

  it('rejects a non-object', () => {
    expect(parseHookOutcome('allow').ok).toBe(false);
    expect(parseHookOutcome(null).ok).toBe(false);
    expect(parseHookOutcome(42).ok).toBe(false);
  });

  it('constructors produce parseable shapes', () => {
    for (const outcome of [
      HookOutcomes.continue(),
      HookOutcomes.block('c', 'm'),
      HookOutcomes.context('t'),
      HookOutcomes.modify({ x: 1 }),
      HookOutcomes.allow(),
      HookOutcomes.passthrough(),
      HookOutcomes.deny('c', 'm'),
      HookOutcomes.ask('c', 'm'),
      HookOutcomes.stop('c', 'm'),
      HookOutcomes.annotate([{ key: 'k', value: 'v' }]),
    ]) {
      expect(parseHookOutcome(outcome).ok).toBe(true);
    }
  });
});
