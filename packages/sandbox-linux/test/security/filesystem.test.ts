/**
 * Filesystem confinement — attacks that MUST fail against real bwrap.
 *
 * These do not assert on argv. They run a process inside the sandbox and observe that it cannot do
 * the thing. That is the difference between "a sandbox" and "a string that mentions a sandbox".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { BubblewrapBackend } from '../../src/backend.ts';
import {
  CAP,
  NODE,
  SH,
  SANDBOX_WORKSPACE,
  makeWorkspace,
  specFor,
  type Workspace,
} from './helpers.ts';

const backend = new BubblewrapBackend(() => Date.now());
let ws: Workspace;

beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

// A guard so a host that somehow lost bwrap between checkpoint 00 and now fails loudly, not silently.
it('bubblewrap is available on this host (precondition for the security suite)', () => {
  expect(CAP.available).toBe(true);
});

describe('read-only isolation cannot write to the workspace', () => {
  it('a write inside a read-only workspace fails with EROFS/EACCES', async () => {
    const result = await backend.run(
      specFor(ws, {
        mode: 'read-only',
        command: SH,
        // The redirect is the LAST command, so the shell's exit code reflects its failure.
        args: ['-c', 'echo pwned > blocked.txt'],
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Read-only file system|Permission denied/i);
    // And nothing actually landed on the host side.
    expect(existsSync(join(ws.workspace, 'blocked.txt'))).toBe(false);
  });
});

describe('workspace-write can write inside but not outside', () => {
  it('a write inside the workspace succeeds and lands on the host', async () => {
    const result = await backend.run(
      specFor(ws, { command: SH, args: ['-c', 'echo ok > created.txt'] }),
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(ws.workspace, 'created.txt'), 'utf8')).toBe('ok\n');
  });

  it('a write to a host path OUTSIDE the workspace cannot even find the path', async () => {
    // The host directory exists, but it is not bound, so inside the sandbox it does not exist.
    const outside = join(ws.root, 'outside.txt');
    const result = await backend.run(
      specFor(ws, { command: SH, args: ['-c', `echo pwned > ${outside}`] }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  it('/usr is read-only even in workspace-write', async () => {
    const result = await backend.run(
      specFor(ws, { command: SH, args: ['-c', 'echo x > /usr/pwned; echo "exit=$?"'] }),
    );
    expect(result.stdout + result.stderr).toMatch(/Read-only file system|Permission denied/i);
  });
});

describe('the host filesystem is not visible', () => {
  it('cannot see /root (it is never bound) — ENOENT', async () => {
    const result = await backend.run(
      specFor(ws, {
        command: NODE,
        args: [
          '-e',
          'try{require("fs").readdirSync("/root");console.log("VISIBLE")}catch(e){console.log(e.code)}',
        ],
      }),
    );
    expect(result.stdout.trim()).toBe('ENOENT');
  });

  it('cannot see a ~/.ssh planted on the host', async () => {
    // Plant a fake ssh key on the host, OUTSIDE the workspace. It must be invisible in the sandbox.
    const result = await backend.run(
      specFor(ws, {
        command: NODE,
        args: [
          '-e',
          'try{require("fs").readFileSync(process.env.HOME+"/.ssh/id_ed25519");console.log("LEAKED")}catch(e){console.log(e.code)}',
        ],
        env: { PATH: '/usr/bin:/bin', HOME: '/root' },
      }),
    );
    expect(result.stdout.trim()).not.toBe('LEAKED');
    expect(result.stdout.trim()).toBe('ENOENT');
  });

  it('cannot read /etc/shadow — /etc is not bound', async () => {
    const result = await backend.run(
      specFor(ws, {
        command: NODE,
        args: [
          '-e',
          'try{require("fs").readFileSync("/etc/shadow");console.log("LEAKED")}catch(e){console.log(e.code)}',
        ],
      }),
    );
    expect(result.stdout.trim()).toBe('ENOENT');
  });
});

describe('symlink and traversal escape from inside the sandbox', () => {
  it('a symlink planted in the workspace pointing at /etc/passwd resolves to nothing', async () => {
    // Create the symlink on the host side, then try to read THROUGH it from inside the sandbox.
    symlinkSync('/etc/passwd', join(ws.workspace, 'link-to-passwd'));
    const result = await backend.run(
      specFor(ws, {
        command: NODE,
        args: [
          '-e',
          `try{const d=require("fs").readFileSync("${SANDBOX_WORKSPACE}/link-to-passwd","utf8");console.log(d.includes("root:")?"LEAKED":"EMPTY")}catch(e){console.log(e.code)}`,
        ],
      }),
    );
    // /etc is not in the mount namespace, so the symlink target does not exist inside the sandbox.
    expect(result.stdout.trim()).not.toBe('LEAKED');
    expect(['ENOENT', 'EMPTY']).toContain(result.stdout.trim());
  });

  it('an absolute path outside the workspace is unreachable', async () => {
    writeFileSync(join(ws.root, 'secret.txt'), 'top secret');
    const result = await backend.run(
      specFor(ws, {
        command: SH,
        args: ['-c', `cat ${join(ws.root, 'secret.txt')} 2>&1; echo "exit=$?"`],
      }),
    );
    expect(result.stdout).not.toContain('top secret');
    expect(result.stdout).toMatch(/No such file|exit=[^0]/);
  });
});
