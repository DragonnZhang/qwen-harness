/**
 * The unit of authorization: a canonical, fully-specified description of ONE side effect.
 *
 * Approval binds to a `NormalizedAction`, never to a tool name. A tool name is a label the model
 * chose; the action is what will actually happen to the host. Two calls to the same tool with
 * different paths are different actions and need different approvals, and one call routed through
 * a different tool with the same effect is the SAME action and reuses the same approval.
 *
 * Every path here is already canonical (absolute, NFC, symlinks resolved). Policy does not — and
 * must not — touch the filesystem to find that out: canonicalization is a host-I/O operation and
 * lives in `sandbox-linux`. Policy validates that the invariant HOLDS and refuses to reason about
 * an input that does not satisfy it (`assertCanonicalAction`), which turns "the caller forgot to
 * canonicalize" from a silent security hole into a deny.
 */

import { createHash } from 'node:crypto';

export const ACTION_KINDS = [
  'file-read',
  'file-write',
  'file-edit',
  'patch',
  'shell',
  'git-read',
  'git-write',
  'network',
  'mcp',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/** Kinds that change the host. `plan` makes every one of these UNAVAILABLE. */
export const MUTATION_KINDS: readonly ActionKind[] = [
  'file-write',
  'file-edit',
  'patch',
  'shell',
  'git-write',
];

/** The dedicated workspace FILE tools — the only kinds `auto-accept-edits` may auto-allow. */
export const WORKSPACE_FILE_KINDS: readonly ActionKind[] = ['file-write', 'file-edit', 'patch'];

export interface FileReadAction {
  readonly kind: 'file-read';
  /** Canonical absolute path. */
  readonly path: string;
}

export interface FileWriteAction {
  readonly kind: 'file-write';
  readonly path: string;
  /** True when the resulting file would be executable. Executable writes always ask (PS-04). */
  readonly createsExecutable: boolean;
  /** sha256 of the exact bytes to be written. Approval binds to the CONTENT, not just the path. */
  readonly contentDigest: string;
}

export interface FileEditAction {
  readonly kind: 'file-edit';
  readonly path: string;
  readonly createsExecutable: boolean;
  /** sha256 over the ordered edit operations. */
  readonly editsDigest: string;
}

export interface PatchAction {
  readonly kind: 'patch';
  /** Every canonical path the patch touches. A patch is one action over many files. */
  readonly paths: readonly string[];
  readonly createsExecutable: boolean;
  readonly patchDigest: string;
}

export interface ShellAction {
  readonly kind: 'shell';
  /** The exact command line as it will be executed. */
  readonly command: string;
  /** The parsed argv. Both are carried: policy matches on argv, humans read the command. */
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface GitReadAction {
  readonly kind: 'git-read';
  readonly repoRoot: string;
  readonly operation: 'status' | 'diff' | 'log' | 'show' | 'blame' | 'ls-files';
}

export interface GitWriteAction {
  readonly kind: 'git-write';
  readonly repoRoot: string;
  readonly operation: string;
  /** reset --hard, clean -fd, push --force, branch -D, rebase, filter-branch, ... */
  readonly destructive: boolean;
  readonly argv: readonly string[];
}

export interface NetworkAction {
  readonly kind: 'network';
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly scheme: string;
}

export interface McpAction {
  readonly kind: 'mcp';
  readonly server: string;
  readonly tool: string;
  /**
   * Whether the MCP tool mutates anything. An MCP server is UNTRUSTED metadata, so this is the
   * harness's classification of the tool, not the server's self-declaration.
   */
  readonly sideEffect: boolean;
  readonly argumentsDigest: string;
}

export type NormalizedAction =
  | FileReadAction
  | FileWriteAction
  | FileEditAction
  | PatchAction
  | ShellAction
  | GitReadAction
  | GitWriteAction
  | NetworkAction
  | McpAction;

// ---------------------------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------------------------

/** Deterministic JSON: keys sorted at every level, so the digest never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The stable identity of an action. An approval grant matches on THIS string and nothing else,
 * which is what makes "a grant for action A does not authorize action B" true by construction
 * rather than by careful comparison code at each call site.
 */
export function actionDigest(action: NormalizedAction): string {
  return createHash('sha256').update(canonicalJson(action)).digest('hex');
}

/** Every canonical path an action targets. Used by protected-path and rule matching. */
export function actionPaths(action: NormalizedAction): readonly string[] {
  switch (action.kind) {
    case 'file-read':
    case 'file-write':
    case 'file-edit':
      return [action.path];
    case 'patch':
      return action.paths;
    case 'shell':
      return [action.cwd];
    case 'git-read':
    case 'git-write':
      return [action.repoRoot];
    case 'network':
    case 'mcp':
      return [];
  }
}

/** Does the action WRITE to its paths? Some protected paths are read-protected too; see paths.ts. */
export function isWriteAction(action: NormalizedAction): boolean {
  switch (action.kind) {
    case 'file-write':
    case 'file-edit':
    case 'patch':
    case 'git-write':
      return true;
    // A shell command's declared cwd is not a write target; the command's real writes are
    // constrained by the sandbox, which is exactly why shell always asks outside `yolo`.
    case 'shell':
    case 'file-read':
    case 'git-read':
    case 'network':
    case 'mcp':
      return false;
  }
}

/** Is this a side effect (something that changes the world), as opposed to a read? */
export function isSideEffect(action: NormalizedAction): boolean {
  if (action.kind === 'mcp') return action.sideEffect;
  if (action.kind === 'network') return true;
  return MUTATION_KINDS.includes(action.kind);
}

// ---------------------------------------------------------------------------------------------
// Input validation. Policy is pure, so it cannot LOOK at the filesystem — it can only refuse
// input that has not been through the canonicalizer.
// ---------------------------------------------------------------------------------------------

export type CanonicalityFailure = { readonly path: string; readonly why: string };

const HEX64 = /^[0-9a-f]{64}$/;

function checkPath(path: string): string | null {
  if (path.length === 0) return 'empty path';
  if (!path.startsWith('/')) return 'not an absolute path';
  if (path.normalize('NFC') !== path) return 'not Unicode NFC normalized';
  if (path.includes('\0')) return 'contains a NUL byte';
  const segments = path.split('/');
  if (segments.includes('..')) return "contains a '..' segment (not canonicalized)";
  if (segments.some((s, i) => s === '.' && i > 0)) return "contains a '.' segment";
  if (path.length > 1 && path.endsWith('/')) return 'has a trailing slash';
  if (path.includes('//')) return 'contains an empty segment';
  return null;
}

/**
 * Prove the action is canonical. Returns the list of problems; an empty list means it is safe to
 * evaluate. The engine turns a non-empty list into a DENY — never into an "ask", because a
 * malformed path is a bug or an attack, and neither should be resolvable by a human clicking yes.
 */
export function checkCanonicalAction(action: NormalizedAction): readonly CanonicalityFailure[] {
  const failures: CanonicalityFailure[] = [];
  for (const path of actionPaths(action)) {
    const why = checkPath(path);
    if (why !== null) failures.push({ path, why });
  }
  if (action.kind === 'file-write' && !HEX64.test(action.contentDigest)) {
    failures.push({ path: action.path, why: 'contentDigest is not a sha256 hex digest' });
  }
  if (action.kind === 'file-edit' && !HEX64.test(action.editsDigest)) {
    failures.push({ path: action.path, why: 'editsDigest is not a sha256 hex digest' });
  }
  if (action.kind === 'patch' && !HEX64.test(action.patchDigest)) {
    failures.push({ path: action.paths[0] ?? '', why: 'patchDigest is not a sha256 hex digest' });
  }
  if (action.kind === 'patch' && action.paths.length === 0) {
    failures.push({ path: '', why: 'a patch action must name at least one path' });
  }
  if (action.kind === 'shell' && action.argv.length === 0) {
    failures.push({ path: action.cwd, why: 'a shell action must have a parsed argv' });
  }
  if (action.kind === 'network') {
    if (action.host.length === 0) failures.push({ path: action.url, why: 'network host is empty' });
    if (action.host !== action.host.toLowerCase()) {
      failures.push({ path: action.url, why: 'network host is not lowercased' });
    }
  }
  if (action.kind === 'mcp' && !HEX64.test(action.argumentsDigest)) {
    failures.push({ path: '', why: 'argumentsDigest is not a sha256 hex digest' });
  }
  return failures;
}

/** A short, human-readable rendering. This is the text an approval dialog shows and binds to. */
export function describeAction(action: NormalizedAction): string {
  switch (action.kind) {
    case 'file-read':
      return `read ${action.path}`;
    case 'file-write':
      return `write ${action.path}${action.createsExecutable ? ' (executable)' : ''}`;
    case 'file-edit':
      return `edit ${action.path}${action.createsExecutable ? ' (executable)' : ''}`;
    case 'patch':
      return `patch ${action.paths.length} file(s): ${action.paths.join(', ')}`;
    case 'shell':
      return `run \`${action.command}\` in ${action.cwd}`;
    case 'git-read':
      return `git ${action.operation} in ${action.repoRoot}`;
    case 'git-write':
      return `git ${action.operation}${action.destructive ? ' (destructive)' : ''} in ${action.repoRoot}`;
    case 'network':
      return `${action.method} ${action.url}`;
    case 'mcp':
      return `mcp ${action.server}/${action.tool}${action.sideEffect ? ' (side effect)' : ''}`;
  }
}
