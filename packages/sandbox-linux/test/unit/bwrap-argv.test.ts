/**
 * Unit tests for the bwrap argv builder. These prove the ARGV encodes the security policy; the
 * security suite proves the argv actually confines a real process. Both matter — an argv that
 * looks right but does not isolate is worthless, and isolation you cannot assert on statically is
 * hard to keep correct.
 */

import { describe, expect, it } from 'vitest';

import { buildBwrapArgs, SANDBOX_SCRATCH, SANDBOX_WORKSPACE } from '../../src/bwrap.ts';
import type { SandboxSpec } from '../../src/spec.ts';

const baseSpec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  isolation: {
    mode: 'workspace-write',
    workspaceRoot: '/home/dev/project',
    scratchRoot: '/home/dev/.cache/qh/scratch',
    networkAllowed: false,
    limits: { cpuSeconds: 30, fileSizeBytes: 1024, openFiles: 64, processes: 32 },
    ...overrides.isolation,
  },
  command: '/usr/bin/node',
  args: ['-e', 'process.exit(0)'],
  cwd: SANDBOX_WORKSPACE,
  env: { PATH: '/usr/bin:/bin' },
  timeoutMs: 5000,
  maxOutputBytes: 1024,
  ...overrides,
});

/** Find `[flag, a, b]` triples so a test can assert `--bind SRC DEST` without index arithmetic. */
function bindOf(argv: string[], dest: string): { flag: string; src: string } | null {
  for (let i = 0; i < argv.length - 2; i += 1) {
    if ((argv[i] === '--bind' || argv[i] === '--ro-bind') && argv[i + 2] === dest) {
      return { flag: argv[i] as string, src: argv[i + 1] as string };
    }
  }
  return null;
}

describe('buildBwrapArgs — namespaces and hardening', () => {
  it('unshares every namespace and drops all capabilities', () => {
    const argv = buildBwrapArgs(baseSpec());
    for (const ns of [
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-pid',
      '--unshare-uts',
      '--unshare-cgroup',
    ]) {
      expect(argv).toContain(ns);
    }
    // --cap-drop ALL is not optional: without it a root runtime's bwrap child keeps full caps.
    const i = argv.indexOf('--cap-drop');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('ALL');
    expect(argv).toContain('--die-with-parent');
    expect(argv).toContain('--new-session');
  });

  it('does NOT bind /etc — its secrets must not be reachable', () => {
    const argv = buildBwrapArgs(baseSpec());
    expect(bindOf(argv, '/etc')).toBeNull();
    expect(argv).not.toContain('/etc');
  });

  it('binds a private /tmp, minimal /proc and /dev, and read-only /usr', () => {
    const argv = buildBwrapArgs(baseSpec());
    expect(argv).toContain('--tmpfs');
    expect(argv).toContain('--proc');
    expect(argv).toContain('--dev');
    expect(bindOf(argv, '/usr')?.flag).toBe('--ro-bind');
  });
});

describe('buildBwrapArgs — network switch', () => {
  it('unshares the network when it is not granted', () => {
    expect(buildBwrapArgs(baseSpec({ isolation: { networkAllowed: false } as never }))).toContain(
      '--unshare-net',
    );
  });

  it('shares the network when it IS granted', () => {
    const argv = buildBwrapArgs(
      baseSpec({
        isolation: {
          mode: 'workspace-write',
          workspaceRoot: '/home/dev/project',
          networkAllowed: true,
        },
      }),
    );
    expect(argv).not.toContain('--unshare-net');
  });
});

describe('buildBwrapArgs — workspace mode is the plan/ask boundary', () => {
  it('read-only isolation binds the workspace read-only', () => {
    const argv = buildBwrapArgs(
      baseSpec({
        isolation: { mode: 'read-only', workspaceRoot: '/home/dev/project', networkAllowed: false },
      }),
    );
    expect(bindOf(argv, SANDBOX_WORKSPACE)?.flag).toBe('--ro-bind');
  });

  it('workspace-write isolation binds the workspace read-write', () => {
    const argv = buildBwrapArgs(baseSpec());
    expect(bindOf(argv, SANDBOX_WORKSPACE)?.flag).toBe('--bind');
  });

  it('scratch is always writable and remapped to a fixed internal path', () => {
    const argv = buildBwrapArgs(
      baseSpec({
        isolation: {
          mode: 'read-only',
          workspaceRoot: '/home/dev/project',
          scratchRoot: '/scratch',
          networkAllowed: false,
        },
      }),
    );
    expect(bindOf(argv, SANDBOX_SCRATCH)?.flag).toBe('--bind');
  });
});

describe('buildBwrapArgs — environment minimization', () => {
  it('clears the environment and sets back only what the spec named', () => {
    const argv = buildBwrapArgs(baseSpec({ env: { PATH: '/usr/bin', LANG: 'C' } }));
    expect(argv).toContain('--clearenv');
    // --setenv appears before --clearenv-set values; every setenv name must be one we chose.
    const setenvNames: string[] = [];
    for (let i = 0; i < argv.length - 1; i += 1) {
      if (argv[i] === '--setenv') setenvNames.push(argv[i + 1] as string);
    }
    // The worker roots are injected; user vars are exactly PATH and LANG. No secret name appears.
    expect(setenvNames).toContain('PATH');
    expect(setenvNames).toContain('LANG');
    expect(setenvNames).toContain('QH_WORKSPACE_ROOT');
    expect(
      setenvNames.some((n) => n.includes('KEY') || n.includes('TOKEN') || n.includes('SECRET')),
    ).toBe(false);
  });
});

describe('buildBwrapArgs — rlimits via prlimit', () => {
  it('wraps the target in prlimit when a prlimit path is provided', () => {
    const argv = buildBwrapArgs(baseSpec(), { prlimitPath: '/usr/bin/prlimit' });
    const p = argv.indexOf('/usr/bin/prlimit');
    expect(p).toBeGreaterThanOrEqual(0);
    // The command follows the prlimit flags and a `--` terminator.
    expect(argv).toContain('--cpu=30');
    expect(argv).toContain('--fsize=1024');
    expect(argv).toContain('--nofile=64');
    expect(argv).toContain('--nproc=32');
    expect(argv.indexOf('/usr/bin/node')).toBeGreaterThan(p);
  });

  it('omits the prlimit wrapper when no prlimit path is available (still runs)', () => {
    const argv = buildBwrapArgs(baseSpec());
    expect(argv).not.toContain('/usr/bin/prlimit');
    expect(argv).not.toContain('--cpu=30');
    // The command and its args are still the tail of the argv.
    expect(argv.slice(-3)).toEqual(['/usr/bin/node', '-e', 'process.exit(0)']);
  });

  it('the command and its args are always LAST, after any wrapper', () => {
    const argv = buildBwrapArgs(baseSpec(), { prlimitPath: '/usr/bin/prlimit' });
    expect(argv.slice(-3)).toEqual(['/usr/bin/node', '-e', 'process.exit(0)']);
  });
});
