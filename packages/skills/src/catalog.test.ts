import { ManualClock } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { buildCatalog } from './catalog.ts';
import type { SkillDescriptor } from './descriptor.ts';
import { validateSkillFrontmatter } from './frontmatter.ts';
import type { SkillSource } from './sources.ts';

function descriptor(
  name: string,
  source: SkillSource,
  description = `The ${name} skill.`,
): SkillDescriptor {
  return {
    name,
    source,
    frontmatter: validateSkillFrontmatter({ name, description }, `${name}:SKILL.md`),
    // A distinctive body: the catalog must never contain a single byte of it.
    origin: { kind: 'memory', body: 'BODY-CONTENT-MUST-NOT-APPEAR' },
    provider: null,
  };
}

const clock = new ManualClock(1_000);

describe('catalog assembly (IN-01)', () => {
  it('is deterministic: precedence first, then name', () => {
    const catalog = buildCatalog(
      [
        descriptor('zulu', 'bundled'),
        descriptor('alpha', 'bundled'),
        descriptor('mike', 'managed'),
        descriptor('bravo', 'project'),
      ],
      { clock },
    );
    expect(catalog.entries.map((e) => e.name)).toEqual(['mike', 'bravo', 'alpha', 'zulu']);
    expect(
      buildCatalog(
        [...catalog.entries].map((e) => descriptor(e.name, e.source)),
        { clock },
      ).text,
    ).toBe(catalog.text);
  });

  it('exposes metadata only — no body, no path', () => {
    const catalog = buildCatalog([descriptor('alpha', 'project')], { clock });
    expect(catalog.text).toContain('alpha');
    expect(catalog.text).toContain('The alpha skill.');
    expect(catalog.text).not.toContain('BODY-CONTENT-MUST-NOT-APPEAR');
    expect(JSON.stringify(catalog.entries)).not.toContain('BODY-CONTENT-MUST-NOT-APPEAR');
  });
});

describe('the catalog token budget is enforced (IN-05)', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    descriptor(`skill-${String(i).padStart(2, '0')}`, 'plugin', 'x'.repeat(200)),
  );

  it('truncates deterministically and emits an explicit signal naming every omission', () => {
    const catalog = buildCatalog(many, { clock, budgetTokens: 200 });
    expect(catalog.truncated).toBe(true);
    expect(catalog.tokens).toBeLessThanOrEqual(200);
    expect(catalog.signal).not.toBeNull();
    expect(catalog.signal?.type).toBe('skill-catalog-truncated');
    expect(catalog.signal?.at).toBe(1_000);
    expect(catalog.signal?.includedCount).toBe(catalog.entries.length);
    // Every skill is accounted for: included + omitted == discovered. Nothing vanishes silently.
    expect(catalog.entries.length + catalog.omitted.length).toBe(many.length);
    for (const omission of catalog.omitted) expect(omission.reason).toBe('catalog-token-budget');

    // Deterministic: same input, same truncation.
    const again = buildCatalog([...many].reverse(), { clock, budgetTokens: 200 });
    expect(again.entries.map((e) => e.name)).toEqual(catalog.entries.map((e) => e.name));
  });

  it('a flood of plugin skills can never evict a managed one', () => {
    const catalog = buildCatalog([...many, descriptor('deploy', 'managed')], {
      clock,
      budgetTokens: 200,
    });
    expect(catalog.entries[0]?.name).toBe('deploy');
    expect(catalog.omitted.map((o) => o.name)).not.toContain('deploy');
  });

  it('no signal when everything fits', () => {
    const catalog = buildCatalog([descriptor('alpha', 'user')], { clock, budgetTokens: 4_000 });
    expect(catalog.truncated).toBe(false);
    expect(catalog.signal).toBeNull();
    expect(catalog.omitted).toEqual([]);
  });
});
