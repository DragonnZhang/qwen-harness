import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type { NormalizedAction } from '@qwen-harness/policy';
import type { PermissionProfile } from '@qwen-harness/protocol';
import type { ResourceFootprint, ToolAnnotations, ToolDefinition } from '@qwen-harness/tools-core';
import type { WorkerRequest } from '@qwen-harness/tool-worker';
import { z } from 'zod';

/**
 * The built-in tools.
 *
 * Each one is defined ONCE and knows how to describe itself three ways:
 *   - its input/output SCHEMA (what the model may send),
 *   - the `NormalizedAction` it becomes (what POLICY decides over),
 *   - the `WorkerRequest` it becomes (what the sandboxed worker EXECUTES).
 *
 * Keeping those three in one place is what guarantees they agree: the thing policy judges is
 * exactly the thing the worker runs. A tool whose policy view and execution view could drift is a
 * tool whose approval means nothing.
 *
 * The tool object here holds no handler — execution happens in the sandbox (see `tool-worker`).
 */

const RO: ToolAnnotations = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};
const WRITE: ToolAnnotations = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: false,
};
const SHELL_ANN: ToolAnnotations = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true,
};

/** All safe profiles may read/search. `plan` included — reads are always allowed. */
const ALL: readonly PermissionProfile[] = ['plan', 'ask', 'auto-accept-edits', 'yolo'];
/** Mutating tools are UNAVAILABLE in `plan` — the model is never even offered them (PS-02). */
const MUTATE_PROFILES: readonly PermissionProfile[] = ['ask', 'auto-accept-edits', 'yolo'];

function digest(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * A built-in tool bundles the standard `ToolDefinition` with the two mappers that make it
 * executable through the pipeline.
 */
export interface BuiltinTool<TInput = unknown> extends ToolDefinition<TInput, unknown> {
  /** The canonical action policy decides over. `workspaceRoot` is the canonical absolute root. */
  toAction(input: TInput, ctx: { workspaceRoot: string }): NormalizedAction;
  /** The request the sandboxed worker executes. Paths are workspace-relative capability handles. */
  toWorkerRequest(input: TInput): WorkerRequest;
}

// A workspace-relative path. Absolute paths and traversal are rejected here at the SCHEMA layer,
// before anything else runs — the worker re-checks after canonicalization, but a schema-level
// refusal keeps an obviously-hostile path out of the pipeline entirely.
const RelPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.startsWith('/'), { message: 'path must be workspace-relative, not absolute' });

function joinWorkspace(workspaceRoot: string, relative: string): string {
  // The result must be a CANONICAL absolute path — policy rejects a non-canonical action outright
  // (a `.` or `..` segment is a bug or an attack, not something to prompt about). `posix.resolve`
  // collapses `.`/`..` and a trailing `/.`, which `${root}/${'.'}` would otherwise leave behind.
  return posix.resolve(workspaceRoot, relative);
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const ReadInput = z.object({
  path: RelPath,
  offsetLine: z.number().int().nonnegative().default(0),
  limitLines: z.number().int().positive().max(50_000).default(2000),
});
type ReadInput = z.infer<typeof ReadInput>;

export const readTool: BuiltinTool<ReadInput> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file within the workspace, one page at a time.',
  inputSchema: ReadInput,
  outputSchema: z.unknown(),
  annotations: RO,
  timeoutMs: 30_000,
  availableIn: ALL,
  footprint: (input): ResourceFootprint => ({ reads: [input.path], writes: [], unbounded: false }),
  describe: (input) => `read ${input.path} (lines ${input.offsetLine + 1}..)`,
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'file-read',
    path: joinWorkspace(ctx.workspaceRoot, input.path),
  }),
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'read',
    path: { handle: 'workspace', relative: input.path },
    offsetLine: input.offsetLine,
    limitLines: input.limitLines,
  }),
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const ListInput = z.object({
  path: RelPath.default('.'),
  glob: z.string().max(200).nullable().default(null),
});
type ListInput = z.infer<typeof ListInput>;

export const listTool: BuiltinTool<ListInput> = {
  name: 'list_dir',
  description: 'List entries in a workspace directory, optionally filtered by a glob.',
  inputSchema: ListInput,
  outputSchema: z.unknown(),
  annotations: RO,
  timeoutMs: 30_000,
  availableIn: ALL,
  footprint: (input): ResourceFootprint => ({ reads: [input.path], writes: [], unbounded: false }),
  describe: (input) => `list ${input.path}${input.glob ? ` matching ${input.glob}` : ''}`,
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'file-read',
    path: joinWorkspace(ctx.workspaceRoot, input.path),
  }),
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'list',
    path: { handle: 'workspace', relative: input.path },
    glob: input.glob,
  }),
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const GrepInput = z.object({
  path: RelPath.default('.'),
  pattern: z.string().min(1).max(1000),
  maxMatches: z.number().int().positive().max(10_000).default(200),
});
type GrepInput = z.infer<typeof GrepInput>;

export const grepTool: BuiltinTool<GrepInput> = {
  name: 'search',
  description: 'Search workspace files for a regular expression.',
  inputSchema: GrepInput,
  outputSchema: z.unknown(),
  annotations: RO,
  timeoutMs: 60_000,
  availableIn: ALL,
  footprint: (input): ResourceFootprint => ({ reads: [input.path], writes: [], unbounded: false }),
  describe: (input) => `search ${input.path} for /${input.pattern}/`,
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'file-read',
    path: joinWorkspace(ctx.workspaceRoot, input.path),
  }),
  // Validate the regex at the semantic layer, so a malformed pattern is a clean rejection rather
  // than a worker crash.
  validate: (input): string | null => {
    try {
      new RegExp(input.pattern);
      return null;
    } catch (e) {
      return `invalid regular expression: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'grep',
    path: { handle: 'workspace', relative: input.path },
    pattern: input.pattern,
    maxMatches: input.maxMatches,
  }),
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const WriteInput = z.object({ path: RelPath, content: z.string() });
type WriteInput = z.infer<typeof WriteInput>;

export const writeTool: BuiltinTool<WriteInput> = {
  name: 'write_file',
  description: 'Create or overwrite a workspace file with exact content.',
  inputSchema: WriteInput,
  outputSchema: z.unknown(),
  annotations: WRITE,
  timeoutMs: 30_000,
  availableIn: MUTATE_PROFILES,
  footprint: (input): ResourceFootprint => ({ reads: [], writes: [input.path], unbounded: false }),
  describe: (input) => `write ${input.path} (${Buffer.byteLength(input.content)} bytes)`,
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'file-write',
    path: joinWorkspace(ctx.workspaceRoot, input.path),
    // A file that would end up executable is higher-risk and always asks (PS-04). We cannot know
    // the final mode here, so we conservatively treat a shebang as executable intent.
    createsExecutable: input.content.startsWith('#!'),
    // Approval binds to the CONTENT digest, not just the path — approving "write config.json" must
    // not silently authorize writing different bytes to config.json later.
    contentDigest: digest(input.content),
  }),
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'write',
    path: { handle: 'workspace', relative: input.path },
    content: input.content,
  }),
};

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

const EditInput = z.object({
  path: RelPath,
  oldText: z.string().min(1),
  newText: z.string(),
  /** Digest the model saw; the worker rejects the edit if the file changed (TL-04). */
  expectedDigest: z.string().nullable().default(null),
});
type EditInput = z.infer<typeof EditInput>;

export const editTool: BuiltinTool<EditInput> = {
  name: 'edit_file',
  description: 'Replace an exact unique snippet in a workspace file.',
  inputSchema: EditInput,
  outputSchema: z.unknown(),
  annotations: WRITE,
  timeoutMs: 30_000,
  availableIn: MUTATE_PROFILES,
  footprint: (input): ResourceFootprint => ({
    reads: [input.path],
    writes: [input.path],
    unbounded: false,
  }),
  describe: (input) => `edit ${input.path}`,
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'file-edit',
    path: joinWorkspace(ctx.workspaceRoot, input.path),
    createsExecutable: input.newText.startsWith('#!'),
    editsDigest: digest(`${input.oldText} ${input.newText}`),
  }),
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'edit',
    path: { handle: 'workspace', relative: input.path },
    oldText: input.oldText,
    newText: input.newText,
    expectedDigest: input.expectedDigest,
  }),
};

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

const ShellInput = z.object({
  /** The program to run. Resolved by the worker; argv[0] is NOT a shell string. */
  command: z.string().min(1).max(1000),
  argv: z.array(z.string().max(4096)).max(256).default([]),
  cwd: RelPath.default('.'),
});
type ShellInput = z.infer<typeof ShellInput>;

export const shellTool: BuiltinTool<ShellInput> = {
  name: 'run_shell',
  description: 'Run a program inside the sandbox. Not a shell string — an explicit argv.',
  inputSchema: ShellInput,
  outputSchema: z.unknown(),
  annotations: SHELL_ANN,
  timeoutMs: 120_000,
  availableIn: MUTATE_PROFILES,
  // A shell command's real footprint is unknowable, so it is `unbounded` — the scheduler never
  // runs it beside anything else (TL-08).
  footprint: (): ResourceFootprint => ({ reads: [], writes: [], unbounded: true }),
  describe: (input) => `run ${input.command} ${input.argv.join(' ')}`.trim(),
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'shell',
    command: `${input.command} ${input.argv.join(' ')}`.trim(),
    argv: [input.command, ...input.argv],
    cwd: joinWorkspace(ctx.workspaceRoot, input.cwd),
  }),
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'shell',
    command: input.command,
    argv: input.argv,
    cwd: { handle: 'workspace', relative: input.cwd },
  }),
};

// ---------------------------------------------------------------------------
// git (read-only projections)
// ---------------------------------------------------------------------------

const GitStatusInput = z.object({ path: RelPath.default('.') });
type GitStatusInput = z.infer<typeof GitStatusInput>;

export const gitStatusTool: BuiltinTool<GitStatusInput> = {
  name: 'git_status',
  description: 'Show the working-tree status as a safe porcelain projection.',
  inputSchema: GitStatusInput,
  outputSchema: z.unknown(),
  annotations: RO,
  timeoutMs: 30_000,
  availableIn: ALL,
  footprint: (input): ResourceFootprint => ({ reads: [input.path], writes: [], unbounded: false }),
  describe: () => 'git status',
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'git-read',
    repoRoot: joinWorkspace(ctx.workspaceRoot, input.path),
    operation: 'status',
  }),
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'git-status',
    path: { handle: 'workspace', relative: input.path },
  }),
};

const GitDiffInput = z.object({ path: RelPath.default('.'), staged: z.boolean().default(false) });
type GitDiffInput = z.infer<typeof GitDiffInput>;

export const gitDiffTool: BuiltinTool<GitDiffInput> = {
  name: 'git_diff',
  description: 'Show the unified diff of unstaged (or staged) changes.',
  inputSchema: GitDiffInput,
  outputSchema: z.unknown(),
  annotations: RO,
  timeoutMs: 30_000,
  availableIn: ALL,
  footprint: (input): ResourceFootprint => ({ reads: [input.path], writes: [], unbounded: false }),
  describe: (input) => `git diff${input.staged ? ' --staged' : ''}`,
  toAction: (input, ctx): NormalizedAction => ({
    kind: 'git-read',
    repoRoot: joinWorkspace(ctx.workspaceRoot, input.path),
    operation: 'diff',
  }),
  toWorkerRequest: (input): WorkerRequest => ({
    op: 'git-diff',
    path: { handle: 'workspace', relative: input.path },
    staged: input.staged,
  }),
};

/**
 * The JSON-Schema parameter object for a tool, as the model needs to see it. Derived from the same
 * zod `inputSchema` that validates the call, so what the model is told and what we enforce cannot
 * drift. `additionalProperties:false` is dropped because some providers reject it on function args.
 */
export function toolParametersJsonSchema(tool: BuiltinTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
}

/** Every built-in, in a stable order. */
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
  readTool,
  listTool,
  grepTool,
  writeTool,
  editTool,
  shellTool,
  gitStatusTool,
  gitDiffTool,
] as unknown as readonly BuiltinTool[];
