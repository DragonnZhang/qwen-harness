/**
 * Path canonicalization. Uses a REAL temp directory with REAL symlinks and hardlinks — the bugs
 * this code prevents (symlink escape, TOCTOU, hardlinked-file provenance) only exist against a real
 * filesystem, so a mocked fs would prove nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanonicalizeError, canonicalizePath, canonicalizeWithin } from '../../src/canonicalize.ts';

let root: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qh-canon-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'a.txt'), 'hello');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('canonicalizePath', () => {
  it('resolves an existing file and reports its identity', () => {
    const result = canonicalizePath(join(workspace, 'a.txt'));
    expect(result.exists).toBe(true);
    expect(result.isDirectory).toBe(false);
    expect(result.dev).not.toBeNull();
    expect(result.ino).not.toBeNull();
  });

  it('expands ~ against the injected home directory', () => {
    const result = canonicalizePath('~/workspace/a.txt', { homeDir: root });
    expect(result.path).toBe(join(workspace, 'a.txt'));
  });

  it('rejects a relative path', () => {
    expect(() => canonicalizePath('a/b')).toThrow(CanonicalizeError);
  });

  it('NFC-normalizes so two byte-spellings resolve to one path', () => {
    // "e"+U+0301 (decomposed) vs precomposed "\u00e9": same file, two byte strings.
    const a = canonicalizePath(join(workspace, 'cafe\u0301.txt'));
    const b = canonicalizePath(join(workspace, 'caf\u00e9.txt'));
    expect(a.path).toBe(b.path);
    expect(a.path.normalize('NFC')).toBe(a.path);
  });

  it('returns metadata for a not-yet-existing write target with a resolved parent', () => {
    const result = canonicalizePath(join(workspace, 'new.txt'));
    expect(result.exists).toBe(false);
    expect(result.path).toBe(join(workspace, 'new.txt'));
  });
});

describe('canonicalizeWithin — containment', () => {
  it('accepts a path inside the root', () => {
    const result = canonicalizeWithin(workspace, 'a.txt');
    expect(result.path).toBe(join(workspace, 'a.txt'));
  });

  it('rejects a ../ traversal that escapes the root', () => {
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    expect(() => canonicalizeWithin(workspace, '../secret.txt')).toThrow(/escape|absolute/i);
  });

  it('rejects an absolute relative path', () => {
    expect(() => canonicalizeWithin(workspace, '/etc/passwd')).toThrow(CanonicalizeError);
  });

  it('rejects a symlink whose target escapes the root (symlink escape)', () => {
    writeFileSync(join(root, 'outside.txt'), 'outside');
    symlinkSync(join(root, 'outside.txt'), join(workspace, 'link'));
    let code: string | undefined;
    try {
      canonicalizeWithin(workspace, 'link');
    } catch (error) {
      code = (error as CanonicalizeError).code;
    }
    // Either the resolved target is outside the root, or the final component is refused as a symlink.
    expect(['traversal-escape', 'symlink-escape']).toContain(code);
  });

  it('rejects a symlink that stays inside but points at a directory outside via ..', () => {
    symlinkSync('../..', join(workspace, 'up'));
    expect(() => canonicalizeWithin(workspace, 'up')).toThrow(CanonicalizeError);
  });

  it('refuses a pre-existing hardlinked regular file when denyHardlinks is set', () => {
    const original = join(root, 'original.txt');
    writeFileSync(original, 'data');
    const hard = join(workspace, 'hardlink.txt');
    linkSync(original, hard);
    expect(() => canonicalizeWithin(workspace, 'hardlink.txt', { denyHardlinks: true })).toThrow(
      /hardlink/i,
    );
    // Without the flag, a hardlink is allowed (nlink is still reported for the caller to inspect).
    const allowed = canonicalizeWithin(workspace, 'hardlink.txt');
    expect(allowed.nlink).toBeGreaterThan(1);
  });
});
