/**
 * PK-02 — the package lifecycle, exercised for real.
 *
 * This builds the ACTUAL release tarball, installs it into a temporary prefix, RUNS the installed
 * binary, upgrades to a second version, rolls back, and uninstalls — then asserts the prefix is
 * byte-for-byte back to how it was found.
 *
 * There is no mocking here on purpose. An install script that has only ever been reasoned about is
 * exactly the kind of untested claim that turns into a broken first-run for the first person who
 * trusts it. So: real tarball, real sha256 verification, real symlinks, real `node` executing the
 * bundled CLI, real uninstall.
 *
 * It is slow (it compiles and bundles). It is worth it — this is the only test in the suite that
 * proves the thing we actually ship works when it lands on a machine.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'packaging', 'install.sh');

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Run {
  try {
    const stdout = execFileSync(cmd, [...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...opts.env },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function installer(args: readonly string[], prefix: string): Run {
  return run('bash', [INSTALL_SH, ...args, '--prefix', prefix]);
}

/** Every path under `dir`, so "uninstall left nothing behind" is a comparison, not a vibe. */
function inventory(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, base: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      out.push(full.slice(base.length + 1));
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false; // a dangling symlink: record it, do not descend
      }
      if (isDir) walk(full, base);
    }
  };
  if (existsSync(dir)) walk(dir, dir);
  return out.sort();
}

let work: string;
let prefix: string;
let tarball: string;
let version: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'qh-lifecycle-'));
  prefix = join(work, 'prefix');
  mkdirSync(prefix, { recursive: true });

  // Build the real artifact. `--allow-dirty` because a developer's tree (and CI mid-branch) is
  // usually dirty; the manifest records that, and the lifecycle we are testing does not care.
  const built = run('pnpm', ['exec', 'tsx', 'scripts/package-cli.ts', '--allow-dirty']);
  if (built.code !== 0) {
    throw new Error(`packaging failed:\n${built.stdout}\n${built.stderr}`);
  }
  version = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version;
  tarball = join(REPO_ROOT, 'dist', 'release', `qwen-harness-${version}.tgz`);
  expect(existsSync(tarball)).toBe(true);
}, 300_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('the built package', () => {
  it('carries a manifest, a lockfile, checksums and completions', () => {
    const listing = run('tar', ['-tzf', tarball]).stdout;
    for (const entry of [
      'package/package.json',
      'package/MANIFEST.json',
      'package/SHA256SUMS',
      'package/qwen-harness.lock.json',
      'package/bin/qwen-harness',
      'package/lib/cli.js',
      'package/lib/migrate-config.js',
      'package/completions/qwen-harness.bash',
      'package/completions/_qwen-harness',
      'package/completions/qwen-harness.fish',
      'package/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ]) {
      expect(listing, `expected ${entry} in the package`).toContain(entry);
    }
  });

  it('has a detached sha256 that matches the tarball', () => {
    const detached = readFileSync(`${tarball}.sha256`, 'utf8').split(/\s+/)[0];
    const actual = run('sha256sum', [tarball]).stdout.split(/\s+/)[0];
    expect(actual).toBe(detached);
  });

  it('the lockfile records the vendored native dependency with its registry integrity', () => {
    const staging = join(work, 'peek');
    mkdirSync(staging, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', staging, '--strip-components=1']);
    const lock = JSON.parse(readFileSync(join(staging, 'qwen-harness.lock.json'), 'utf8')) as {
      packages: { name: string; version: string; integrity: string }[];
    };
    const bs = lock.packages.find((p) => p.name === 'better-sqlite3');
    expect(bs).toBeDefined();
    expect(bs!.version).toMatch(/^\d+\.\d+\.\d+$/);
    // The integrity is the one PNPM resolved, carried over from the real lockfile.
    expect(bs!.integrity).toMatch(/^sha\d{3}-/);
  });
});

describe('install -> run -> upgrade -> rollback -> uninstall', () => {
  it('the prefix starts empty', () => {
    expect(inventory(prefix)).toEqual([]);
  });

  it('installs, verifying every file against SHA256SUMS', () => {
    const r = installer(['install', tarball], prefix);
    expect(r.stdout + r.stderr, 'install output').toContain('SHA256SUMS verified');
    expect(r.stdout).toContain('no unlisted files');
    expect(r.code).toBe(0);

    expect(existsSync(join(prefix, 'bin', 'qwen-harness'))).toBe(true);
    expect(existsSync(join(prefix, 'lib', 'qwen-harness', 'current', 'lib', 'cli.js'))).toBe(true);
  });

  it('the INSTALLED binary actually runs — this is the whole point', () => {
    const bin = join(prefix, 'bin', 'qwen-harness');
    const help = run(bin, ['help'], { cwd: work });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('qwen-harness <command>');

    // `doctor` exercises the vendored native path: it opens the sandbox probe and the config
    // loader. If `better-sqlite3` were mis-vendored, the bundle would fail to import and this
    // would not be a clean exit at all.
    const doctor = run(bin, ['doctor'], { cwd: work });
    expect(doctor.stdout, 'doctor output').toContain('qwen-harness doctor');
    expect(doctor.stdout).toContain('sandbox:');
    // doctor exits 3 when a prerequisite is missing (e.g. no credential); either is a real run.
    expect([0, 3]).toContain(doctor.code);
  });

  it('installs shell completions for bash, zsh and fish', () => {
    const bash = join(prefix, 'share', 'bash-completion', 'completions', 'qwen-harness');
    const zsh = join(prefix, 'share', 'zsh', 'site-functions', '_qwen-harness');
    const fish = join(prefix, 'share', 'fish', 'vendor_completions.d', 'qwen-harness.fish');
    for (const path of [bash, zsh, fish]) expect(existsSync(path), path).toBe(true);

    // Every command the binary advertises must be completable. A completion script that has
    // drifted from the binary is worse than none: it teaches the user commands that do not exist.
    const help = run(join(prefix, 'bin', 'qwen-harness'), ['help'], { cwd: work }).stdout;
    const commands = [...help.matchAll(/^ {2}(\S+)(?:\s+<[^>]*>|\s+\[[^\]]*\])*\s{2,}\S/gm)].map(
      (m) => m[1]!,
    );
    expect(commands.length).toBeGreaterThan(3);

    const bashText = readFileSync(bash, 'utf8');
    const zshText = readFileSync(zsh, 'utf8');
    const fishText = readFileSync(fish, 'utf8');
    for (const command of commands) {
      expect(bashText, `bash completion is missing '${command}'`).toContain(command);
      expect(zshText, `zsh completion is missing '${command}'`).toContain(command);
      expect(fishText, `fish completion is missing '${command}'`).toContain(command);
    }
  });

  it('the bash completion is syntactically valid bash', () => {
    const bash = join(prefix, 'share', 'bash-completion', 'completions', 'qwen-harness');
    const r = run('bash', ['-n', bash]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  });

  it('verify passes on the active install, and FAILS when a file is tampered with', () => {
    expect(installer(['verify'], prefix).code).toBe(0);

    const target = join(prefix, 'lib', 'qwen-harness', 'versions', version, 'lib', 'cli.js');
    const original = readFileSync(target);
    writeFileSync(target, `${original.toString('utf8')}\n// tampered\n`);

    const tampered = installer(['verify'], prefix);
    expect(tampered.code).toBe(3);
    expect(tampered.stdout + tampered.stderr).toContain('does not match its own SHA256SUMS');

    writeFileSync(target, original);
    expect(installer(['verify'], prefix).code).toBe(0);
  });

  it('re-installing the same version is idempotent', () => {
    const before = inventory(prefix);
    const r = installer(['install', tarball], prefix);
    expect(r.code).toBe(0);
    expect(inventory(prefix)).toEqual(before);
  });

  it('refuses a package whose contents do not match its SHA256SUMS', () => {
    // Repack the package with one byte changed, leaving SHA256SUMS as it was. This is precisely
    // the attack the checksum file exists to catch, so the installer must refuse and install
    // NOTHING.
    const evilDir = join(work, 'evil');
    rmSync(evilDir, { recursive: true, force: true });
    mkdirSync(evilDir, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', evilDir, '--strip-components=1']);
    writeFileSync(join(evilDir, 'lib', 'cli.js'), '// hijacked\nprocess.exit(0)\n');
    const evilTarball = join(work, 'evil.tgz');
    run('bash', [
      '-c',
      `tar -czf ${JSON.stringify(evilTarball)} --transform 's,^\\./,package/,' -C ${JSON.stringify(evilDir)} ./`,
    ]);

    const evilPrefix = join(work, 'evil-prefix');
    mkdirSync(evilPrefix, { recursive: true });
    const r = installer(['install', evilTarball], evilPrefix);
    expect(r.code).toBe(3);
    expect(r.stdout + r.stderr).toContain('verification FAILED');
    // Nothing was linked into place.
    expect(existsSync(join(evilPrefix, 'bin', 'qwen-harness'))).toBe(false);
  });

  it('upgrades to a new version and remembers the old one', () => {
    // Build a "next" version by rewriting the version inside the package and re-checksumming it.
    // This is a genuine second artifact: different version, valid SHA256SUMS, installs the same way.
    const nextVersion = `${version}-next`;
    const nextTarball = join(work, `qwen-harness-${nextVersion}.tgz`);
    const stage = join(work, 'next');
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', stage, '--strip-components=1']);

    const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    pkg['version'] = nextVersion;
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    // Re-checksum, or our own installer would (correctly) reject it.
    run('bash', [
      '-c',
      `cd ${JSON.stringify(stage)} && find . -type f ! -name SHA256SUMS -printf '%P\\n' | sort | xargs sha256sum > SHA256SUMS`,
    ]);
    run('bash', [
      '-c',
      `tar -czf ${JSON.stringify(nextTarball)} --transform 's,^\\./,package/,' -C ${JSON.stringify(stage)} ./`,
    ]);

    const r = installer(['upgrade', nextTarball], prefix);
    expect(r.stdout + r.stderr).toContain('SHA256SUMS verified');
    expect(r.code).toBe(0);

    const status = installer(['status'], prefix).stdout;
    expect(status).toContain(`active:   ${nextVersion}`);
    expect(status).toContain(`previous: ${version}`);

    // Both versions are on disk: an upgrade never deletes the thing you might need to go back to.
    expect(existsSync(join(prefix, 'lib', 'qwen-harness', 'versions', version))).toBe(true);
    expect(existsSync(join(prefix, 'lib', 'qwen-harness', 'versions', nextVersion))).toBe(true);

    // And the upgraded binary runs.
    expect(run(join(prefix, 'bin', 'qwen-harness'), ['help'], { cwd: work }).code).toBe(0);
  });

  it('rolls back to the previous version, and the rolled-back binary runs', () => {
    const r = installer(['rollback'], prefix);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('rolled back');

    const status = installer(['status'], prefix).stdout;
    expect(status).toContain(`active:   ${version}`);
    // Rolling back twice returns you to where you were — `previous` now points at what we left.
    expect(status).toContain(`previous: ${version}-next`);

    const help = run(join(prefix, 'bin', 'qwen-harness'), ['help'], { cwd: work });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('qwen-harness <command>');
  });

  it('rollback fails cleanly when there is nothing to roll back to', () => {
    const fresh = join(work, 'fresh-prefix');
    mkdirSync(fresh, { recursive: true });
    const r = installer(['rollback'], fresh);
    expect(r.code).toBe(4);
    expect(r.stdout + r.stderr).toContain('no previous version');
  });

  it('uninstall leaves NOTHING behind', () => {
    const r = installer(['uninstall'], prefix);
    expect(r.code).toBe(0);

    const left = inventory(prefix);
    expect(left, `these paths survived uninstall: ${left.join(', ')}`).toEqual([]);
    expect(existsSync(join(prefix, 'bin', 'qwen-harness'))).toBe(false);
    expect(existsSync(join(prefix, 'lib', 'qwen-harness'))).toBe(false);
  });

  it('uninstall does not remove directories it did not create', () => {
    const shared = join(work, 'shared-prefix');
    mkdirSync(join(shared, 'bin'), { recursive: true });
    writeFileSync(join(shared, 'bin', 'someone-elses-tool'), '#!/bin/sh\n');

    expect(installer(['install', tarball], shared).code).toBe(0);
    expect(installer(['uninstall'], shared).code).toBe(0);

    // Our files are gone; the neighbour's are untouched, and so is the bin/ they live in.
    expect(existsSync(join(shared, 'bin', 'someone-elses-tool'))).toBe(true);
    expect(existsSync(join(shared, 'bin', 'qwen-harness'))).toBe(false);
    expect(existsSync(join(shared, 'lib', 'qwen-harness'))).toBe(false);
  });

  it('uninstall on an empty prefix is a clean no-op', () => {
    const empty = join(work, 'empty-prefix');
    mkdirSync(empty, { recursive: true });
    const r = installer(['uninstall'], empty);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing to uninstall');
  });
});

describe('config migration is wired into the install', () => {
  it('migrates a v0 config forward on install, and backs the old one up', () => {
    const home = join(work, 'migrate-home');
    const xdg = join(home, '.config');
    const configDir = join(xdg, 'qwen-harness');
    const configPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });

    // The real v0 (unversioned) shape: `endpoint`/`keyEnv`/`profile` and a raw `apiKey`.
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          keyEnv: 'DASHSCOPE_API_KEY',
          profile: 'ask',
        },
        null,
        2,
      ),
    );

    const migratePrefix = join(work, 'migrate-prefix');
    mkdirSync(migratePrefix, { recursive: true });
    const r = run('bash', [INSTALL_SH, 'install', tarball, '--prefix', migratePrefix], {
      env: { HOME: home, XDG_CONFIG_HOME: xdg },
    });
    expect(r.code).toBe(0);
    expect(r.stdout, 'the installer must report the migration').toContain('schema v0 -> v1');

    const migrated = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(migrated['version']).toBe(1);
    // The v0 -> v1 renames, performed by the PRODUCT's migration chain, not by the installer.
    expect(migrated['baseUrl']).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(migrated['apiKeyEnv']).toBe('DASHSCOPE_API_KEY');
    expect(migrated['permissionProfile']).toBe('ask');
    expect(migrated['endpoint']).toBeUndefined();

    // The pre-migration document is preserved.
    expect(existsSync(`${configPath}.bak-v0`)).toBe(true);

    run('bash', [INSTALL_SH, 'uninstall', '--prefix', migratePrefix], { env: { HOME: home } });
  });

  it('a config from a NEWER build is refused, not silently downgraded', () => {
    const home = join(work, 'future-home');
    const xdg = join(home, '.config');
    const configDir = join(xdg, 'qwen-harness');
    const configPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    // Version 99: written by a build from the future. Downgrading it would drop keys we cannot
    // interpret — which, for a policy document, may be exactly the keys holding this host safe.
    writeFileSync(configPath, JSON.stringify({ version: 99, model: 'qwen-next' }, null, 2));

    const p = join(work, 'future-prefix');
    mkdirSync(p, { recursive: true });
    const r = run('bash', [INSTALL_SH, 'install', tarball, '--prefix', p], {
      env: { HOME: home, XDG_CONFIG_HOME: xdg },
    });

    // The INSTALL still succeeds — the binary is fine, it is the config that is ahead — but the
    // operator is told, loudly, and the file is untouched.
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('newer than this build');
    const after = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(after['version']).toBe(99);
    expect(after['model']).toBe('qwen-next');

    run('bash', [INSTALL_SH, 'uninstall', '--prefix', p], { env: { HOME: home } });
  });
});
