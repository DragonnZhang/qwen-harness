import { describe, expect, it } from 'vitest';

import {
  MANAGED_IS_IMMUTABLE,
  outranks,
  resolvePrecedence,
  SKILL_SOURCES,
  SOURCE_PRECEDENCE,
  type SkillSource,
} from './sources.ts';

const candidate = (name: string, source: SkillSource, tiebreak = `/${source}/${name}`) => ({
  name,
  source,
  tiebreak,
});

describe('the precedence table is DATA (IN-03)', () => {
  it('covers every one of the ten sources the matrix names, with no duplicate ranks', () => {
    expect([...SKILL_SOURCES].sort()).toEqual(
      [
        'additional-directory',
        'bundled',
        'conditional',
        'dynamic',
        'legacy-command',
        'managed',
        'mcp',
        'plugin',
        'project',
        'user',
      ].sort(),
    );
    const ranks = SKILL_SOURCES.map((s) => SOURCE_PRECEDENCE[s]);
    expect(new Set(ranks).size).toBe(SKILL_SOURCES.length);
  });

  it('orders the sources exactly as documented', () => {
    const byRank = [...SKILL_SOURCES].sort((a, b) => SOURCE_PRECEDENCE[b] - SOURCE_PRECEDENCE[a]);
    expect(byRank).toEqual([
      'managed',
      'dynamic',
      'project',
      'additional-directory',
      'user',
      'conditional',
      'plugin',
      'mcp',
      'legacy-command',
      'bundled',
    ]);
  });

  it('managed is the immutable ceiling: nothing outranks it', () => {
    expect(MANAGED_IS_IMMUTABLE).toBe(true);
    for (const source of SKILL_SOURCES) {
      expect(outranks(source, 'managed')).toBe(false);
    }
    // ...and managed outranks every other source.
    for (const source of SKILL_SOURCES.filter((s) => s !== 'managed')) {
      expect(outranks('managed', source)).toBe(true);
    }
  });

  it('a third-party source can never shadow a first-party one', () => {
    for (const thirdParty of ['plugin', 'mcp'] as SkillSource[]) {
      for (const firstParty of [
        'managed',
        'project',
        'user',
        'additional-directory',
      ] as SkillSource[]) {
        expect(outranks(thirdParty, firstParty)).toBe(false);
      }
    }
  });
});

describe('resolvePrecedence', () => {
  it('a project skill shadows a bundled one of the same name; the loss is reported', () => {
    const result = resolvePrecedence([
      candidate('review', 'bundled'),
      candidate('review', 'project'),
    ]);
    expect(result.effective.map((c) => c.source)).toEqual(['project']);
    expect(result.shadowed).toHaveLength(1);
    expect(result.shadowed[0]?.loser.source).toBe('bundled');
    expect(result.shadowed[0]?.reason).toBe('lower-precedence');
  });

  it('a managed skill cannot be replaced by ANY other source (defaults.md: managed cannot be relaxed)', () => {
    for (const source of SKILL_SOURCES.filter((s) => s !== 'managed')) {
      const result = resolvePrecedence([
        candidate('deploy', source),
        candidate('deploy', 'managed'),
      ]);
      expect(result.effective).toHaveLength(1);
      expect(result.effective[0]?.source).toBe('managed');
      expect(result.shadowed[0]?.reason).toBe('managed-is-immutable');
    }
  });

  it('is deterministic regardless of the order candidates are discovered in', () => {
    const all = [
      candidate('x', 'plugin'),
      candidate('x', 'user'),
      candidate('x', 'mcp'),
      candidate('y', 'bundled'),
    ];
    const forward = resolvePrecedence(all);
    const backward = resolvePrecedence([...all].reverse());
    expect(forward.effective).toEqual(backward.effective);
    expect(forward.shadowed.map((s) => s.loser.source).sort()).toEqual(
      backward.shadowed.map((s) => s.loser.source).sort(),
    );
  });

  it('breaks a same-source tie by the stable tiebreak key, and says so', () => {
    const result = resolvePrecedence([
      candidate('dup', 'user', '/b/dup/SKILL.md'),
      candidate('dup', 'user', '/a/dup/SKILL.md'),
    ]);
    expect(result.effective[0]?.tiebreak).toBe('/a/dup/SKILL.md');
    expect(result.shadowed[0]?.reason).toBe('tiebreak');
  });
});
