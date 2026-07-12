/**
 * Every protected path in docs/product/defaults.md, asserted as a table.
 *
 * The point of the table is completeness: if a future refactor drops one glob, a row here fails.
 * Each row also asserts the per-profile behavior the defaults freeze — plan denies, ask and
 * auto-accept-edits require an exact grant, yolo defers to managed policy.
 */

import { describe, expect, it } from 'vitest';

import { actionDigest } from './action.ts';
import { PolicyEngine } from './engine.ts';
import { RECOMMENDED_MANAGED_POLICY } from './managed.ts';
import { classifyPath, globToRegExp, isMetadataHost, isWithin, matchGlob } from './paths.ts';
import { HOME, WORKSPACE, ctx, fileRead, fileWrite, grant, network } from '../test/helpers.ts';

const engine = new PolicyEngine();

/** [path, the class it must be classified as, whether READS are protected too]. */
const PROTECTED: readonly (readonly [string, string, boolean])[] = [
  [`${WORKSPACE}/.git/config`, 'git-internal', false],
  [`${WORKSPACE}/.git/hooks/pre-commit`, 'git-internal', false],
  [`${WORKSPACE}/.env`, 'credential-file', true],
  [`${WORKSPACE}/.env.production`, 'credential-file', true],
  [`${WORKSPACE}/certs/server.pem`, 'credential-file', true],
  [`${WORKSPACE}/certs/server.key`, 'credential-file', true],
  [`${WORKSPACE}/certs/bundle.p12`, 'credential-file', true],
  [`${WORKSPACE}/.npmrc`, 'credential-file', true],
  [`${WORKSPACE}/.pypirc`, 'credential-file', true],
  [`${HOME}/.netrc`, 'credential-file', true],
  [`${HOME}/.git-credentials`, 'credential-file', true],
  [`${HOME}/.ssh/id_ed25519`, 'user-credential-store', true],
  [`${HOME}/.aws/credentials`, 'user-credential-store', true],
  [`${HOME}/.config/gcloud/application_default_credentials.json`, 'user-credential-store', true],
  [`${HOME}/.kube/config`, 'user-credential-store', true],
  [`${HOME}/.docker/config.json`, 'user-credential-store', true],
  [`${HOME}/.config/gh/hosts.yml`, 'user-credential-store', true],
  ['/etc/passwd', 'system-path', true],
  ['/etc/shadow', 'system-path', true],
  ['/proc/self/environ', 'system-path', true],
  ['/sys/kernel/debug/x', 'system-path', true],
  ['/dev/mem', 'system-path', true],
  ['/boot/vmlinuz', 'system-path', true],
  ['/root/.bashrc', 'system-path', true],
  ['/var/run/docker.sock', 'daemon-socket', true],
  ['/run/docker.sock', 'daemon-socket', true],
  ['/run/containerd/containerd.sock', 'daemon-socket', true],
  ['/run/podman/podman.sock', 'daemon-socket', true],
];

describe('protected-path classification', () => {
  for (const [path, expectedClass, readProtected] of PROTECTED) {
    it(`${path} is ${expectedClass} (write)`, () => {
      const matches = classifyPath(path, 'write', { workspaceRoot: WORKSPACE, homeDir: HOME });
      expect(matches.map((m) => m.class)).toContain(expectedClass);
    });

    it(`${path} read protection is ${readProtected}`, () => {
      const matches = classifyPath(path, 'read', { workspaceRoot: WORKSPACE, homeDir: HOME });
      expect(matches.length > 0).toBe(readProtected);
    });
  }

  it('an ordinary workspace file is not protected', () => {
    expect(
      classifyPath(`${WORKSPACE}/src/app.ts`, 'write', {
        workspaceRoot: WORKSPACE,
        homeDir: HOME,
      }),
    ).toEqual([]);
  });
});

describe('protected paths behave exactly as the defaults freeze, in every profile', () => {
  for (const [path, , readProtected] of PROTECTED) {
    const action = readProtected ? fileRead(path) : fileWrite(path);

    it(`plan denies ${path}`, () => {
      expect(engine.evaluate(action, ctx({ profile: 'plan' })).outcome).toBe('deny');
    });

    it(`ask requires an exact grant for ${path}`, () => {
      expect(engine.evaluate(action, ctx({ profile: 'ask' })).outcome).toBe('ask');
      const g = grant({ id: 'g', scope: 'once', actionDigest: actionDigest(action) });
      expect(engine.evaluate(action, ctx({ profile: 'ask', grants: [g] })).outcome).toBe('allow');
    });

    it(`auto-accept-edits requires an exact grant for ${path}`, () => {
      expect(engine.evaluate(action, ctx({ profile: 'auto-accept-edits' })).outcome).toBe('ask');
    });

    it(`yolo reaches ${path} only when managed policy does not deny it`, () => {
      expect(engine.evaluate(action, ctx({ profile: 'yolo' })).outcome).toBe('allow');
    });
  }
});

describe('the cloud metadata endpoint', () => {
  it('is recognised on every documented address', () => {
    expect(isMetadataHost('169.254.169.254')).toBe(true);
    expect(isMetadataHost('169.254.1.2')).toBe(true);
    expect(isMetadataHost('metadata.google.internal')).toBe(true);
    expect(isMetadataHost('100.100.100.100')).toBe(true);
    expect(isMetadataHost('example.com')).toBe(false);
  });

  it('is denied outright by the recommended managed policy, in every profile', () => {
    const action = network('http://169.254.169.254/latest/meta-data/', '169.254.169.254');
    for (const profile of ['plan', 'ask', 'auto-accept-edits', 'yolo'] as const) {
      const decision = engine.evaluate(
        action,
        ctx({ profile, managedPolicy: RECOMMENDED_MANAGED_POLICY }),
      );
      expect(decision.outcome).toBe('deny');
    }
  });
});

describe('the system-path workspace carve-out', () => {
  // The repository under test genuinely lives at /root/qwen-harness on the recorded target host.
  const rootWorkspace = '/root/qwen-harness';
  const lookup = { workspaceRoot: rootWorkspace, homeDir: '/root' };

  it('a file inside a workspace that happens to be under /root is NOT a protected system path', () => {
    expect(classifyPath(`${rootWorkspace}/src/app.ts`, 'write', lookup)).toEqual([]);
  });

  it('a file elsewhere under /root still is', () => {
    const matches = classifyPath('/root/.bashrc', 'write', lookup);
    expect(matches.map((m) => m.class)).toContain('system-path');
  });

  it('the carve-out does NOT extend to credential files inside that workspace', () => {
    expect(classifyPath(`${rootWorkspace}/.env`, 'read', lookup).length).toBeGreaterThan(0);
    expect(classifyPath(`${rootWorkspace}/.git/config`, 'write', lookup).length).toBeGreaterThan(0);
    expect(classifyPath(`${rootWorkspace}/deploy.pem`, 'read', lookup).length).toBeGreaterThan(0);
  });

  it('auto-accept-edits still auto-allows an ordinary edit in a /root workspace', () => {
    const decision = engine.evaluate(
      fileWrite(`${rootWorkspace}/src/app.ts`),
      ctx({ profile: 'auto-accept-edits', workspaceRoot: rootWorkspace, homeDir: '/root' }),
    );
    expect(decision.outcome).toBe('allow');
  });
});

describe('glob engine', () => {
  it('** crosses separators, * does not', () => {
    expect(matchGlob('/etc/**', '/etc/ssl/certs/ca.pem')).toBe(true);
    expect(matchGlob('/etc/*', '/etc/ssl/certs/ca.pem')).toBe(false);
    expect(matchGlob('/etc/*', '/etc/passwd')).toBe(true);
  });

  it('**/x matches at any depth including the root', () => {
    expect(matchGlob('**/.env', '/.env')).toBe(true);
    expect(matchGlob('**/.env', '/a/b/c/.env')).toBe(true);
    expect(matchGlob('**/.env', '/a/.envrc')).toBe(false);
  });

  it('escapes regexp metacharacters in literal segments', () => {
    expect(matchGlob('/a+b/c', '/a+b/c')).toBe(true);
    expect(matchGlob('/a+b/c', '/aab/c')).toBe(false);
    expect(globToRegExp('/a.b').test('/axb')).toBe(false);
  });

  it('isWithin is prefix-safe', () => {
    expect(isWithin('/home/dev/project', '/home/dev/project')).toBe(true);
    expect(isWithin('/home/dev/project', '/home/dev/project/a')).toBe(true);
    expect(isWithin('/home/dev/project', '/home/dev/project-evil/a')).toBe(false);
  });
});
