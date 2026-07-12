import { describe, expect, it } from 'vitest';

import { provenanceOf, resolveConfig } from './resolve.ts';
import type { ConfigDoc } from './schema.ts';
import { OVERRIDE_RANK, type ConfigSource } from './sources.ts';

function src(scope: ConfigScope, config: ConfigDoc, id: string = scope): ConfigSource {
  return { id, scope, config, origin: { kind: 'file', path: `/x/${id}.json` } };
}

/** Seeded LCG — property tests must be reproducible (house convention, policy/test/helpers.ts). */
class Rng {
  #state: number;
  constructor(seed: number) {
    this.#state = seed >>> 0;
  }
  next(): number {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
    return this.#state / 0x1_0000_0000;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  bool(): boolean {
    return this.next() < 0.5;
  }
}

describe('override precedence (ordinary values)', () => {
  it('the required case: user + local-project + cli resolves to CLI, provenance says cli', () => {
    const resolved = resolveConfig([
      src('user', { reasoningEffort: 'low' }),
      src('local-project', { reasoningEffort: 'medium' }),
      src('cli', { reasoningEffort: 'high' }),
    ]);
    expect(resolved.reasoningEffort.value).toBe('high');
    expect(resolved.reasoningEffort.source.scope).toBe('cli');

    const prov = provenanceOf(resolved, 'reasoningEffort');
    expect(prov).toEqual({
      kind: 'value',
      value: 'high',
      source: resolved.reasoningEffort.source,
    });
  });

  // Table-driven across every scope combination: the highest OVERRIDE_RANK present must win.
  const combos: ConfigScope[][] = [
    ['user'],
    ['user', 'shared-project'],
    ['shared-project', 'local-project'],
    ['user', 'env'],
    ['local-project', 'env'],
    ['env', 'cli'],
    ['user', 'shared-project', 'local-project', 'env', 'cli'],
    ['user', 'local-project', 'cli'],
  ];

  for (const setters of combos) {
    it(`winner among {${setters.join(', ')}} is the highest-precedence scope`, () => {
      const sources = setters.map((scope) => src(scope, { model: `model-${scope}` }));
      const resolved = resolveConfig(sources);
      const expected = [...setters].sort(
        (a, b) =>
          OVERRIDE_RANK[b as Exclude<ConfigScope, 'managed'>] -
          OVERRIDE_RANK[a as Exclude<ConfigScope, 'managed'>],
      )[0];
      expect(resolved.model.value).toBe(`model-${expected}`);
      expect(resolved.model.source.scope).toBe(expected);
    });
  }

  it('an unset value falls through to the builtin default, with builtin provenance', () => {
    const resolved = resolveConfig([src('user', { model: 'custom' })]);
    expect(resolved.transport.value).toBe('responses');
    expect(resolved.transport.source.scope).toBe('builtin');
  });

  it('the managed scope never wins an ordinary value (it only caps authority)', () => {
    const resolved = resolveConfig([
      src('managed', { model: 'managed-model' }),
      src('user', { model: 'user-model' }),
    ]);
    expect(resolved.model.value).toBe('user-model');
    expect(resolved.model.source.scope).toBe('user');
  });

  it('nested budget/toolOutput leaves resolve independently', () => {
    const resolved = resolveConfig([
      src('user', { budgets: { turnsPerGoal: 10 } }),
      src('cli', { budgets: { modelCallsPerTurn: 3 } }),
    ]);
    expect(resolved.budgets.turnsPerGoal.value).toBe(10);
    expect(resolved.budgets.turnsPerGoal.source.scope).toBe('user');
    expect(resolved.budgets.modelCallsPerTurn.value).toBe(3);
    expect(resolved.budgets.modelCallsPerTurn.source.scope).toBe('cli');
    // Untouched leaf keeps the frozen default (100 model calls per turn).
    expect(resolved.budgets.modelCallsPerTurn.value).toBe(3);
    expect(resolved.budgets.toolCallsPerTurn.value).toBe(1_000);
  });
});

describe('deny-first merge (security lists)', () => {
  it('a deny in a LOW scope survives even when a HIGHER scope sets other values', () => {
    const resolved = resolveConfig([
      src('user', { deny: ['exec:/bin/rm'] }),
      src('cli', { model: 'anything', network: true }),
    ]);
    expect(resolved.deny.value).toContain('exec:/bin/rm');
  });

  it('the union spans every scope and de-duplicates, keeping per-entry provenance', () => {
    const resolved = resolveConfig([
      src('managed', { deny: ['host:169.254.169.254'] }),
      src('user', { deny: ['path:~/.ssh', 'host:169.254.169.254'] }),
      src('local-project', { deny: ['path:.git'] }),
    ]);
    expect(new Set(resolved.deny.value)).toEqual(
      new Set(['host:169.254.169.254', 'path:~/.ssh', 'path:.git']),
    );
    const prov = provenanceOf(resolved, 'deny');
    expect(prov.kind).toBe('merged');
    if (prov.kind === 'merged') {
      const scopesFor = (entry: string) =>
        new Set(prov.contributions.filter((c) => c.value === entry).map((c) => c.source.scope));
      // The duplicated entry is attributed to BOTH scopes that contributed it.
      expect(scopesFor('host:169.254.169.254')).toEqual(new Set(['managed', 'user']));
    }
  });

  // Property: for any arrangement of sources, EVERY deny any source contributes appears in the
  // resolved union — a higher scope can never reduce the set of denies (defaults.md deny-first).
  it('property: the union of denies is never reduced by a higher scope [seeded]', () => {
    const scopes: ConfigScope[] = [
      'managed',
      'user',
      'shared-project',
      'local-project',
      'env',
      'cli',
    ];
    const pool = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const sources: ConfigSource[] = [];
      const expected = new Set<string>();
      const count = 1 + rng.int(scopes.length);
      for (let i = 0; i < count; i += 1) {
        const scope = rng.pick(scopes);
        const denies: string[] = [];
        const nDeny = rng.int(4);
        for (let j = 0; j < nDeny; j += 1) {
          const entry = rng.pick(pool);
          denies.push(entry);
          expected.add(entry);
        }
        // Higher scopes also set permissive ordinary values — which must NOT drop any deny.
        const config: ConfigDoc = { deny: denies, network: rng.bool(), model: `m${i}` };
        sources.push(src(scope, config, `${scope}-${i}`));
      }
      const resolved = resolveConfig(sources);
      const got = new Set(resolved.deny.value);
      for (const entry of expected) {
        expect(got.has(entry)).toBe(true);
      }
    }
  });
});

describe('managed ceiling only tightens', () => {
  it('a lower source cannot widen permissionProfile past the managed maxProfile', () => {
    const resolved = resolveConfig([
      src('managed', { maxProfile: 'ask' }),
      src('cli', { permissionProfile: 'yolo' }),
    ]);
    expect(resolved.permissionProfile.value).toBe('ask');
    expect(resolved.permissionProfile.source.scope).toBe('managed');
  });

  it('a lower source CAN tighten below the managed ceiling', () => {
    const resolved = resolveConfig([
      src('managed', { maxProfile: 'auto-accept-edits' }),
      src('user', { permissionProfile: 'plan' }),
    ]);
    expect(resolved.permissionProfile.value).toBe('plan');
    expect(resolved.permissionProfile.source.scope).toBe('user');
  });

  it('a lower source cannot widen the maxProfile ceiling itself', () => {
    const resolved = resolveConfig([
      src('managed', { maxProfile: 'ask' }),
      src('user', { maxProfile: 'yolo' }),
    ]);
    expect(resolved.maxProfile.value).toBe('ask');
    expect(resolved.maxProfile.source.scope).toBe('managed');
  });

  it('managed can force network off despite a higher scope asking for it', () => {
    const resolved = resolveConfig([
      src('managed', { networkAllowed: false }),
      src('cli', { network: true }),
    ]);
    expect(resolved.network.value).toBe(false);
    expect(resolved.network.source.scope).toBe('managed');
  });

  it('managed can only tighten isolation, not weaken it', () => {
    const resolved = resolveConfig([
      src('managed', { maxIsolation: 'read-only' }),
      src('cli', { isolation: 'disabled' }),
    ]);
    expect(resolved.isolation.value).toBe('read-only');
    expect(resolved.isolation.source.scope).toBe('managed');
  });

  it('without a managed source, authority reaches the builtin defaults', () => {
    const resolved = resolveConfig([src('cli', { permissionProfile: 'yolo', network: true })]);
    expect(resolved.permissionProfile.value).toBe('yolo');
    expect(resolved.network.value).toBe(true);
    expect(resolved.network.source.scope).toBe('cli');
  });
});

describe('provenanceOf', () => {
  it('answers for a scalar, a nested leaf, and the deny list', () => {
    const resolved = resolveConfig([
      src('cli', { model: 'x', budgets: { childDepth: 1 }, deny: ['a'] }),
    ]);
    expect(provenanceOf(resolved, 'model').kind).toBe('value');
    expect(provenanceOf(resolved, 'budgets.childDepth')).toMatchObject({
      kind: 'value',
      value: 1,
    });
    expect(provenanceOf(resolved, 'toolOutput.modelPreviewBytes')).toMatchObject({
      kind: 'value',
      value: 64 * 1024,
    });
    expect(provenanceOf(resolved, 'deny').kind).toBe('merged');
  });
});
