import { z } from 'zod';

import {
  ActorSchema,
  ItemSchema,
  PermissionProfileSchema,
  SCHEMA_VERSION,
  TerminationReasonSchema,
  TurnStateSchema,
} from './domain.ts';
import {
  CausationIdSchema,
  CorrelationIdSchema,
  EventIdSchema,
  ItemIdSchema,
  SideEffectIdSchema,
  ThreadIdSchema,
  ProviderCallIdSchema,
  TurnIdSchema,
} from './ids.ts';

/**
 * Every event carries the full envelope required by task.md:
 * schema version, monotonic sequence, thread/turn/item IDs, actor, causation/correlation IDs,
 * permission profile, redacted payload, timestamp.
 *
 * The envelope is not optional metadata — it is what makes the log auditable and replayable.
 */
export const EventEnvelopeSchema = z.object({
  id: EventIdSchema,
  schemaVersion: z.number().int().positive(),
  /** Monotonic within a thread. The event store assigns it inside the write transaction. */
  seq: z.number().int().nonnegative(),
  timestamp: z.number().int(),
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema.nullable(),
  itemId: ItemIdSchema.nullable(),
  actor: ActorSchema,
  /** Groups everything caused by one user intent, across subagents/teams/background. */
  correlationId: CorrelationIdSchema,
  /** The specific event that directly caused this one. */
  causationId: CausationIdSchema.nullable(),
  permissionProfile: PermissionProfileSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Side-effect lifecycle (SS-05, and the "never replay a known-complete action" invariant)
// ---------------------------------------------------------------------------

/**
 * The four states recovery MUST be able to distinguish (task.md, "Core domain invariants").
 *
 * `indeterminate` is the important one: we persisted intent and started, but crashed before we
 * knew the outcome. A destructive indeterminate action is NEVER replayed automatically — it
 * requires inspection or approval.
 */
export const SideEffectStateSchema = z.enum([
  'not-started',
  'in-flight',
  'known-complete',
  'known-failed',
  'indeterminate',
]);
export type SideEffectState = z.infer<typeof SideEffectStateSchema>;

export const SideEffectIntentSchema = z.object({
  sideEffectId: SideEffectIdSchema,
  /** Stable hash of the canonical action. Two identical intents share it, so replay is detectable. */
  idempotencyKey: z.string().min(1),
  kind: z.enum(['file-write', 'file-edit', 'patch', 'shell', 'git', 'network', 'mcp', 'other']),
  destructive: z.boolean(),
  normalizedAction: z.string(),
});
export type SideEffectIntent = z.infer<typeof SideEffectIntentSchema>;

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

// `T extends string` (not plain `string`) is load-bearing: it preserves the literal type so the
// union below actually discriminates. With a widened `string`, every payload would collapse into
// one shape and `payload.type === 'turn-ended'` would not narrow.
const payload = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

export const EventPayloadSchema = z.discriminatedUnion('type', [
  payload('thread-created', {
    cwd: z.string(),
    canonicalRepo: z.string().nullable(),
    name: z.string().nullable(),
  }),
  payload('thread-forked', {
    fromThreadId: ThreadIdSchema,
    atSeq: z.number().int().nonnegative(),
  }),
  payload('thread-renamed', { name: z.string() }),
  payload('thread-archived', {}),
  payload('cwd-changed', { from: z.string(), to: z.string() }),

  payload('turn-started', { userText: z.string() }),
  payload('turn-state-changed', {
    from: TurnStateSchema,
    to: TurnStateSchema,
  }),
  payload('turn-ended', {
    state: TurnStateSchema,
    reason: TerminationReasonSchema,
  }),

  payload('item-appended', { item: ItemSchema }),
  payload('item-updated', { item: ItemSchema }),

  /** Persisted BEFORE the request goes out, so a crash mid-stream is recoverable. */
  payload('model-request-started', {
    model: z.string(),
    transport: z.enum(['responses', 'chat']),
    /** Redacted: never the key, never full sensitive bodies. */
    requestDigest: z.string(),
  }),
  payload('model-request-completed', {
    requestId: z.string().nullable(),
    finishReason: z.string(),
  }),
  payload('model-request-failed', {
    requestId: z.string().nullable(),
    category: z.string(),
    retryable: z.boolean(),
    message: z.string(),
  }),

  /** Intent is persisted BEFORE execution; result BEFORE we continue (SS-05). */
  payload('side-effect-intent', { intent: SideEffectIntentSchema }),
  payload('side-effect-started', { sideEffectId: SideEffectIdSchema }),
  payload('side-effect-settled', {
    sideEffectId: SideEffectIdSchema,
    state: SideEffectStateSchema,
    resultDigest: z.string().nullable(),
  }),

  payload('policy-decision', {
    callId: ProviderCallIdSchema.nullable(),
    normalizedAction: z.string(),
    decision: z.enum(['allow', 'deny', 'ask', 'passthrough']),
    /** Which rule/source won, so `doctor` can explain every decision (PS-07). */
    reason: z.string(),
    source: z.string(),
  }),
  payload('approval-requested', {
    callId: ProviderCallIdSchema.nullable(),
    normalizedAction: z.string(),
    risk: z.enum(['low', 'medium', 'high']),
  }),
  payload('approval-resolved', {
    callId: ProviderCallIdSchema.nullable(),
    granted: z.boolean(),
    scope: z.enum(['once', 'session', 'rule']).nullable(),
  }),

  payload('hook-fired', {
    event: z.string(),
    handler: z.string(),
    outcome: z.enum(['continue', 'block', 'context', 'modify', 'stop']),
    durationMs: z.number().int().nonnegative(),
  }),

  payload('budget-warning', {
    budget: z.string(),
    used: z.number(),
    limit: z.number(),
  }),
  payload('cancelled', { scope: z.string() }),

  /** Unknown future events survive export/import without silent loss (RT-09). */
  payload('unknown', { originalType: z.string(), raw: z.unknown() }),
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;

export const HarnessEventSchema = EventEnvelopeSchema.extend({
  payload: EventPayloadSchema,
});
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;

/**
 * Forward compatibility (RT-09 / SS-06): a payload whose `type` this build does not know is
 * preserved verbatim as an `unknown` payload rather than dropped. An older build can therefore
 * import a newer export, and re-exporting it does not lose data.
 */
export function parseEventLenient(raw: unknown): HarnessEvent {
  const direct = HarnessEventSchema.safeParse(raw);
  if (direct.success) return direct.data;

  // The envelope must still be valid — we never accept an unattributable event.
  const envelope = EventEnvelopeSchema.parse(raw);

  // Read the original type defensively: a future/hostile payload may carry any shape, so we
  // only accept a genuine string here rather than stringifying an object into "[object Object]".
  const rawType: unknown =
    typeof raw === 'object' && raw !== null && 'payload' in raw
      ? (raw as { payload?: unknown }).payload
      : undefined;
  const originalType =
    typeof rawType === 'object' && rawType !== null && 'type' in rawType
      ? typeof (rawType as { type: unknown }).type === 'string'
        ? (rawType as { type: string }).type
        : 'unparseable'
      : 'unparseable';

  return {
    ...envelope,
    payload: {
      type: 'unknown',
      originalType,
      raw: (raw as { payload?: unknown }).payload,
    },
  };
}

export { SCHEMA_VERSION };
