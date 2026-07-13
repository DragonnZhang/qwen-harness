import { ManualClock } from '@qwen-harness/testkit';
import { NO_MANAGED_RESTRICTIONS, type Authority } from '@qwen-harness/policy';
import { describe, expect, it } from 'vitest';

import { discoverSkills, inMemorySkill } from './discovery.ts';
import {
  SkillBudgetError,
  SkillInvocationError,
  SkillNotFoundError,
  SkillScopeError,
} from './errors.ts';
import type { SkillFileSystem } from './fs.ts';
import { SkillRegistry } from './registry.ts';

/**
 * An in-memory filesystem that COUNTS what it was asked to do. The counters are the evidence for
 * IN-01: `readFile` (the body read) must be zero until a skill is actually invoked.
 */
class CountingFs implements SkillFileSystem {
  readonly headReads: string[] = [];
  readonly bodyReads: string[] = [];

  constructor(private readonly files: Map<string, string>) {}

  readHead(path: string, maxBytes: number): string | undefined {
    const text = this.files.get(path);
    if (text === undefined) return undefined;
    this.headReads.push(path);
    return text.slice(0, maxBytes);
  }

  readFile(path: string): string {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    this.bodyReads.push(path);
    return text;
  }

  realpath(path: string): string {
    if (!this.files.has(path) && !this.isDirectory(path)) throw new Error(`ENOENT ${path}`);
    return path;
  }

  isDirectory(path: string): boolean {
    for (const file of this.files.keys()) {
      if (file.startsWith(`${path}/`)) return true;
    }
    return false;
  }

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  listEntries(dir: string): readonly string[] {
    const entries = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(`${dir}/`)) continue;
      const rest = file.slice(dir.length + 1);
      const head = rest.split('/')[0];
      if (head !== undefined) entries.add(head);
    }
    return [...entries].sort();
  }
}

const BODY = 'Step 1. Inspect.\nStep 2. Fix.\nStep 3. Verify.';

function skillFile(name: string, extra = '', body = BODY): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n${extra}---\n${body}\n`;
}

function fixture(): { fs: CountingFs; registry: SkillRegistry; clock: ManualClock } {
  const files = new Map<string, string>([
    ['/proj/.qwen-harness/skills/alpha/SKILL.md', skillFile('alpha')],
    [
      '/proj/.qwen-harness/skills/beta/SKILL.md',
      skillFile('beta', 'context: forked\nallowed-tools: [read_file]\nuser-invocable: true\n'),
    ],
    ['/proj/.qwen-harness/skills/gamma/SKILL.md', skillFile('gamma', 'paths: ["src/**"]\n')],
  ]);
  const fs = new CountingFs(files);
  const clock = new ManualClock(1_700_000_000_000);
  const registry = new SkillRegistry({ fs, clock });
  const found = discoverSkills({
    fs,
    sources: [{ source: 'project', dir: '/proj/.qwen-harness/skills', layout: 'skill-dirs' }],
  });
  expect(found.errors).toEqual([]);
  registry.registerAll(found.skills);
  return { fs, registry, clock };
}

function authority(overrides: Partial<Authority> = {}): Authority {
  return {
    profile: 'ask',
    isolation: 'workspace-write',
    networkAllowed: false,
    workspaceRoots: ['/proj'],
    rules: [],
    grants: [],
    maxChildDepth: 2,
    ...overrides,
  };
}

describe('two-level loading (IN-01)', () => {
  it('discovery and catalog NEVER read a skill body from disk; invocation does', () => {
    const { fs, registry } = fixture();

    // Level one: metadata only. Three head reads, zero body reads.
    expect(fs.headReads).toHaveLength(3);
    expect(fs.bodyReads).toEqual([]);

    const catalog = registry.catalog();
    expect(catalog.entries.map((e) => e.name)).toEqual(['alpha', 'beta']); // gamma is path-scoped
    expect(fs.bodyReads).toEqual([]);

    // The catalog exposes metadata ONLY — never a filesystem path the model could then ask for.
    expect(catalog.text).not.toContain('/proj');
    expect(JSON.stringify(catalog.entries)).not.toContain('/proj');
    expect(catalog.text).not.toContain('Step 1');

    // Level two: the body, and only now.
    const loaded = registry.load('alpha');
    expect(loaded.body).toContain('Step 1');
    expect(fs.bodyReads).toEqual(['/proj/.qwen-harness/skills/alpha/SKILL.md']);
  });

  it('a second load is served from cache: no re-read, no double budget charge', () => {
    const { fs, registry } = fixture();
    const first = registry.load('alpha');
    const charged = registry.loadedTokens;
    const second = registry.load('alpha');
    expect(second).toBe(first);
    expect(fs.bodyReads).toHaveLength(1);
    expect(registry.loadedTokens).toBe(charged);
  });
});

describe('name-addressed resolution (IN-02)', () => {
  it('an unknown name is a typed error that lists what IS known', () => {
    const { registry } = fixture();
    expect(() => registry.get('nope')).toThrow(SkillNotFoundError);
    expect(registry.names()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('a resource is (name, relative path) and stays inside the root', () => {
    const files = new Map<string, string>([
      ['/skills/alpha/SKILL.md', skillFile('alpha')],
      ['/skills/alpha/scripts/run.sh', 'echo hi'],
      ['/secrets/key.pem', 'PRIVATE KEY'],
    ]);
    const fs = new CountingFs(files);
    const registry = new SkillRegistry({ fs, clock: new ManualClock(0) });
    registry.registerAll(
      discoverSkills({ fs, sources: [{ source: 'user', dir: '/skills', layout: 'skill-dirs' }] })
        .skills,
    );

    expect(registry.resource('alpha', 'scripts/run.sh').path).toBe('/skills/alpha/scripts/run.sh');
    expect(() => registry.resource('alpha', '/secrets/key.pem')).toThrow(SkillScopeError);
    expect(() => registry.resource('alpha', '../../secrets/key.pem')).toThrow(SkillScopeError);
  });

  it('an in-memory (dynamic/MCP) skill has NO root, so it can reference no local file at all', () => {
    const fs = new CountingFs(new Map());
    const registry = new SkillRegistry({ fs, clock: new ManualClock(0) });
    registry.registerAll([
      inMemorySkill({
        source: 'mcp',
        frontmatter: { name: 'remote', description: 'A skill from an MCP server.' },
        body: 'do the thing',
        provider: 'evil-server',
      }),
    ]);
    expect(registry.load('remote').body).toBe('do the thing');
    let thrown: unknown;
    try {
      registry.resource('remote', 'etc/passwd');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SkillScopeError);
    expect((thrown as SkillScopeError).rejection).toBe('no-root');
  });

  it('rejects at REGISTRATION a skill whose declared resource escapes its root', () => {
    const files = new Map<string, string>([
      ['/skills/evil/SKILL.md', skillFile('evil', 'resources: [scripts/missing.sh]\n')],
    ]);
    const fs = new CountingFs(files);
    const registry = new SkillRegistry({ fs, clock: new ManualClock(0) });
    const result = registry.registerAll(
      discoverSkills({ fs, sources: [{ source: 'user', dir: '/skills', layout: 'skill-dirs' }] })
        .skills,
    );
    expect(result.registered).toEqual([]);
    expect(result.rejected[0]?.error).toBeInstanceOf(SkillScopeError);
    expect(registry.has('evil')).toBe(false);
  });

  it('refuses to load a file that changed identity since discovery (TOCTOU)', () => {
    const files = new Map<string, string>([['/skills/alpha/SKILL.md', skillFile('alpha')]]);
    const fs = new CountingFs(files);
    const registry = new SkillRegistry({ fs, clock: new ManualClock(0) });
    registry.registerAll(
      discoverSkills({ fs, sources: [{ source: 'user', dir: '/skills', layout: 'skill-dirs' }] })
        .skills,
    );
    // The file is swapped between the scan and the load.
    files.set('/skills/alpha/SKILL.md', skillFile('omega'));
    expect(() => registry.load('alpha')).toThrow(/changed identity/);
  });
});

describe('conditional activation (IN-03)', () => {
  it('a path-scoped skill appears only once a matching path has been touched', () => {
    const { registry } = fixture();
    expect(registry.catalog().entries.map((e) => e.name)).not.toContain('gamma');
    expect(registry.catalog().omitted).toContainEqual({
      name: 'gamma',
      source: 'project',
      reason: 'condition-not-met',
    });

    const active = registry.catalog({
      workspaceRoot: '/proj',
      touchedPaths: ['/proj/src/main.ts'],
    });
    expect(active.entries.map((e) => e.name)).toContain('gamma');
  });
});

describe('budgets (IN-05)', () => {
  it('a body over the per-skill budget is truncated deterministically WITH a signal', () => {
    const files = new Map<string, string>([
      ['/skills/big/SKILL.md', skillFile('big', '', 'line\n'.repeat(2000))],
    ]);
    const fs = new CountingFs(files);
    const clock = new ManualClock(123);
    const registry = new SkillRegistry({
      fs,
      clock,
      budgets: { perSkillTokens: 100 },
    });
    registry.registerAll(
      discoverSkills({ fs, sources: [{ source: 'user', dir: '/skills', layout: 'skill-dirs' }] })
        .skills,
    );

    const loaded = registry.load('big');
    expect(loaded.truncated).toBe(true);
    expect(loaded.tokens).toBeLessThanOrEqual(100);
    // The model SEES the truncation, and so does the runtime.
    expect(loaded.body).toContain('[skill body truncated');
    expect(loaded.signal).toEqual({
      type: 'skill-content-truncated',
      at: 123,
      skill: 'big',
      budgetTokens: 100,
      originalTokens: expect.any(Number) as number,
      loadedTokens: loaded.tokens,
    });
  });

  it('the TOTAL loaded-content budget is enforced loudly, never by silently dropping content', () => {
    const files = new Map<string, string>([
      ['/skills/one/SKILL.md', skillFile('one', '', 'x'.repeat(400))],
      ['/skills/two/SKILL.md', skillFile('two', '', 'y'.repeat(400))],
    ]);
    const fs = new CountingFs(files);
    const registry = new SkillRegistry({
      fs,
      clock: new ManualClock(0),
      budgets: { perSkillTokens: 100, totalLoadedTokens: 150 },
    });
    registry.registerAll(
      discoverSkills({ fs, sources: [{ source: 'user', dir: '/skills', layout: 'skill-dirs' }] })
        .skills,
    );

    registry.load('one');
    let thrown: unknown;
    try {
      registry.load('two');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SkillBudgetError);
    expect((thrown as SkillBudgetError).limitTokens).toBe(150);
    expect(registry.usage().skills).toEqual(['one']);
  });
});

describe('invocation', () => {
  it('a user may invoke only a user-invocable skill', () => {
    const { registry } = fixture();
    expect(() =>
      registry.invoke({
        name: 'alpha',
        invoker: 'user',
        parentTools: ['read_file'],
        parentAuthority: authority(),
        managed: NO_MANAGED_RESTRICTIONS,
      }),
    ).toThrow(SkillInvocationError);

    const prepared = registry.invoke({
      name: 'beta',
      invoker: 'user',
      parentTools: ['read_file', 'write_file'],
      parentAuthority: authority(),
      managed: NO_MANAGED_RESTRICTIONS,
    });
    expect(prepared.plan.mode).toBe('forked');
    expect(prepared.plan.tools).toEqual(['read_file']);
    expect(prepared.content).toContain('Step 1');
  });

  it('the model may select a skill the user cannot type', () => {
    const { registry } = fixture();
    const prepared = registry.invoke({
      name: 'alpha',
      invoker: 'model',
      parentTools: ['read_file'],
      parentAuthority: authority(),
      managed: NO_MANAGED_RESTRICTIONS,
    });
    expect(prepared.plan.mode).toBe('inline');
  });

  it('resolves a user command to its skill', () => {
    const { registry } = fixture();
    expect(registry.resolveCommand('beta')?.name).toBe('beta');
    expect(registry.resolveCommand('alpha')).toBeUndefined();
  });

  it('a refused invocation never reads the skill body from disk', () => {
    const { fs, registry } = fixture();
    expect(() =>
      registry.invoke({
        name: 'alpha',
        invoker: 'user',
        parentTools: [],
        parentAuthority: authority(),
        managed: NO_MANAGED_RESTRICTIONS,
      }),
    ).toThrow(SkillInvocationError);
    expect(fs.bodyReads).toEqual([]);
  });
});
