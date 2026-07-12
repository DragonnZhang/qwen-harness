import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerFailure, resolveScoped, type HandleRoots } from '../../src/index.ts';

/**
 * These run against a REAL filesystem with REAL symlinks and REAL hardlinks. A path-escape test
 * against a mocked `fs` would prove nothing — the bugs live precisely in how the real kernel
 * resolves the things we are trying to defend against.
 */
describe('resolveScoped: path escape (TL-03, SC-01)', () => {
  let root: string;
  let outside: string;
  let roots: HandleRoots;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qh-ws-'));
    outside = mkdtempSync(join(tmpdir(), 'qh-outside-'));
    roots = { workspace: root, scratch: join(root, '.scratch') };
    mkdirSync(roots.scratch, { recursive: true });

    writeFileSync(join(root, 'ok.ts'), 'inside the workspace\n');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET MATERIAL\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const escape = (relative: string) =>
    expect(() =>
      resolveScoped(roots, { handle: 'workspace', relative }, { mustExist: false }),
    ).toThrow(WorkerFailure);

  it('resolves a legitimate path inside the workspace', () => {
    const resolved = resolveScoped(
      roots,
      { handle: 'workspace', relative: 'ok.ts' },
      { mustExist: true },
    );
    expect(resolved.startsWith(root)).toBe(true);
  });

  it('rejects an ABSOLUTE path smuggled in as a relative one', () => {
    // `path.join(root, '/etc/passwd')` would happily yield '/etc/passwd' on some code paths.
    escape('/etc/passwd');
    escape(outside + '/secret.txt');
  });

  it('rejects `../` traversal', () => {
    escape('../../../etc/passwd');
    escape('a/b/../../../../etc/passwd');
    escape('./../../root/.ssh/id_rsa');
  });

  it('rejects traversal that only becomes visible AFTER normalization', () => {
    escape('subdir/./../../outside');
    escape('.//..//..//etc/passwd');
  });

  it('rejects a SYMLINK inside the workspace that points outside it', () => {
    // The classic escape: the path is textually inside the workspace, so a naive prefix check
    // passes. Only canonicalization reveals that it resolves to somewhere else entirely.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'innocent.txt'));

    expect(() =>
      resolveScoped(roots, { handle: 'workspace', relative: 'innocent.txt' }, { mustExist: true }),
    ).toThrow(WorkerFailure);
  });

  it('rejects a symlinked DIRECTORY in the middle of the path', () => {
    // The final component is a normal, non-existent file. It is the PARENT that escapes — which
    // is why canonicalization must resolve every existing ancestor, not just the leaf.
    symlinkSync(outside, join(root, 'link-dir'));

    expect(() =>
      resolveScoped(
        roots,
        { handle: 'workspace', relative: 'link-dir/new-file.txt' },
        { mustExist: false },
      ),
    ).toThrow(WorkerFailure);
  });

  it('rejects a symlink to an absolute system path', () => {
    symlinkSync('/etc/passwd', join(root, 'passwd-link'));
    expect(() =>
      resolveScoped(roots, { handle: 'workspace', relative: 'passwd-link' }, { mustExist: true }),
    ).toThrow(WorkerFailure);
  });

  it('refuses a pre-existing HARDLINK to a file outside the workspace', () => {
    // A hardlink is indistinguishable from a normal file by path alone — canonicalization does
    // not help, because there is no link to resolve. Only the link count reveals it.
    // defaults.md: safe profiles deny pre-existing hardlinked regular files.
    const target = join(outside, 'secret.txt');
    const hard = join(root, 'looks-normal.txt');
    try {
      linkSync(target, hard);
    } catch {
      return; // cross-device: hardlink impossible here, nothing to test
    }

    expect(() =>
      resolveScoped(
        roots,
        { handle: 'workspace', relative: 'looks-normal.txt' },
        { mustExist: true },
      ),
    ).toThrow(/hardlink/i);
  });

  it('rejects an unknown capability handle', () => {
    expect(() =>
      resolveScoped(roots, { handle: 'workspace', relative: 'ok.ts' }, { mustExist: true }),
    ).not.toThrow();

    expect(() =>
      // @ts-expect-error — deliberately invalid handle, to prove it is rejected at runtime too.
      resolveScoped(roots, { handle: 'host-root', relative: 'etc/passwd' }, { mustExist: false }),
    ).toThrow(WorkerFailure);
  });

  it('normalizes Unicode before checking containment', () => {
    // NFD-decomposed characters must not produce a different path than their NFC form.
    const nfc = resolveScoped(
      roots,
      { handle: 'workspace', relative: 'café.ts' },
      { mustExist: false },
    );
    const nfd = resolveScoped(
      roots,
      { handle: 'workspace', relative: 'café.ts' },
      { mustExist: false },
    );
    expect(nfd).toBe(nfc);
  });

  it('the error names the escape rather than leaking the resolved host path', () => {
    try {
      resolveScoped(
        roots,
        { handle: 'workspace', relative: '../../etc/passwd' },
        { mustExist: false },
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkerFailure);
      const failure = e as WorkerFailure;
      expect(failure.detail.category).toBe('path-escape');
      // The message tells the model what it did wrong without handing it a host path to retry with.
      expect(failure.detail.message).not.toContain(outside);
    }
  });
});
