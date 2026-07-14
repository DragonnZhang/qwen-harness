import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type CliDeps } from '../../src/index.ts';

/**
 * The skills CLI catalog (IN-01 two-level loading, IN-04 strict frontmatter validation).
 *
 * `skills` builds the catalog from FRONTMATTER only — it never reads a skill body (that happens on
 * invocation, proven end to end in `evals/e2e/skills.test.ts`). This drives the real `main(['skills'])`
 * and proves: a valid skill is listed by its metadata, and a skill whose frontmatter fails validation
 * is REPORTED as an error rather than silently dropped (which would leave the user wondering why their
 * skill "does nothing").
 */

function writeSkill(cwd: string, dir: string, frontmatter: string, body: string): void {
  const d = join(cwd, '.qwen-harness', 'skills', dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

describe('skills CLI catalog (IN-01, IN-04)', () => {
  let cwd: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-skills-'));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const deps = (argv: string[]): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });

  it('catalogs a valid skill by frontmatter and REPORTS an invalid one (never silently dropped)', async () => {
    writeSkill(
      cwd,
      'review-pr',
      'name: review-pr\ndescription: Review a pull request against the repo conventions',
      'Check the diff against AGENTS.md, then run the tests.',
    );
    // Missing the required `description` — its frontmatter must fail validation.
    writeSkill(cwd, 'broken', 'name: broken', 'a skill with no description');

    expect(await main(deps(['skills', '--json']))).toBe(0);
    const parsed = JSON.parse(out.at(-1)!) as {
      skills: { name: string; source: string }[];
      errors: { name: string; message: string }[];
    };
    // The valid skill is catalogued by its metadata.
    expect(parsed.skills.map((s) => s.name)).toContain('review-pr');
    // The invalid skill is NOT in the catalog…
    expect(parsed.skills.map((s) => s.name)).not.toContain('broken');
    // …but it IS reported as an error, naming the offending skill.
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(parsed.errors)).toContain('broken');
  });

  it('reports no skills (with guidance) when none are present', async () => {
    expect(await main(deps(['skills']))).toBe(0);
    expect(out.join('\n')).toMatch(/no skills found/i);
  });
});
