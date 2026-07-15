import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NO_MANAGED_RESTRICTIONS, type Authority } from '@qwen-harness/policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SkillRegistry, discoverSkills, nodeSkillFileSystem } from '../../src/index.ts';

/**
 * Skill INVOCATION semantics through the real registry (IN-05).
 *
 * A skill discovered from disk is invoked, and the prepared invocation's PLAN is inspected: its tools
 * are narrowed to the intersection of the skill's `allowed-tools` and the caller's held tools (a tool
 * the caller lacks is DENIED, never granted), its context mode is what the frontmatter declared, and a
 * per-skill loaded-content token budget is set. This exercises the real discover → register → invoke
 * path against real files, not a hand-built descriptor.
 */

const PARENT: Authority = {
  profile: 'ask',
  isolation: 'workspace-write',
  networkAllowed: true,
  workspaceRoots: ['/repo'],
  rules: [],
  grants: [],
  maxChildDepth: 2,
};

function writeSkill(baseDir: string, name: string, extraFrontmatter: string): void {
  const d = join(baseDir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'SKILL.md'),
    `---\nname: ${name}\ndescription: the ${name} skill\n${extraFrontmatter}\n---\nBody of ${name}.\n`,
  );
}

describe('skill invocation plan (IN-05)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-skillinvoke-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function registryFor(): SkillRegistry {
    const fs = nodeSkillFileSystem();
    const registry = new SkillRegistry({ fs, clock: { now: () => 0 } });
    registry.registerAll(
      discoverSkills({ fs, sources: [{ source: 'project', dir, layout: 'skill-dirs' }] }).skills,
    );
    return registry;
  }

  it('narrows tools to allowed-tools ∩ held, denies a tool the caller lacks, in a forked context', () => {
    // Declares two tools the caller holds and one it does not; forked context.
    writeSkill(dir, 'analyze', 'allowed-tools: [read_file, grep, run_shell]\ncontext: forked');
    const { plan } = registryFor().invoke({
      name: 'analyze',
      invoker: 'model',
      parentTools: ['read_file', 'grep', 'write_file'], // holds read_file+grep, NOT run_shell
      parentAuthority: PARENT,
      managed: NO_MANAGED_RESTRICTIONS,
    });

    // Effective tools = declared ∩ held (sorted); the unheld tool is denied, never granted.
    expect(plan.tools).toEqual(['grep', 'read_file']);
    expect(plan.denied).toEqual(['run_shell']);
    expect(plan.mode).toBe('forked');
    // A per-skill loaded-content token budget is set.
    expect(plan.budgetTokens).toBeGreaterThan(0);
  });

  it('an inline skill with no allowed-tools inherits the caller tools unchanged', () => {
    writeSkill(dir, 'note', 'context: inline');
    const { plan } = registryFor().invoke({
      name: 'note',
      invoker: 'model',
      parentTools: ['read_file', 'grep'],
      parentAuthority: PARENT,
      managed: NO_MANAGED_RESTRICTIONS,
    });
    expect(plan.mode).toBe('inline');
    expect(plan.tools).toEqual(['grep', 'read_file']); // inherited, sorted
    expect(plan.denied).toEqual([]);
  });
});
