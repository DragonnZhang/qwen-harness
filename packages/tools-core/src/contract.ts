import type { PermissionProfile, ToolCallId } from '@qwen-harness/protocol';
import { z } from 'zod';

/**
 * The tool contract.
 *
 * A tool is split deliberately into a CLIENT contract (name, schemas, annotations, concurrency
 * metadata — pure data, safe to hold in the runtime process) and a WORKER handler (the code that
 * actually touches the host). The runtime process holds only the former.
 *
 * That split is the whole architecture: it is why a main-process `fs` call cannot implement a
 * model tool. There is nowhere in the runtime to put one — the handler type does not exist there.
 */

/**
 * Behavioral annotations. These are declarations the SCHEDULER and the POLICY engine act on, not
 * documentation. `destructive` and `readOnly` decide whether a call may run in a parallel batch;
 * `openWorld` decides whether it can reach outside the workspace.
 *
 * MCP servers declare the same annotations, and they feed the same pipeline (MC-04) — an MCP tool
 * gets no privileged path.
 */
export const ToolAnnotationsSchema = z.object({
  /** Makes no change to any state. Safe to run in parallel with other reads.  */
  readOnly: z.boolean(),
  /** May irreversibly change or remove existing state. Never auto-parallelized. */
  destructive: z.boolean(),
  /** Running it twice with the same input has the same effect as running it once. */
  idempotent: z.boolean(),
  /** May interact with entities outside the workspace (network, external paths). */
  openWorld: z.boolean(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

/**
 * What a call will touch. The SCHEDULER derives batches from THIS, not from the tool's name —
 * two `write_file` calls to *different* paths are safely parallel, and a `read_file` of a path
 * another call is writing is NOT (TL-08).
 */
export interface ResourceFootprint {
  /** Canonical absolute paths this call reads. */
  readonly reads: readonly string[];
  /** Canonical absolute paths this call writes. */
  readonly writes: readonly string[];
  /** True if the call's effects are not confined to `reads`/`writes` (e.g. an arbitrary shell command). */
  readonly unbounded: boolean;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly annotations: ToolAnnotations;

  /** Hard upper bound. A tool that does not finish is cancelled, never left hanging. */
  readonly timeoutMs: number;

  /** Which profiles may even *offer* this tool. `plan` sees no mutating tool at all (PS-02). */
  readonly availableIn: readonly PermissionProfile[];

  /**
   * Semantic validation beyond the schema. The schema proves the shape; this proves the MEANING —
   * e.g. "the line range is within the file", "the patch's expected hash still matches".
   * Returning a string rejects the call with that reason.
   */
  validate?(input: TInput): string | null;

  /** What this specific call will touch, derived from its ACTUAL arguments. */
  footprint(input: TInput): ResourceFootprint;

  /** A human-readable, fully-specified description of the effect. Approval binds to this. */
  describe(input: TInput): string;
}

// ---------------------------------------------------------------------------
// Results (TL-12): one stable shape, machine-readable, with provenance.
// ---------------------------------------------------------------------------

export const ToolErrorCategorySchema = z.enum([
  'invalid-input',
  'semantic-invalid',
  'not-found',
  'permission-denied',
  'policy-denied',
  'sandbox-denied',
  'stale-file',
  'binary-file',
  'too-large',
  'timeout',
  'cancelled',
  'execution-failed',
  'unsupported',
  'internal',
]);
export type ToolErrorCategory = z.infer<typeof ToolErrorCategorySchema>;

export interface ToolResult<TOutput = unknown> {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly ok: boolean;
  readonly output: TOutput | null;
  readonly error: { category: ToolErrorCategory; message: string } | null;

  /**
   * Two different renderings on purpose.
   *
   * `userText` may be long and is shown in the TUI. `modelText` is BOUNDED and is what goes back
   * into the context window — an unbounded tool result is the fastest way to destroy a context
   * budget, and truncating it at render time would mean the model saw something the user did not.
   */
  readonly userText: string;
  readonly modelText: string;

  /** Set when the full output was offloaded; `modelText` then carries a bounded preview (TL-10). */
  readonly outputRef: string | null;
  readonly truncated: boolean;

  readonly durationMs: number;
  /** Which sandbox/worker produced this. Part of the audit identity (SC-03). */
  readonly provenance: string;
}
