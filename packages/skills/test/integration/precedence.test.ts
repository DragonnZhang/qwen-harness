import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SkillRegistry,
  discoverSkills,
  nodeSkillFileSystem,
  type SkillSourceDir,
} from '../../src/index.ts';

/**
 * Skill SOURCE PRECEDENCE across real directories (IN-03).
 *
 * Two skills may legitimately share a name across sources; the higher-precedence source wins and the
 * lower is shadowed (never silently both). A MANAGED name is reserved — nothing can shadow it. This
 * discovers same-named skills from real on-disk source directories and drives the real registry, so
 * the precedence table (managed > project > user > …) is exercised end to end, not asserted on a
 * hand-built list.
 */

function writeSkill(baseDir: string, name: string, body: string): void {
  const d = join(baseDir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'SKILL.md'),
    `---\nname: ${name}\ndescription: the ${name} skill\n---\n${body}\n`,
  );
}

describe('skill source precedence (IN-03)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qh-skillprec-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function discover(sources: SkillSourceDir[]) {
    const fs = nodeSkillFileSystem();
    const registry = new SkillRegistry({ fs, clock: { now: () => 0 } });
    const discovery = discoverSkills({ fs, sources });
    return { discovery, ...registry.registerAll(discovery.skills) };
  }

  it('a higher-precedence source shadows a same-named lower one (project over user)', () => {
    const projectDir = join(root, 'project');
    const userDir = join(root, 'user');
    writeSkill(projectDir, 'deploy', 'PROJECT body');
    writeSkill(userDir, 'deploy', 'USER body');

    const { registered, shadowed } = discover([
      { source: 'project', dir: projectDir, layout: 'skill-dirs' },
      { source: 'user', dir: userDir, layout: 'skill-dirs' },
    ]);

    // Exactly one `deploy` survives — the project one; the user one is shadowed, not silently both.
    const deploy = registered.filter((s) => s.name === 'deploy');
    expect(deploy).toHaveLength(1);
    expect(deploy[0]?.source).toBe('project');
    expect(shadowed.some((s) => s.loser.source === 'user')).toBe(true);
  });

  it('a managed skill name is RESERVED — a project skill cannot shadow it', () => {
    const managedDir = join(root, 'managed');
    const projectDir = join(root, 'project');
    writeSkill(managedDir, 'deploy', 'MANAGED body');
    writeSkill(projectDir, 'deploy', 'PROJECT body');

    const { registered } = discover([
      { source: 'managed', dir: managedDir, layout: 'skill-dirs' },
      { source: 'project', dir: projectDir, layout: 'skill-dirs' },
    ]);

    const deploy = registered.filter((s) => s.name === 'deploy');
    expect(deploy).toHaveLength(1);
    expect(deploy[0]?.source).toBe('managed'); // managed wins; the project skill is shadowed
  });

  it('distinct names from different sources all register (precedence only resolves collisions)', () => {
    const projectDir = join(root, 'project');
    const userDir = join(root, 'user');
    writeSkill(projectDir, 'build', 'B');
    writeSkill(userDir, 'lint', 'L');

    const { registered } = discover([
      { source: 'project', dir: projectDir, layout: 'skill-dirs' },
      { source: 'user', dir: userDir, layout: 'skill-dirs' },
    ]);
    expect(registered.map((s) => s.name).sort()).toEqual(['build', 'lint']);
  });
});
