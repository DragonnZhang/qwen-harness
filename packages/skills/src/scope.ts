/**
 * Canonical skill scope (IN-02) — the security core of this package.
 *
 * THE RULE: a skill is addressed by NAME through the registry. A path never crosses the boundary
 * from the model. When a skill's body says "run scripts/lint.sh" or "read references/checklist.md",
 * that RELATIVE path is resolved here, against the canonical root the registry validated at
 * registration time, and the result must still be inside that root.
 *
 * Three independent barriers, because each one alone is defeatable:
 *
 *   1. LEXICAL — reject an absolute path, a `~`, a NUL, and any `..` segment. Cheap, and it stops
 *      the obvious `../../../../etc/passwd`.
 *   2. LEXICAL CONTAINMENT after join+normalize — catches an escape assembled from pieces that
 *      individually look innocent.
 *   3. REALPATH CONTAINMENT — resolve every symlink in the whole chain and re-check that the REAL
 *      path is still under the REAL root. This is the only barrier that survives a symlink, and a
 *      symlink is exactly how a hostile repository escapes a root: `assets/logs -> /var/log`, or a
 *      `SKILL.md` whose directory is a symlink to somewhere else entirely. String matching cannot
 *      see it; only the kernel can. That is why the security tests build real symlinks on disk.
 *
 * Barrier 3 subsumes barrier 2, and barrier 2 subsumes barrier 1 — deliberately. Defence in depth
 * here costs two string comparisons and removes a whole class of "we forgot one shape" bugs.
 */

import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { isWithin } from '@qwen-harness/policy';

import { SkillScopeError, type SkillScopeRejection } from './errors.ts';
import type { SkillFileSystem } from './fs.ts';

/** Longest path we will even consider resolving. */
export const MAX_RESOURCE_PATH_CHARS = 512;

/** A resource that PASSED every barrier. The only way to obtain one is to go through this module. */
export interface SkillResource {
  readonly skill: string;
  /** The relative path as requested (already validated). Useful for provenance/audit. */
  readonly relative: string;
  /** The canonical absolute path. Guaranteed to be inside the canonical skill root. */
  readonly path: string;
  /** The canonical skill root the path was proven to be inside. */
  readonly root: string;
}

function reject(
  skill: string,
  requested: string,
  root: string | null,
  rejection: SkillScopeRejection,
  detail: string,
): never {
  throw new SkillScopeError({ skill, requested, root, rejection, detail });
}

/**
 * Canonicalize a skill root at REGISTRATION time. Everything downstream compares against the value
 * this returns, so if the root itself is a symlink (`~/.skills -> /opt/skills`) the canonical form
 * is what containment is judged against — not the symlink path, which would make every real path
 * look like an escape.
 */
export function canonicalizeSkillRoot(fs: SkillFileSystem, dir: string, skill: string): string {
  const absolute = resolve(dir);
  if (!fs.isDirectory(absolute)) {
    reject(skill, dir, null, 'missing', 'skill root is not an existing directory');
  }
  return fs.realpath(absolute);
}

/**
 * Resolve one relative resource path inside a skill root, or throw.
 *
 * `root` MUST already be canonical (came from {@link canonicalizeSkillRoot}). `requested` is
 * UNTRUSTED: it may come from the skill's own frontmatter, from the skill body, or from a model
 * that read the body and asked to open a file.
 */
export function resolveSkillResource(
  fs: SkillFileSystem,
  args: {
    skill: string;
    /** Canonical skill root, or `null` for a rootless (dynamic/MCP) skill — which has no files. */
    root: string | null;
    requested: string;
    /** Permit resolving a directory (default: only regular files are legal resources). */
    allowDirectory?: boolean;
  },
): SkillResource {
  const { skill, root, requested } = args;

  if (root === null) {
    reject(
      skill,
      requested,
      null,
      'no-root',
      'this skill has no filesystem root (it was supplied in-memory), so it can reference no files',
    );
  }

  // ---- Barrier 1: lexical shape -------------------------------------------------------------
  if (requested === '') reject(skill, requested, root, 'empty', 'empty path');
  if (requested.length > MAX_RESOURCE_PATH_CHARS) {
    reject(
      skill,
      requested,
      root,
      'too-long',
      `path exceeds ${MAX_RESOURCE_PATH_CHARS} characters`,
    );
  }
  if (requested.includes('\0')) reject(skill, requested, root, 'nul-byte', 'path contains NUL');
  if (isAbsolute(requested) || requested.startsWith('~')) {
    reject(
      skill,
      requested,
      root,
      'absolute-path',
      'skill resources are addressed relative to the skill root; absolute paths are never accepted',
    );
  }
  if (requested.split('/').includes('..')) {
    reject(skill, requested, root, 'traversal', 'path contains a ".." segment');
  }

  // ---- Barrier 2: lexical containment after join+normalize -----------------------------------
  const joined = normalize(join(root, requested));
  if (!isWithin(root, joined)) {
    reject(skill, requested, root, 'escapes-root', `${joined} is not inside the skill root`);
  }

  // ---- Barrier 3: realpath containment (the only one a symlink cannot fool) -------------------
  let real: string;
  try {
    real = fs.realpath(joined);
  } catch {
    reject(skill, requested, root, 'missing', `${joined} does not exist`);
  }
  if (!isWithin(root, real)) {
    reject(
      skill,
      requested,
      root,
      'escapes-root',
      `resolves through a symlink to ${real}, which is outside the skill root`,
    );
  }

  if (!(args.allowDirectory === true) && !fs.isFile(real)) {
    reject(skill, requested, root, 'not-a-file', `${real} is not a regular file`);
  }

  return { skill, relative: requested, path: real, root };
}

/**
 * Prove a path that discovery itself produced is inside the root. Used for the SKILL.md file: even
 * a file WE walked to must be re-checked, because the directory entry could be a symlink pointing
 * out of the tree (a repository can ship `.qwen-harness/skills/evil/SKILL.md -> /etc/shadow`, and
 * reading that file — even just its head — is already the exfiltration).
 */
export function assertInsideRoot(root: string, canonicalPath: string, skill: string): void {
  if (!isWithin(root, canonicalPath)) {
    reject(
      skill,
      canonicalPath,
      root,
      'escapes-root',
      `${canonicalPath} is outside the canonical skill root`,
    );
  }
}

/** Exposed for tests and for `doctor`: the separator containment is judged with. */
export const PATH_SEPARATOR = sep;
