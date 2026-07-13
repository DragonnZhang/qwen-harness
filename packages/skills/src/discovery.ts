/**
 * Skill discovery: the ten sources (IN-03), read with BOUNDED metadata reads (IN-01).
 *
 * Layout, per source directory `D`:
 *
 *   skill directories   D/<name>/SKILL.md      — the normal case. `<name>` IS the skill's identity:
 *                                                the frontmatter `name` must equal the directory
 *                                                name, or the skill is rejected. That equality is a
 *                                                security property, not tidiness — without it, a
 *                                                file dropped anywhere on the search path could
 *                                                claim to be `deploy-prod` and shadow the real one.
 *   legacy commands     D/<name>.md            — the legacy command format (IN-03). Frontmatter is
 *                                                OPTIONAL here (legacy files are plain Markdown);
 *                                                when present it is validated exactly as strictly.
 *
 * Only the HEAD of each file is read (`readHead`, 8 KiB by default): enough for frontmatter, never
 * the body. That is what makes IN-01 true at the I/O layer rather than merely in the type system —
 * scanning a directory of skills cannot pull their bodies into memory even accidentally.
 *
 * NOTHING is silently ignored. A malformed skill produces a `SkillFrontmatterError` in `errors`,
 * which is part of the result. A caller that ignores that array is choosing to; the package never
 * chooses for it.
 */

import { basename, join, resolve } from 'node:path';

import { PROJECT_CONFIG_DIR } from '@qwen-harness/config';

import type { SkillDescriptor } from './descriptor.ts';
import { SkillFrontmatterError, SkillScopeError } from './errors.ts';
import {
  parseSkillDocument,
  splitFrontmatter,
  validateSkillFrontmatter,
  type SkillFrontmatter,
} from './frontmatter.ts';
import { DEFAULT_HEAD_BYTES, type SkillFileSystem } from './fs.ts';
import { assertInsideRoot, canonicalizeSkillRoot } from './scope.ts';
import type { SkillSource } from './sources.ts';

/** The canonical skill document name. */
export const SKILL_FILE = 'SKILL.md';

/** How a directory on the search path is laid out. */
export type SkillDirectoryLayout = 'skill-dirs' | 'legacy-commands';

export interface SkillSourceDir {
  readonly source: SkillSource;
  readonly dir: string;
  readonly layout: SkillDirectoryLayout;
  /** Plugin name / MCP server name, for provenance. */
  readonly provider?: string;
}

export interface DiscoverSkillsOptions {
  readonly fs: SkillFileSystem;
  readonly sources: readonly SkillSourceDir[];
  /** Bound on the metadata read. Frontmatter beyond this is an error, never a partial parse. */
  readonly headBytes?: number;
}

export interface SkillDiscovery {
  readonly skills: readonly SkillDescriptor[];
  /** Every file that looked like a skill and could not be trusted. Surfaced, never dropped. */
  readonly errors: readonly (SkillFrontmatterError | SkillScopeError)[];
}

/**
 * The default search path, composed from the project layout `packages/config` owns.
 *
 * `managed` first because it is the immutable ceiling; `bundled` last because it is the floor.
 * Every directory is optional: a directory that does not exist contributes nothing and is not an
 * error (parity with config's loader — absence is absence, only an unreadable PRESENT file is a
 * failure).
 */
export function defaultSkillSourceDirs(args: {
  /** e.g. `/etc/qwen-harness` */
  readonly managedDir?: string;
  /** e.g. `~/.config/qwen-harness` */
  readonly userConfigDir?: string;
  readonly repoRoot?: string;
  /** Session-added directories (`--add-dir`-style). */
  readonly additionalDirs?: readonly string[];
  /** Directories that ship with the harness. */
  readonly bundledDir?: string;
  readonly pluginDirs?: readonly { readonly name: string; readonly dir: string }[];
  /** The project config dir name. Defaults to the constant `packages/config` owns. */
  readonly projectConfigDir?: string;
}): SkillSourceDir[] {
  const projectConfigDir = args.projectConfigDir ?? PROJECT_CONFIG_DIR;
  const dirs: SkillSourceDir[] = [];

  if (args.managedDir !== undefined) {
    dirs.push({ source: 'managed', dir: join(args.managedDir, 'skills'), layout: 'skill-dirs' });
  }
  if (args.repoRoot !== undefined) {
    const base = join(args.repoRoot, projectConfigDir);
    dirs.push({ source: 'project', dir: join(base, 'skills'), layout: 'skill-dirs' });
    dirs.push({ source: 'legacy-command', dir: join(base, 'commands'), layout: 'legacy-commands' });
  }
  for (const dir of args.additionalDirs ?? []) {
    dirs.push({ source: 'additional-directory', dir, layout: 'skill-dirs' });
  }
  if (args.userConfigDir !== undefined) {
    dirs.push({ source: 'user', dir: join(args.userConfigDir, 'skills'), layout: 'skill-dirs' });
  }
  for (const plugin of args.pluginDirs ?? []) {
    dirs.push({
      source: 'plugin',
      dir: join(plugin.dir, 'skills'),
      layout: 'skill-dirs',
      provider: plugin.name,
    });
  }
  if (args.bundledDir !== undefined) {
    dirs.push({ source: 'bundled', dir: args.bundledDir, layout: 'skill-dirs' });
  }

  return dirs;
}

/** Discover every skill on the search path. Never throws for a bad skill; collects and reports. */
export function discoverSkills(options: DiscoverSkillsOptions): SkillDiscovery {
  const fs = options.fs;
  const headBytes = options.headBytes ?? DEFAULT_HEAD_BYTES;
  const skills: SkillDescriptor[] = [];
  const errors: (SkillFrontmatterError | SkillScopeError)[] = [];

  for (const source of options.sources) {
    const dir = resolve(source.dir);
    if (!fs.isDirectory(dir)) continue;

    if (source.layout === 'skill-dirs') {
      for (const entry of fs.listEntries(dir)) {
        const skillDir = join(dir, entry);
        if (!fs.isDirectory(skillDir)) continue;
        const result = readSkillDir(fs, source, skillDir, entry, headBytes);
        if (result instanceof Error) errors.push(result);
        else if (result !== null) skills.push(result);
      }
      continue;
    }

    for (const entry of fs.listEntries(dir)) {
      if (!entry.endsWith('.md')) continue;
      const file = join(dir, entry);
      if (!fs.isFile(file)) continue;
      const result = readLegacyCommand(fs, source, dir, file, headBytes);
      if (result instanceof Error) errors.push(result);
      else skills.push(result);
    }
  }

  return { skills, errors };
}

/**
 * Read ONE skill directory's metadata.
 *
 * The root is canonicalized (realpath) and the SKILL.md is then re-checked to be inside it, so a
 * `SKILL.md` that is a symlink to `/etc/shadow` is refused BEFORE its head is read — the read
 * itself would already be the exfiltration.
 */
function readSkillDir(
  fs: SkillFileSystem,
  source: SkillSourceDir,
  skillDir: string,
  dirName: string,
  headBytes: number,
): SkillDescriptor | SkillFrontmatterError | SkillScopeError | null {
  const file = join(skillDir, SKILL_FILE);
  if (!fs.isFile(file)) return null;

  let root: string;
  let realFile: string;
  try {
    root = canonicalizeSkillRoot(fs, skillDir, dirName);
    realFile = fs.realpath(file);
    assertInsideRoot(root, realFile, dirName);
  } catch (err) {
    return err instanceof SkillScopeError
      ? err
      : new SkillFrontmatterError(file, `could not canonicalize skill root: ${String(err)}`);
  }

  const head = fs.readHead(realFile, headBytes);
  if (head === undefined) return null;

  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = parseHead(head, realFile, headBytes, true);
  } catch (err) {
    return err instanceof SkillFrontmatterError
      ? err
      : new SkillFrontmatterError(realFile, String(err));
  }

  if (frontmatter.name !== dirName) {
    return new SkillFrontmatterError(
      realFile,
      `frontmatter name "${frontmatter.name}" does not match its directory "${dirName}"; a skill's directory IS its identity`,
      { field: 'name' },
    );
  }

  return {
    name: frontmatter.name,
    source: source.source,
    frontmatter,
    origin: { kind: 'file', root, file: realFile },
    provider: source.provider ?? null,
  };
}

/**
 * Legacy commands (IN-03) are plain Markdown files with no frontmatter requirement. We synthesize a
 * minimal descriptor: name from the file stem, description from the first non-empty body line. They
 * are user-invocable by definition (a command is a thing a user types) and always inline — a legacy
 * file cannot opt into forking, extra tools, or hooks, because it has no validated place to say so.
 */
function readLegacyCommand(
  fs: SkillFileSystem,
  source: SkillSourceDir,
  dir: string,
  file: string,
  headBytes: number,
): SkillDescriptor | SkillFrontmatterError | SkillScopeError {
  let root: string;
  let realFile: string;
  try {
    root = canonicalizeSkillRoot(fs, dir, basename(file, '.md'));
    realFile = fs.realpath(file);
    assertInsideRoot(root, realFile, basename(file, '.md'));
  } catch (err) {
    return err instanceof SkillScopeError
      ? err
      : new SkillFrontmatterError(file, `could not canonicalize command root: ${String(err)}`);
  }

  const stem = basename(realFile, '.md');
  const head = fs.readHead(realFile, headBytes) ?? '';

  try {
    const split = splitFrontmatter(head, realFile, false);
    if (split.yaml !== null) {
      const frontmatter = parseHead(head, realFile, headBytes, true);
      if (frontmatter.name !== stem) {
        return new SkillFrontmatterError(
          realFile,
          `frontmatter name "${frontmatter.name}" does not match its file "${stem}.md"`,
          { field: 'name' },
        );
      }
      return {
        name: stem,
        source: source.source,
        frontmatter,
        origin: { kind: 'file', root, file: realFile },
        provider: source.provider ?? null,
      };
    }

    const description = firstLine(split.body) ?? `Legacy command ${stem}.`;
    const frontmatter = validateSkillFrontmatter(
      { name: stem, description, 'user-invocable': true },
      realFile,
    );
    return {
      name: stem,
      source: source.source,
      frontmatter,
      origin: { kind: 'file', root, file: realFile },
      provider: source.provider ?? null,
    };
  } catch (err) {
    return err instanceof SkillFrontmatterError
      ? err
      : new SkillFrontmatterError(realFile, String(err));
  }
}

/** The first non-empty, non-heading line, bounded — a legacy command's synthesized description. */
function firstLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim().replace(/^#+\s*/, '');
    if (trimmed !== '') return trimmed.slice(0, 200);
  }
  return null;
}

/**
 * Parse frontmatter from a bounded HEAD read. If the closing fence is not inside the head, the
 * frontmatter is over-long: that is an ERROR naming the file, never a truncated parse. A partially
 * parsed frontmatter is the worst possible outcome — it is a skill the user believes is configured
 * one way and the runtime believes is configured another.
 */
function parseHead(
  head: string,
  file: string,
  headBytes: number,
  requireFence: boolean,
): SkillFrontmatter {
  const fences = head.split('\n').filter((line) => line.trim() === '---').length;
  if (fences < 2) {
    throw new SkillFrontmatterError(
      file,
      `frontmatter is not closed within the first ${headBytes} bytes of the file`,
    );
  }
  return parseSkillDocument(head, file, { requireFence }).frontmatter;
}

/**
 * Build a descriptor for a DYNAMIC, MCP, or PLUGIN-supplied in-memory skill (IN-03). The content
 * arrives over an API or a wire, so it is validated by the very same strict schema as a file — and
 * it gets NO filesystem root, so it can reference no local file at all.
 */
export function inMemorySkill(args: {
  readonly source: Extract<SkillSource, 'dynamic' | 'mcp' | 'conditional' | 'plugin'>;
  readonly frontmatter: unknown;
  readonly body: string;
  readonly provider?: string;
  /** A label used in error messages, e.g. the MCP server name. */
  readonly label?: string;
}): SkillDescriptor {
  const label = args.label ?? `${args.source}:skill`;
  const frontmatter = validateSkillFrontmatter(args.frontmatter, label);
  return {
    name: frontmatter.name,
    source: args.source,
    frontmatter,
    origin: { kind: 'memory', body: args.body },
    provider: args.provider ?? null,
  };
}
