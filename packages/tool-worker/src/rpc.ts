import { z } from 'zod';

/**
 * The capability-scoped RPC boundary between the runtime and the sandboxed tool worker.
 *
 * The design rule from task.md (boundary #4): *"Tool-worker RPC carries capability handles, not
 * unrestricted host paths or environments."*
 *
 * Concretely: the worker is NOT told "write to /home/user/project/a.ts". It is told "write to
 * handle `ws`, relative path `a.ts`". The worker resolves `ws` against the roots the sandbox
 * actually bound, and a relative path that escapes that root is rejected *inside* the worker,
 * after canonicalization, in a process that has no access to anything else anyway.
 *
 * Why bother, when the sandbox already confines the process? Defence in depth. The sandbox is the
 * boundary that must not be bypassed; the capability handle is the boundary that makes a bypass
 * *unrepresentable*. A confused-deputy bug in the runtime cannot ask the worker to write outside
 * the workspace, because there is no way to say it.
 */

/** A handle names a root the sandbox has bound. It carries no path — that is the entire point. */
export const CapabilityHandleSchema = z.enum([
  /** The workspace root. Writable in `workspace-write`, read-only in `read-only`. */
  'workspace',
  /** A scratch tmpfs inside the sandbox. Always writable, never persisted. */
  'scratch',
]);
export type CapabilityHandle = z.infer<typeof CapabilityHandleSchema>;

/**
 * A path expressed as (handle, relative). The runtime literally cannot express an absolute host
 * path across this boundary — the type does not permit it.
 */
export const ScopedPathSchema = z.object({
  handle: CapabilityHandleSchema,
  /** Relative to the handle's root. Validated and canonicalized INSIDE the worker. */
  relative: z.string().max(4096),
});
export type ScopedPath = z.infer<typeof ScopedPathSchema>;

/** What the worker is permitted to do, decided by policy BEFORE the worker is spawned. */
export const WorkerGrantSchema = z.object({
  /** Roots the worker may read. */
  readable: z.array(CapabilityHandleSchema),
  /** Roots the worker may write. Empty in `plan`/read-only isolation. */
  writable: z.array(CapabilityHandleSchema),
  /** May the worker execute a shell command at all? */
  shell: z.boolean(),
  /** May the worker reach the network? Denied by default in every profile except `yolo`. */
  network: z.boolean(),
  /** Hard limits, enforced by the sandbox as rlimits, not merely checked in JS. */
  limits: z.object({
    wallMs: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
  }),
});
export type WorkerGrant = z.infer<typeof WorkerGrantSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const WorkerRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), path: ScopedPathSchema, glob: z.string().nullable() }),
  z.object({
    op: z.literal('grep'),
    path: ScopedPathSchema,
    pattern: z.string().max(1000),
    maxMatches: z.number().int().positive().max(10_000),
  }),
  z.object({
    op: z.literal('read'),
    path: ScopedPathSchema,
    /** 1-based, inclusive. Paging is mandatory — a tool never returns an unbounded file. */
    offsetLine: z.number().int().nonnegative(),
    limitLines: z.number().int().positive().max(50_000),
  }),
  z.object({ op: z.literal('write'), path: ScopedPathSchema, content: z.string() }),
  z.object({
    op: z.literal('edit'),
    path: ScopedPathSchema,
    oldText: z.string(),
    newText: z.string(),
    /**
     * Digest of the file the model believed it was editing. If the file changed underneath us,
     * this will not match and the edit is REJECTED as stale (TL-04) — we never silently
     * overwrite a concurrently-changed file, because that destroys the user's work.
     */
    expectedDigest: z.string().nullable(),
  }),
  z.object({
    op: z.literal('shell'),
    command: z.string().max(10_000),
    argv: z.array(z.string().max(4096)).max(256),
    cwd: ScopedPathSchema,
  }),
  z.object({ op: z.literal('git-status'), path: ScopedPathSchema }),
  z.object({ op: z.literal('git-diff'), path: ScopedPathSchema, staged: z.boolean() }),
]);
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const WorkerErrorSchema = z.object({
  category: z.enum([
    'not-found',
    'permission-denied',
    'path-escape',
    'stale-file',
    'binary-file',
    'too-large',
    'timeout',
    'cancelled',
    'execution-failed',
    'invalid-input',
    'internal',
  ]),
  message: z.string(),
});
export type WorkerError = z.infer<typeof WorkerErrorSchema>;

export const WorkerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: WorkerErrorSchema }),
]);
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

/** One framed RPC message. Correlated so responses cannot be mismatched to requests. */
export const WorkerFrameSchema = z.object({
  id: z.string().min(1).max(64),
  body: z.union([
    z.object({
      kind: z.literal('request'),
      grant: WorkerGrantSchema,
      request: WorkerRequestSchema,
    }),
    z.object({ kind: z.literal('response'), response: WorkerResponseSchema }),
  ]),
});
export type WorkerFrame = z.infer<typeof WorkerFrameSchema>;
