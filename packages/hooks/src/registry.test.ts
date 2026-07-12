import { describe, expect, it } from 'vitest';

import { HookOutcomes } from './outcome.ts';
import { HookRegistry, globToRegExp, type HookInvocation } from './registry.ts';

const fn = () => HookOutcomes.continue();
const handler = { kind: 'function', run: fn } as const;

function invocation(over: Partial<HookInvocation> = {}): HookInvocation {
  return {
    event: 'PreToolUse',
    data: {},
    signal: new AbortController().signal,
    ...over,
  };
}

describe('hook registry (HK-02)', () => {
  it('runs handlers in (priority, registration) order', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'c', event: 'PreToolUse', handler, priority: 5 });
    registry.register({ id: 'a', event: 'PreToolUse', handler, priority: 0 });
    registry.register({ id: 'b', event: 'PreToolUse', handler, priority: 0 });
    const ids = registry.matching(invocation()).map((r) => r.id);
    // a and b share priority 0 -> registration order; c is later by priority.
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('rejects duplicate ids and unknown events', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'x', event: 'Stop', handler });
    expect(() => registry.register({ id: 'x', event: 'Stop', handler })).toThrow(/duplicate/);
    expect(() => registry.register({ id: 'y', event: 'Nope' as never, handler })).toThrow(
      /unknown hook event/,
    );
  });

  it('filters by tool name glob', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'bash', event: 'PreToolUse', handler, matcher: { toolName: 'Bash' } });
    registry.register({ id: 'mcp', event: 'PreToolUse', handler, matcher: { toolName: 'mcp__*' } });
    expect(registry.matching(invocation({ toolName: 'Bash' })).map((r) => r.id)).toEqual(['bash']);
    expect(
      registry.matching(invocation({ toolName: 'mcp__github__issue' })).map((r) => r.id),
    ).toEqual(['mcp']);
    expect(registry.matching(invocation({ toolName: 'Read' }))).toHaveLength(0);
  });

  it('filters by path glob against any of the action paths', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'ts', event: 'PreToolUse', handler, matcher: { pathGlob: '**/*.ts' } });
    expect(registry.matching(invocation({ paths: ['/repo/src/a.ts'] })).map((r) => r.id)).toEqual([
      'ts',
    ]);
    expect(registry.matching(invocation({ paths: ['/repo/README.md'] }))).toHaveLength(0);
  });

  it('filters by a condition predicate', () => {
    const registry = new HookRegistry();
    registry.register({
      id: 'writes',
      event: 'PreToolUse',
      handler,
      matcher: { condition: (inv) => inv.currentDecision === 'ask' },
    });
    expect(registry.matching(invocation({ currentDecision: 'ask' }))).toHaveLength(1);
    expect(registry.matching(invocation({ currentDecision: 'allow' }))).toHaveLength(0);
  });

  it('unregister removes a binding', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'x', event: 'Stop', handler });
    expect(registry.unregister('x')).toBe(true);
    expect(registry.unregister('x')).toBe(false);
    expect(registry.forEvent('Stop')).toHaveLength(0);
  });
});

describe('globToRegExp', () => {
  it('* stays within a segment, ** crosses segments', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('dir/a.ts')).toBe(false);
    expect(globToRegExp('**/*.ts').test('dir/deep/a.ts')).toBe(true);
    expect(globToRegExp('mcp__*').test('mcp__x__y')).toBe(true);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
  });
});
