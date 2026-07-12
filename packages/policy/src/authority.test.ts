/**
 * Authority intersection: a child NEVER receives more than its parent.
 *
 * The property test generates random requested/parent/managed triples — including deliberately
 * greedy requests ("I want yolo, no isolation, network, and these grants I invented") — and
 * asserts that the result is at most the parent's authority on every axis. That is invariant 3 of
 * the threat model, and it is the one that stops a subagent, a Cron job, or a teammate from
 * laundering authority it was never given.
 */

import { describe, expect, it } from 'vitest';

import {
  authorityViolations,
  defaultAuthority,
  intersect,
  isAtMost,
  type Authority,
} from './authority.ts';
import type { Grant } from './grants.ts';
import {
  NO_MANAGED_RESTRICTIONS,
  RECOMMENDED_MANAGED_POLICY,
  intersectManaged,
  type ManagedPolicy,
} from './managed.ts';
import type { PolicyRule } from './rules.ts';
import { NOW, Rng, WORKSPACE, grant } from '../test/helpers.ts';

const PROFILES = ['plan', 'ask', 'auto-accept-edits', 'yolo'] as const;
const ISOLATIONS = ['read-only', 'workspace-write', 'disabled'] as const;

const allowRule = (id: string): PolicyRule => ({
  id,
  scope: 'user',
  effect: 'allow',
  match: { kinds: ['shell'], commandLines: ['npm *'] },
  reason: id,
});

const denyRule = (id: string): PolicyRule => ({
  id,
  scope: 'project',
  effect: 'deny',
  match: { kinds: ['shell'], commandLines: ['rm *'] },
  reason: id,
});

describe('intersect', () => {
  const parent: Authority = {
    profile: 'auto-accept-edits',
    isolation: 'workspace-write',
    networkAllowed: false,
    workspaceRoots: [WORKSPACE],
    rules: [allowRule('r-allow'), denyRule('r-deny')],
    grants: [grant({ id: 'g-parent', scope: 'session', actionDigest: 'a'.repeat(64) })],
    maxChildDepth: 2,
  };

  it('a child cannot escalate its profile', () => {
    const child = intersect(
      { ...parent, profile: 'yolo' },
      parent,
      NO_MANAGED_RESTRICTIONS,
    );
    expect(child.profile).toBe('auto-accept-edits');
    expect(isAtMost(child, parent)).toBe(true);
  });

  it('a child cannot weaken its isolation', () => {
    const child = intersect({ ...parent, isolation: 'disabled' }, parent, NO_MANAGED_RESTRICTIONS);
    expect(child.isolation).toBe('workspace-write');
  });

  it('a child cannot obtain network the parent does not have', () => {
    const child = intersect(
      { ...parent, networkAllowed: true },
      parent,
      NO_MANAGED_RESTRICTIONS,
    );
    expect(child.networkAllowed).toBe(false);
  });

  it('a child cannot invent a grant', () => {
    const forged: Grant = grant({
      id: 'g-forged',
      scope: 'session',
      actionDigest: 'b'.repeat(64),
    });
    const child = intersect(
      { ...parent, grants: [...parent.grants, forged] },
      parent,
      NO_MANAGED_RESTRICTIONS,
    );
    expect(child.grants.map((g) => g.id)).toEqual(['g-parent']);
  });

  it('a child cannot invent an allow-rule, but may add a deny-rule', () => {
    const child = intersect(
      {
        ...parent,
        rules: [allowRule('r-forged'), denyRule('r-extra-deny')],
      },
      parent,
      NO_MANAGED_RESTRICTIONS,
    );
    const ids = child.rules.map((r) => r.id);
    expect(ids).not.toContain('r-forged');
    expect(ids).toContain('r-extra-deny');
    expect(ids).toContain('r-deny');
  });

  it('a child cannot leave the parent workspace roots', () => {
    const child = intersect(
      { ...parent, workspaceRoots: ['/etc', `${WORKSPACE}/sub`] },
      parent,
      NO_MANAGED_RESTRICTIONS,
    );
    expect(child.workspaceRoots).toEqual([`${WORKSPACE}/sub`]);
  });

  it('child depth strictly decreases', () => {
    const child = intersect({ ...parent, maxChildDepth: 99 }, parent, NO_MANAGED_RESTRICTIONS);
    expect(child.maxChildDepth).toBe(1);
    const grandchild = intersect({ ...child, maxChildDepth: 99 }, child, NO_MANAGED_RESTRICTIONS);
    expect(grandchild.maxChildDepth).toBe(0);
    const greatGrandchild = intersect(
      { ...grandchild, maxChildDepth: 99 },
      grandchild,
      NO_MANAGED_RESTRICTIONS,
    );
    expect(greatGrandchild.maxChildDepth).toBe(0);
  });

  it('the managed ceiling caps the result even when parent and child both want more', () => {
    const managed: ManagedPolicy = {
      ...NO_MANAGED_RESTRICTIONS,
      maxProfile: 'ask',
      maxIsolation: 'read-only',
      networkAllowed: false,
      maxChildDepth: 0,
    };
    const permissiveParent: Authority = {
      ...parent,
      profile: 'yolo',
      isolation: 'disabled',
      networkAllowed: true,
    };
    const child = intersect(permissiveParent, permissiveParent, managed);
    expect(child.profile).toBe('ask');
    expect(child.isolation).toBe('read-only');
    expect(child.networkAllowed).toBe(false);
    expect(child.maxChildDepth).toBe(0);
  });

  it('PROPERTY: intersect(requested, parent, managed) is never more than parent', () => {
    const rng = new Rng(0x5eed);
    const roots = [WORKSPACE, `${WORKSPACE}/pkg`, '/etc', '/home/dev/other'];
    const ruleIds = ['r1', 'r2', 'r3', 'r4'];
    const grantIds = ['g1', 'g2', 'g3'];

    const randomAuthority = (): Authority => ({
      profile: rng.pick(PROFILES),
      isolation: rng.pick(ISOLATIONS),
      networkAllowed: rng.bool(),
      workspaceRoots: roots.filter(() => rng.bool()),
      rules: ruleIds
        .filter(() => rng.bool())
        .map((id) => (rng.bool() ? allowRule(id) : denyRule(id))),
      grants: grantIds
        .filter(() => rng.bool())
        .map((id) =>
          grant({ id, scope: 'session', actionDigest: id.repeat(64).slice(0, 64), grantedAt: NOW }),
        ),
      maxChildDepth: rng.int(4),
    });

    const managedPool: readonly ManagedPolicy[] = [
      NO_MANAGED_RESTRICTIONS,
      RECOMMENDED_MANAGED_POLICY,
      { ...NO_MANAGED_RESTRICTIONS, maxProfile: 'ask', networkAllowed: false },
      { ...NO_MANAGED_RESTRICTIONS, maxIsolation: 'read-only', maxChildDepth: 0 },
    ];

    for (let i = 0; i < 5000; i += 1) {
      const parentAuthority = randomAuthority();
      const requested = randomAuthority();
      const managed = rng.pick(managedPool);

      const child = intersect(requested, parentAuthority, managed);
      const violations = authorityViolations(child, parentAuthority);
      expect(violations, JSON.stringify({ requested, parentAuthority, child, violations })).toEqual(
        [],
      );

      // And the ceiling holds independently of the parent.
      const grandchild = intersect(randomAuthority(), child, managed);
      expect(authorityViolations(grandchild, child)).toEqual([]);
      expect(authorityViolations(grandchild, parentAuthority)).toEqual([]);
    }
  });
});

describe('defaultAuthority follows the frozen profile -> isolation mapping', () => {
  it.each([
    ['plan', 'read-only', false],
    ['ask', 'workspace-write', false],
    ['auto-accept-edits', 'workspace-write', false],
    ['yolo', 'disabled', true],
  ] as const)('%s -> %s (network %s)', (profile, isolation, network) => {
    const authority = defaultAuthority(profile, WORKSPACE, NO_MANAGED_RESTRICTIONS);
    expect(authority.isolation).toBe(isolation);
    expect(authority.networkAllowed).toBe(network);
  });

  it('the managed ceiling caps the default too', () => {
    const managed: ManagedPolicy = {
      ...NO_MANAGED_RESTRICTIONS,
      maxProfile: 'auto-accept-edits',
      maxIsolation: 'workspace-write',
    };
    const authority = defaultAuthority('yolo', WORKSPACE, managed);
    expect(authority.profile).toBe('auto-accept-edits');
    expect(authority.isolation).toBe('workspace-write');
    expect(authority.networkAllowed).toBe(false);
  });
});

describe('intersectManaged', () => {
  it('unions denies and takes the minimum of every ceiling', () => {
    const a: ManagedPolicy = {
      ...NO_MANAGED_RESTRICTIONS,
      rules: [{ id: 'a', effect: 'deny', match: { kinds: ['shell'] }, reason: 'a' }],
      maxProfile: 'auto-accept-edits',
      maxChildDepth: 2,
    };
    const b: ManagedPolicy = {
      ...RECOMMENDED_MANAGED_POLICY,
      maxProfile: 'yolo',
      maxIsolation: 'workspace-write',
      networkAllowed: false,
      maxChildDepth: 1,
    };
    const merged = intersectManaged(a, b);
    expect(merged.rules.map((r) => r.id)).toEqual([
      'a',
      'managed.credential-stores',
      'managed.cloud-metadata',
    ]);
    expect(merged.maxProfile).toBe('auto-accept-edits');
    expect(merged.maxIsolation).toBe('workspace-write');
    expect(merged.networkAllowed).toBe(false);
    expect(merged.maxChildDepth).toBe(1);
  });
});
