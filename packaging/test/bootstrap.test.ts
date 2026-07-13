/**
 * PK-01 — the clean-host bootstrap must FAIL CLOSED and name the exact missing prerequisite.
 *
 * The interesting property of a bootstrap script is not what it does on a host that is already
 * fine. It is what it does on a host that is NOT fine: it must refuse, exit non-zero, and say
 * precisely which prerequisite is absent and how to get it. A bootstrap that shrugs and continues
 * is how you get a "successful" install that cannot run a sandbox.
 *
 * These tests build a PATH containing only what we choose, so the script really does run its
 * detection against a host that is missing a C toolchain, or bubblewrap, or a working user
 * namespace. Nothing is stubbed inside the script; the environment around it is what changes.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'scripts', 'bootstrap.sh');

/** The utilities the script itself needs in order to run at all. */
const BASE_TOOLS = [
  'bash',
  'sh',
  'uname',
  'id',
  'sed',
  'grep',
  'cat',
  'head',
  'printf',
  'mktemp',
  'rm',
  'tar',
  'sha256sum',
  'mkdir',
  'dirname',
  'env',
  'sort',
  'curl',
  'apt-get',
];

let dir: string;
let bin: string;

function link(tool: string): void {
  try {
    const real = execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    if (real.length > 0) symlinkSync(real, join(bin, tool));
  } catch {
    // Not on this host: the script will correctly report it absent, which is a valid test state.
  }
}

/** A binary that exists but fails the way a kernel-refused bwrap actually fails. */
function fakeFailingBwrap(message: string): void {
  const path = join(bin, 'bwrap');
  writeFileSync(path, `#!/bin/sh\necho "${message}" >&2\nexit 1\n`);
  chmodSync(path, 0o755);
}

interface Run {
  code: number;
  out: string;
}

function bootstrap(args: readonly string[]): Run {
  try {
    const out = execFileSync('bash', [BOOTSTRAP, ...args], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: dir, TERM: 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-bootstrap-'));
  bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of BASE_TOOLS) link(tool);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('--check on a host that is missing everything', () => {
  it('exits 2 and names every absent prerequisite with its exact remedy', () => {
    // No cc, no c++, no make, no python3, no git, no bwrap, no infocmp on this PATH.
    const r = bootstrap(['--check']);

    expect(r.code, 'a host that cannot run the product must not exit 0').toBe(2);
    expect(r.out).toContain('unmet prerequisite');

    // Named by the exact binary, not by a vague category.
    for (const missing of ['cc', 'c++', 'make', 'python3', 'git', 'bwrap', 'infocmp']) {
      expect(r.out, `${missing} must be reported absent`).toMatch(
        new RegExp(`${missing.replace('+', '\\+')}\\s+absent`),
      );
    }

    // And the remedy is an actual command, with the actual Debian package names.
    expect(r.out).toContain('apt-get install -y build-essential');
    expect(r.out).toContain('apt-get install -y bubblewrap');
    expect(r.out).toContain('apt-get install -y python3');
  });

  it('explains WHY each prerequisite is required, not just that it is', () => {
    const r = bootstrap(['--check']);
    // These are the two facts a confused operator most needs (ADR 0002, ADR 0003).
    expect(r.out).toContain('compile from source');
    expect(r.out).toContain('no safe profile can run without it');
  });

  it('--check changes nothing', () => {
    const r = bootstrap(['--check']);
    expect(r.out).toContain('nothing was changed');
  });
});

describe('the sandbox probe is functional, not nominal', () => {
  it('a bwrap that EXISTS but is refused by the kernel is reported unmet', () => {
    // The Ubuntu 24.04+ case: the binary is installed, and the kernel still says no.
    fakeFailingBwrap('bwrap: setting up uid map: Permission denied');
    for (const tool of ['cc', 'c++', 'make', 'python3', 'git', 'infocmp']) link(tool);

    const r = bootstrap(['--check']);

    expect(r.code, 'a present-but-broken bwrap must NOT pass').toBe(2);
    expect(r.out).toContain('unprivileged user namespaces');
    expect(r.out).toContain('bwrap could not create one');
    // The remedy must be a specific sysctl or profile action, not "check your kernel".
    expect(r.out).toMatch(/sysctl -w (user\.max_user_namespaces|kernel\.\w+)/);
  });

  it('a bwrap that fails for an unrelated reason is still reported unmet', () => {
    fakeFailingBwrap('bwrap: execvp /bin/echo: No such file or directory');
    for (const tool of ['cc', 'c++', 'make', 'python3', 'git', 'infocmp']) link(tool);

    const r = bootstrap(['--check']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('unprivileged user namespaces');
  });
});

describe('--dry-run', () => {
  it('prints the exact commands it would run, and runs none of them', () => {
    const r = bootstrap(['--dry-run']);
    expect(r.out).toContain('nothing was run');
    expect(r.out).toMatch(/\$ apt-get update && apt-get install -y --no-install-recommends/);
    // Deduplicated: cc, c++ and make all come from build-essential, which must appear ONCE.
    const plan = /\$ apt-get [^\n]*/.exec(r.out)?.[0] ?? '';
    expect(plan.match(/build-essential/g)?.length).toBe(1);
    expect(r.code).toBe(2); // prerequisites are still unmet; a dry run does not pretend otherwise
  });
});

describe('the recorded target host', () => {
  it('passes --check with the real PATH — this host can run the product', () => {
    // Not a tautology: it is the assertion that the recorded target in checkpoint 00 is still
    // true, and that the detector agrees with the sandbox the security suite actually uses.
    const out = execFileSync('bash', [BOOTSTRAP, '--check'], {
      encoding: 'utf8',
      env: process.env,
    });
    expect(out).toContain('host is ready');
    expect(out).toContain('created a real namespace and executed inside it');
  });
});
