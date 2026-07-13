import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualClock } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverSkills,
  nodeSkillFileSystem,
  SkillRegistry,
  SkillScopeError,
  type SkillFileSystem,
} from '../../src/index.ts';

/**
 * Adversarial evidence for IN-02 on a REAL filesystem with REAL symlinks.
 *
 * String matching is not a containment proof. `skills/alpha/assets/out` may be a symlink to
 * `/etc`, and every lexical check in the world will happily conclude that
 * `<root>/assets/out/passwd` is "inside the skill root". Only asking the kernel — realpath, then
 * re-check containment — sees it. So these tests build the escape on disk and demand a rejection.
 *
 * The layout under a fresh temp dir:
 *
 *   outside/secret.txt                     the thing an attacker wants
 *   workspace/skills/alpha/SKILL.md        an ordinary skill
 *   workspace/skills/alpha/scripts/run.sh  a legitimate resource
 *   workspace/skills/alpha/escape          -> ../../../outside            (symlinked DIRECTORY)
 *   workspace/skills/alpha/leak.txt        -> ../../../outside/secret.txt (symlinked FILE)
 *   workspace/skills/hijack/SKILL.md       -> ../../../outside/secret.txt (symlinked SKILL.md)
 *   workspace/skills/linked                -> ../../linked-skills         (symlinked skill DIR)
 */
describe('a skill can never reach outside its validated root (IN-02, S)', () => {
  let dir: string;
  let skillsDir: string;
  let outside: string;
  let fs: SkillFileSystem;
  let registry: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-skills-sec-'));

    outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'BEGIN PRIVATE KEY\n');

    skillsDir = join(dir, 'workspace', 'skills');
    const alpha = join(skillsDir, 'alpha');
    mkdirSync(join(alpha, 'scripts'), { recursive: true });
    writeFileSync(
      join(alpha, 'SKILL.md'),
      '---\nname: alpha\ndescription: An ordinary skill.\nresources: [scripts/run.sh]\n---\nbody\n',
    );
    writeFileSync(join(alpha, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n');

    // Real symlinks. This is the whole point of this file.
    symlinkSync(outside, join(alpha, 'escape'), 'dir');
    symlinkSync(join(outside, 'secret.txt'), join(alpha, 'leak.txt'));

    fs = nodeSkillFileSystem();
    registry = new SkillRegistry({ fs, clock: new ManualClock(0) });
    const found = discoverSkills({
      fs,
      sources: [{ source: 'project', dir: skillsDir, layout: 'skill-dirs' }],
    });
    expect(found.errors).toEqual([]);
    registry.registerAll(found.skills);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a legitimate resource inside the root resolves', () => {
    const resource = registry.resource('alpha', 'scripts/run.sh');
    expect(resource.path).toBe(fs.realpath(join(skillsDir, 'alpha', 'scripts', 'run.sh')));
    expect(resource.path.startsWith(resource.root)).toBe(true);
  });

  it('rejects an absolute path', () => {
    expectRejected(() => registry.resource('alpha', join(outside, 'secret.txt')), 'absolute-path');
    expectRejected(() => registry.resource('alpha', '/etc/passwd'), 'absolute-path');
  });

  it('rejects ../ traversal, however it is spelled', () => {
    for (const attempt of [
      '../../../outside/secret.txt',
      'scripts/../../../outside/secret.txt',
      './../../outside/secret.txt',
    ]) {
      expectRejected(() => registry.resource('alpha', attempt), 'traversal');
    }
  });

  it('rejects a path that escapes through a symlinked DIRECTORY (real symlink on disk)', () => {
    // Lexically, `escape/secret.txt` is inside the root. On disk it is `<tmp>/outside/secret.txt`.
    expectRejected(() => registry.resource('alpha', 'escape/secret.txt'), 'escapes-root');
  });

  it('rejects a symlinked FILE whose target is outside the root', () => {
    expectRejected(() => registry.resource('alpha', 'leak.txt'), 'escapes-root');
  });

  it('the rejection is not a lucky ENOENT: the target really exists and is readable', () => {
    // Prove the file we refused to hand over is genuinely there — otherwise the test would pass
    // for the wrong reason on a machine where the symlink failed to be created.
    expect(fs.isFile(fs.realpath(join(outside, 'secret.txt')))).toBe(true);
    expect(fs.readFile(join(outside, 'secret.txt'))).toContain('PRIVATE KEY');
    expectRejected(() => registry.resource('alpha', 'escape/secret.txt'), 'escapes-root');
  });

  it('refuses a SKILL.md that is itself a symlink out of the tree — before reading it', () => {
    const hijack = join(skillsDir, 'hijack');
    mkdirSync(hijack, { recursive: true });
    symlinkSync(join(outside, 'secret.txt'), join(hijack, 'SKILL.md'));

    const found = discoverSkills({
      fs,
      sources: [{ source: 'project', dir: skillsDir, layout: 'skill-dirs' }],
    });
    // The escape is REPORTED, never silently skipped, and the skill is not discovered.
    expect(found.skills.map((s) => s.name)).not.toContain('hijack');
    const error = found.errors.find((e) => e instanceof SkillScopeError);
    expect(error).toBeInstanceOf(SkillScopeError);
    expect((error as SkillScopeError).rejection).toBe('escapes-root');
    // And nothing from the secret leaked into the error message or the descriptor set.
    expect(JSON.stringify(found)).not.toContain('PRIVATE KEY');
  });

  it('a skill directory that is itself a symlink gets its REAL root, and stays inside it', () => {
    // A user legitimately symlinks a skill collection into place. Containment must then be judged
    // against the REAL directory, not the symlink path — otherwise every resource looks like an
    // escape and the skill is unusable.
    const real = join(dir, 'linked-skills', 'linked');
    mkdirSync(join(real, 'scripts'), { recursive: true });
    writeFileSync(
      join(real, 'SKILL.md'),
      '---\nname: linked\ndescription: A symlinked skill.\n---\nbody\n',
    );
    writeFileSync(join(real, 'scripts', 'ok.sh'), 'echo ok\n');
    symlinkSync(real, join(skillsDir, 'linked'), 'dir');

    const found = discoverSkills({
      fs,
      sources: [{ source: 'project', dir: skillsDir, layout: 'skill-dirs' }],
    });
    const fresh = new SkillRegistry({ fs, clock: new ManualClock(0) });
    fresh.registerAll(found.skills);

    const resource = fresh.resource('linked', 'scripts/ok.sh');
    expect(resource.path).toBe(fs.realpath(join(real, 'scripts', 'ok.sh')));
    // ...and it still cannot escape THAT root.
    expectRejected(() => fresh.resource('linked', '../../outside/secret.txt'), 'traversal');
  });

  it('a hook script pointing outside the root is rejected at registration, not at fire time', () => {
    const evil = join(skillsDir, 'evil');
    mkdirSync(evil, { recursive: true });
    symlinkSync(outside, join(evil, 'out'), 'dir');
    writeFileSync(
      join(evil, 'SKILL.md'),
      '---\nname: evil\ndescription: Tries to hook a script outside its root.\nhooks:\n  skill-start: out/secret.txt\n---\nbody\n',
    );

    const found = discoverSkills({
      fs,
      sources: [{ source: 'project', dir: skillsDir, layout: 'skill-dirs' }],
    });
    const fresh = new SkillRegistry({ fs, clock: new ManualClock(0) });
    const result = fresh.registerAll(found.skills);

    expect(fresh.has('evil')).toBe(false);
    const rejection = result.rejected.find((r) => r.name === 'evil');
    expect(rejection?.error).toBeInstanceOf(SkillScopeError);
    expect((rejection?.error as SkillScopeError).rejection).toBe('escapes-root');
  });

  it('the registry offers NO way to load a skill by path', () => {
    // The API surface itself is the control: there is no `loadFrom`, no `loadPath`, no overload of
    // `load` that accepts one. A path handed to `load` is simply an unknown NAME.
    const api = Object.getOwnPropertyNames(SkillRegistry.prototype);
    expect(api).not.toContain('loadFrom');
    expect(api).not.toContain('loadPath');
    expect(() => registry.load(join(skillsDir, 'alpha', 'SKILL.md'))).toThrow(/no skill named/);
  });

  function expectRejected(fn: () => unknown, rejection: string): void {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SkillScopeError);
    expect((thrown as SkillScopeError).rejection).toBe(rejection);
    // The refusal never leaks the content it refused to read.
    expect(String(thrown)).not.toContain('PRIVATE KEY');
  }
});
