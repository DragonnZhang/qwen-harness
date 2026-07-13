import {
  NO_MANAGED_RESTRICTIONS,
  RECOMMENDED_MANAGED_POLICY,
  type Authority,
  type ManagedPolicy,
} from '@qwen-harness/policy';
import { describe, expect, it } from 'vitest';

import type { SkillDescriptor } from './descriptor.ts';
import { SkillInvocationError } from './errors.ts';
import { assertPlanNeverBroadens, planSkillExecution } from './execution.ts';
import { validateSkillFrontmatter } from './frontmatter.ts';

function skill(fm: Record<string, unknown>): SkillDescriptor {
  const frontmatter = validateSkillFrontmatter(
    { name: 's', description: 'd', ...fm },
    'test:SKILL.md',
  );
  return {
    name: frontmatter.name,
    source: 'project',
    frontmatter,
    origin: { kind: 'memory', body: 'body' },
    provider: null,
  };
}

function parent(overrides: Partial<Authority> = {}): Authority {
  return {
    profile: 'ask',
    isolation: 'workspace-write',
    networkAllowed: true,
    workspaceRoots: ['/repo'],
    rules: [],
    grants: [],
    maxChildDepth: 2,
    ...overrides,
  };
}

const HELD = ['read_file', 'write_file', 'grep'];

function plan(
  fm: Record<string, unknown>,
  authority = parent(),
  managed: ManagedPolicy = NO_MANAGED_RESTRICTIONS,
) {
  return planSkillExecution({
    descriptor: skill(fm),
    parentTools: HELD,
    parentAuthority: authority,
    managed,
    budgetTokens: 5_000,
  });
}

describe('inline skills (IN-05)', () => {
  it('run in the parent context, append their result, and inherit permission unchanged', () => {
    const result = plan({});
    expect(result).toMatchObject({
      mode: 'inline',
      context: 'parent-context',
      result: 'appended-to-parent',
      permission: 'inherited-unchanged',
    });
    expect(result.authority).toEqual(parent());
    expect(result.tools).toEqual([...HELD].sort());
  });

  it('narrow tools when they declare allowed-tools', () => {
    const result = plan({ 'allowed-tools': ['read_file'] });
    expect(result.tools).toEqual(['read_file']);
  });
});

describe('forked skills (IN-05)', () => {
  it('run in a fresh context, return only a summary, and intersect authority with the parent', () => {
    const result = plan({ context: 'forked' });
    expect(result).toMatchObject({
      mode: 'forked',
      context: 'fresh-context',
      result: 'summary-to-parent',
      permission: 'intersected-with-parent',
    });
    // A fork consumes a level of child depth: the budget shrinks, it never grows.
    expect(result.authority.maxChildDepth).toBe(1);
    assertPlanNeverBroadens(result, HELD, parent());
  });

  it('CANNOT broaden authority: a declared tool the parent lacks is denied, never granted', () => {
    const result = plan({ context: 'forked', 'allowed-tools': ['read_file', 'root_shell'] });
    expect(result.tools).toEqual(['read_file']);
    expect(result.denied).toEqual(['root_shell']);
    assertPlanNeverBroadens(result, HELD, parent());
  });

  it('cannot escape a managed ceiling: profile and isolation are still capped', () => {
    const managed: ManagedPolicy = {
      ...RECOMMENDED_MANAGED_POLICY,
      maxProfile: 'plan',
      maxIsolation: 'read-only',
      networkAllowed: false,
    };
    const result = plan({ context: 'forked' }, parent({ profile: 'yolo' }), managed);
    expect(result.authority.profile).toBe('plan');
    expect(result.authority.isolation).toBe('read-only');
    expect(result.authority.networkAllowed).toBe(false);
  });

  it('a parent with no child-depth budget cannot fork — and is NOT silently downgraded to inline', () => {
    let thrown: unknown;
    try {
      plan({ context: 'forked' }, parent({ maxChildDepth: 0 }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SkillInvocationError);
    expect((thrown as SkillInvocationError).reason).toBe('fork-depth-exhausted');
  });

  it('never gains network the parent does not hold', () => {
    const result = plan({ context: 'forked' }, parent({ networkAllowed: false }));
    expect(result.authority.networkAllowed).toBe(false);
    assertPlanNeverBroadens(result, HELD, parent({ networkAllowed: false }));
  });
});

describe('assertPlanNeverBroadens is a real backstop', () => {
  it('throws if a plan ever contains a tool the caller does not hold', () => {
    const result = plan({});
    const tampered = { ...result, tools: [...result.tools, 'root_shell'] };
    expect(() => assertPlanNeverBroadens(tampered, HELD, parent())).toThrow(/never broaden/);
  });
});
