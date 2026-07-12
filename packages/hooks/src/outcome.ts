/**
 * Typed hook outcomes (HK-03).
 *
 * A hook does not "return true/false". It returns one of a closed set of intentions, each carrying
 * a typed reason. The set is deliberately shaped so that the security invariants are true BY
 * CONSTRUCTION rather than by careful checking downstream:
 *
 *   - There is an `allow` / `passthrough` variant so a hook CAN express "I'd allow this" — but the
 *     engine records it and ignores it. A hook may only ever RESTRICT a permission (deny / ask),
 *     never loosen one (HK-04). Making `allow` expressible-but-inert is how the fold proves it.
 *   - `context` carries UNTRUSTED text; it is sanitized and attributed before anything uses it.
 *   - `modify` PROPOSES a new tool input; it is never applied directly — the caller must
 *     re-validate it against the schema and policy (HK-04).
 *   - `block` stops the action; `stop` prevents continuation. They are different: a PostToolUse
 *     hook may `stop` the loop without corrupting the completed tool result (HK-05).
 *
 * Command and HTTP hooks emit this shape as JSON. That JSON is UNTRUSTED, so it crosses a zod
 * schema (`HookOutcomeSchema`) at the boundary; a shape we do not recognise is a visible failure,
 * never a silent allow.
 */
import { z } from 'zod';

/** A machine-readable code plus a human message. Never a bare string — a reason must be typed. */
export interface HookReason {
  readonly code: string;
  readonly message: string;
}

/** MCP output annotation (HK-03: "annotate MCP output"). */
export interface McpAnnotation {
  readonly key: string;
  readonly value: string;
}

/**
 * `reason` may arrive as a bare string (convenience for command hooks) or as `{code,message}`.
 * Both normalise to a typed `HookReason`.
 */
const HookReasonSchema = z.union([
  z
    .string()
    .max(4000)
    .transform((message) => ({ code: 'hook', message })),
  z.object({ code: z.string().min(1).max(120), message: z.string().max(4000) }),
]);

const DEFAULT_REASON = { code: 'hook', message: '' } as const;

const McpAnnotationSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(4000),
});

/**
 * The wire/domain schema for a single hook outcome. Used to parse the UNTRUSTED JSON a command or
 * HTTP hook prints, and re-used as the source of truth for the `HookOutcome` TS type so the two
 * can never drift.
 */
export const HookOutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('continue') }),
  z.object({ type: z.literal('block'), reason: HookReasonSchema.default(DEFAULT_REASON) }),
  z.object({ type: z.literal('context'), text: z.string().max(100_000) }),
  z.object({
    type: z.literal('modify'),
    toolInput: z.record(z.string(), z.unknown()),
  }),
  // Permission opinions. `allow`/`passthrough` are expressible but INERT in the fold (HK-04).
  z.object({ type: z.literal('allow'), reason: HookReasonSchema.default(DEFAULT_REASON) }),
  z.object({ type: z.literal('passthrough'), reason: HookReasonSchema.default(DEFAULT_REASON) }),
  z.object({ type: z.literal('deny'), reason: HookReasonSchema.default(DEFAULT_REASON) }),
  z.object({ type: z.literal('ask'), reason: HookReasonSchema.default(DEFAULT_REASON) }),
  z.object({ type: z.literal('stop'), reason: HookReasonSchema.default(DEFAULT_REASON) }),
  z.object({ type: z.literal('annotate'), annotations: z.array(McpAnnotationSchema).max(100) }),
]);

/** The discriminated union of everything a hook may return. */
export type HookOutcome = z.infer<typeof HookOutcomeSchema>;

export type HookOutcomeType = HookOutcome['type'];

/** The permission-bearing outcome types. Kept in one place so the fold logic stays honest. */
export const PERMISSION_OUTCOME_TYPES = ['allow', 'passthrough', 'deny', 'ask'] as const;

export type ParseResult =
  | { readonly ok: true; readonly outcome: HookOutcome }
  | { readonly ok: false; readonly error: string };

/**
 * Parse UNTRUSTED hook output into a typed outcome. A malformed shape is returned as an error the
 * engine surfaces as a visible failure — the one thing it must never become is a silent `continue`
 * that the caller mistakes for "the hook approved".
 */
export function parseHookOutcome(raw: unknown): ParseResult {
  const parsed = HookOutcomeSchema.safeParse(raw);
  if (parsed.success) return { ok: true, outcome: parsed.data };
  const error = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return { ok: false, error };
}

/**
 * Ergonomic constructors for in-process (function) handlers and tests. They produce exactly the
 * same shape `parseHookOutcome` yields, so both paths fold identically.
 */
export const HookOutcomes = {
  continue: (): HookOutcome => ({ type: 'continue' }),
  block: (code: string, message: string): HookOutcome => ({
    type: 'block',
    reason: { code, message },
  }),
  context: (text: string): HookOutcome => ({ type: 'context', text }),
  modify: (toolInput: Record<string, unknown>): HookOutcome => ({ type: 'modify', toolInput }),
  allow: (message = ''): HookOutcome => ({ type: 'allow', reason: { code: 'hook', message } }),
  passthrough: (message = ''): HookOutcome => ({
    type: 'passthrough',
    reason: { code: 'hook', message },
  }),
  deny: (code: string, message: string): HookOutcome => ({
    type: 'deny',
    reason: { code, message },
  }),
  ask: (code: string, message: string): HookOutcome => ({ type: 'ask', reason: { code, message } }),
  stop: (code: string, message: string): HookOutcome => ({
    type: 'stop',
    reason: { code, message },
  }),
  annotate: (annotations: readonly McpAnnotation[]): HookOutcome => ({
    type: 'annotate',
    annotations: [...annotations],
  }),
} as const;
