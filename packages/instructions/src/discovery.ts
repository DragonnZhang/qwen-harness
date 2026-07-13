/**
 * Repository instruction discovery (IN-06) — the I/O half.
 *
 * This is the declared I/O owner for instruction files (scripts/graph.ts: `instructions` may open
 * `node:fs` / `node:path`). It walks a directory tree, reads instruction files, and hands the raw
 * findings to the pure resolver. It reads ONLY: it never writes, and a missing file contributes
 * nothing (no source, no error) exactly like `config`'s loader — only a file it cannot read is an
 * error, and that error always names the path.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  directoryDepth,
  resolveInstructions,
  type DiscoveredInstruction,
  type InstructionScope,
  type InstructionsLoaded,
} from './resolution.ts';

/** The default instruction filename. Configurable so a deployment can add its own conventions. */
export const DEFAULT_INSTRUCTION_FILENAMES = ['AGENTS.md'] as const;

/** Directories never descended into when scanning for nested instructions. */
export const DEFAULT_IGNORE_DIRS = ['.git', 'node_modules', 'dist', '.qwen-harness'] as const;

/** Bound on how deep the nested walk descends, so a pathological tree cannot hang discovery. */
export const DEFAULT_MAX_DEPTH = 8;

export interface DiscoverOptions {
  /** Repository root. Its own instruction file is `repo-root`; subtrees are `nested`. */
  readonly repoRoot: string;
  /** Filenames to treat as instruction files. Default `['AGENTS.md']`. */
  readonly fileNames?: readonly string[];
  /** Absolute paths of global (machine/user-global) instruction files, if any. */
  readonly globalPaths?: readonly string[];
  /** Absolute paths of user-scope instruction files, if any. */
  readonly userPaths?: readonly string[];
  /** How many directories ABOVE `repoRoot` to scan for `ancestor` instructions. Default 0. */
  readonly ancestorDepth?: number;
  /** Directory names to skip while walking. Default `DEFAULT_IGNORE_DIRS`. */
  readonly ignoreDirs?: readonly string[];
  /** Maximum nested-walk depth below `repoRoot`. Default `DEFAULT_MAX_DEPTH`. */
  readonly maxDepth?: number;
}

/** A present instruction file that could not be read. Always names the path (parity with config). */
export class InstructionReadError extends Error {
  override readonly name = 'InstructionReadError';
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`instruction file ${path}: read failed (${describeCause(cause)})`, { cause });
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Read a file if it is present. A missing file yields `undefined`; any other error is thrown. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InstructionReadError(path, err);
  }
}

/** Whether a filesystem entry is a directory, treating a vanished entry as "not a directory". */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function makeDiscovered(
  path: string,
  scope: InstructionScope,
  rawText: string,
  pathScope: string | null,
): DiscoveredInstruction {
  const dir = dirname(path);
  return { path, scope, dir, depth: directoryDepth(dir), rawText, pathScope };
}

/**
 * Walk the directory tree and read every instruction file, returning raw (unranked) findings. The
 * caller (or `loadInstructions`) feeds these to `resolveInstructions` to get precedence/provenance.
 */
export function discoverInstructionFiles(options: DiscoverOptions): DiscoveredInstruction[] {
  const repoRoot = resolve(options.repoRoot);
  const fileNames = options.fileNames ?? DEFAULT_INSTRUCTION_FILENAMES;
  const ignore = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const ancestorDepth = options.ancestorDepth ?? 0;

  const found: DiscoveredInstruction[] = [];

  // Global / user: explicit paths, always-on (no path scope).
  for (const path of options.globalPaths ?? []) {
    const text = readIfPresent(resolve(path));
    if (text !== undefined) found.push(makeDiscovered(resolve(path), 'global', text, null));
  }
  for (const path of options.userPaths ?? []) {
    const text = readIfPresent(resolve(path));
    if (text !== undefined) found.push(makeDiscovered(resolve(path), 'user', text, null));
  }

  // Ancestors: directories above the repo root, always-on. Closer ancestors rank higher (greater
  // depth), which `directoryDepth` already encodes.
  let ancestor = dirname(repoRoot);
  for (let i = 0; i < ancestorDepth; i += 1) {
    if (ancestor === dirname(ancestor)) break; // reached filesystem root
    for (const name of fileNames) {
      const path = join(ancestor, name);
      const text = readIfPresent(path);
      if (text !== undefined) found.push(makeDiscovered(path, 'ancestor', text, null));
    }
    ancestor = dirname(ancestor);
  }

  // Repo root: always-on.
  for (const name of fileNames) {
    const path = join(repoRoot, name);
    const text = readIfPresent(path);
    if (text !== undefined) found.push(makeDiscovered(path, 'repo-root', text, null));
  }

  // Nested: every instruction file strictly below the repo root is path-scoped to its directory.
  walkNested(repoRoot, repoRoot, 1, maxDepth, fileNames, ignore, found);

  return found;
}

function walkNested(
  repoRoot: string,
  dir: string,
  depth: number,
  maxDepth: number,
  fileNames: readonly string[],
  ignore: ReadonlySet<string>,
  out: DiscoveredInstruction[],
): void {
  if (depth > maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an unreadable directory simply contributes nothing
  }

  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (isDirectory(full)) {
      if (ignore.has(basename(full))) continue;
      // An instruction file inside `full` governs the `full` subtree.
      for (const name of fileNames) {
        const path = join(full, name);
        const text = readIfPresent(path);
        if (text !== undefined) out.push(makeDiscovered(path, 'nested', text, full));
      }
      walkNested(repoRoot, full, depth + 1, maxDepth, fileNames, ignore, out);
    }
  }
}

/**
 * Discover, read, and resolve in one call — the InstructionsLoaded-shaped result the runtime feeds
 * to the `InstructionsLoaded` hook and to system-prompt / request assembly.
 */
export function loadInstructions(options: DiscoverOptions): InstructionsLoaded {
  return resolveInstructions(discoverInstructionFiles(options));
}
