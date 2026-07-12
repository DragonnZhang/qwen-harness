import { z } from 'zod';

import {
  ActorIdSchema,
  ItemIdSchema,
  ThreadIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from './ids.ts';

/** Bump only with a migration and an export-compatibility test (RT-09, SS-06). */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Permission profiles (PS-01). Permission and isolation are SEPARATE axes.
// ---------------------------------------------------------------------------

export const PermissionProfileSchema = z.enum(['plan', 'ask', 'auto-accept-edits', 'yolo']);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

/** Compatibility aliases (docs/product/defaults.md). They map onto the four canonical profiles. */
export const PROFILE_ALIASES: Record<string, PermissionProfile> = {
  default: 'ask',
  manual: 'ask',
  acceptEdits: 'auto-accept-edits',
  bypassPermissions: 'yolo',
};

export function resolveProfile(input: string): PermissionProfile | undefined {
  const alias = PROFILE_ALIASES[input];
  if (alias) return alias;
  const direct = PermissionProfileSchema.safeParse(input);
  return direct.success ? direct.data : undefined;
}

export const IsolationModeSchema = z.enum(['read-only', 'workspace-write', 'disabled']);
export type IsolationMode = z.infer<typeof IsolationModeSchema>;

/** The default mapping frozen in docs/product/defaults.md. A profile may never exceed managed policy. */
export const DEFAULT_ISOLATION: Record<PermissionProfile, IsolationMode> = {
  plan: 'read-only',
  ask: 'workspace-write',
  'auto-accept-edits': 'workspace-write',
  yolo: 'disabled',
};

/** Network is denied by default in every profile except `yolo`; `ask` can be granted it. */
export const DEFAULT_NETWORK_ALLOWED: Record<PermissionProfile, boolean> = {
  plan: false,
  ask: false,
  'auto-accept-edits': false,
  yolo: true,
};

// ---------------------------------------------------------------------------
// Actors (SC-03: every side effect is attributable)
// ---------------------------------------------------------------------------

export const ActorSchema = z.object({
  kind: z.enum([
    'user',
    'model',
    'subagent',
    'teammate',
    'hook',
    'cron',
    'background',
    'system',
    'mcp',
  ]),
  id: ActorIdSchema,
  /** Human label, e.g. "lead" or "reviewer". Untrusted: sanitize before display. */
  label: z.string().max(200).optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

// ---------------------------------------------------------------------------
// Turn state machine (RT-03)
// ---------------------------------------------------------------------------

export const TurnStateSchema = z.enum([
  // non-terminal
  'preparing',
  'model-streaming',
  'awaiting-approval',
  'executing',
  'waiting-background',
  'compacting',
  'recovering',
  'steering',
  // terminal
  'completed',
  'cancelled',
  'failed',
  'blocked',
  'budget-exhausted',
]);
export type TurnState = z.infer<typeof TurnStateSchema>;

export const TERMINAL_TURN_STATES = [
  'completed',
  'cancelled',
  'failed',
  'blocked',
  'budget-exhausted',
] as const satisfies readonly TurnState[];

export function isTerminalTurnState(s: TurnState): boolean {
  return (TERMINAL_TURN_STATES as readonly string[]).includes(s);
}

/**
 * Legal transitions. Encoded as data so the state machine is testable as data (RT-03) and so an
 * illegal transition is rejected at the boundary rather than corrupting a turn.
 *
 * Note `awaiting-approval -> executing`: an approval RESUMES the same turn. It is never a new
 * user message (task.md, "Core domain and runtime invariants").
 */
export const TURN_TRANSITIONS: Record<TurnState, readonly TurnState[]> = {
  preparing: [
    'model-streaming',
    'compacting',
    'failed',
    'cancelled',
    'blocked',
    'budget-exhausted',
  ],
  'model-streaming': [
    'executing',
    'awaiting-approval',
    'completed',
    'compacting',
    'recovering',
    'steering',
    'failed',
    'cancelled',
    'budget-exhausted',
  ],
  'awaiting-approval': ['executing', 'model-streaming', 'cancelled', 'failed', 'blocked'],
  executing: [
    'model-streaming',
    'awaiting-approval',
    'waiting-background',
    'executing',
    'recovering',
    'steering',
    'completed',
    'failed',
    'cancelled',
    'budget-exhausted',
  ],
  'waiting-background': [
    'executing',
    'model-streaming',
    'completed',
    'cancelled',
    'failed',
    'blocked',
  ],
  compacting: ['model-streaming', 'preparing', 'failed', 'cancelled'],
  recovering: ['model-streaming', 'executing', 'compacting', 'failed', 'cancelled', 'blocked'],
  steering: ['model-streaming', 'executing', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
  blocked: [],
  'budget-exhausted': [],
};

export function canTransition(from: TurnState, to: TurnState): boolean {
  return (TURN_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** Why a turn ended. A turn never just "stops" — it always names a reason (RT-04). */
export const TerminationReasonSchema = z.enum([
  'natural-completion',
  'user-cancelled',
  'turn-limit',
  'model-call-limit',
  'tool-call-limit',
  'token-limit',
  'time-limit',
  'cost-limit',
  'retry-limit',
  'blocking-limit',
  'no-progress',
  'repeated-identical-calls',
  'oscillation',
  'diminishing-returns',
  'runaway-children',
  'resource-denial-of-service',
  'hook-stop',
  'policy-denied',
  'provider-error',
  'tool-error',
  'internal-error',
]);
export type TerminationReason = z.infer<typeof TerminationReasonSchema>;

// ---------------------------------------------------------------------------
// Untrusted text (TL-14, TL-11). The type system carries the trust boundary.
// ---------------------------------------------------------------------------

/**
 * Text from a model, repository, tool, hook, MCP server, web page, or provider string.
 * It is NOT renderable until it crosses the sanitizer. `tui-kit` accepts only `SafeText` for
 * content, and only typed trusted-chrome values may emit terminal control sequences.
 *
 * This is a nominal type on purpose: you cannot get a `SafeText` by casting a string, you can
 * only get one from the sanitizer.
 */
declare const untrustedBrand: unique symbol;
declare const safeBrand: unique symbol;

export type UntrustedText = string & {
  readonly [untrustedBrand]: 'UntrustedText';
};
export type SafeText = string & { readonly [safeBrand]: 'SafeText' };

export const TextOriginSchema = z.enum([
  'model',
  'repository',
  'tool',
  'hook',
  'mcp',
  'web',
  'provider',
  'user',
  'markdown-link',
]);
export type TextOrigin = z.infer<typeof TextOriginSchema>;

/** Mark a raw string as untrusted. This is the ONLY way text should enter the system. */
export function untrusted(s: string): UntrustedText {
  return s as UntrustedText;
}

// ---------------------------------------------------------------------------
// Items (design.md §5)
// ---------------------------------------------------------------------------

const ItemBase = {
  id: ItemIdSchema,
  turnId: TurnIdSchema,
  threadId: ThreadIdSchema,
  /** Ordinal within the turn. Ordering is explicit, never inferred from insertion order. */
  seq: z.number().int().nonnegative(),
  createdAt: z.number().int(),
};

export const UserMessageItemSchema = z.object({
  ...ItemBase,
  type: z.literal('user-message'),
  text: z.string(),
});

export const AssistantMessageItemSchema = z.object({
  ...ItemBase,
  type: z.literal('assistant-message'),
  text: z.string(),
  /** False while the model is still streaming this item. */
  complete: z.boolean(),
});

/**
 * A reasoning SUMMARY. Never raw private chain-of-thought (PV-04).
 * Chat's `reasoning_content` must never be turned into one of these.
 */
export const ReasoningSummaryItemSchema = z.object({
  ...ItemBase,
  type: z.literal('reasoning-summary'),
  summary: z.string(),
  complete: z.boolean(),
});

/**
 * Chat transport produced raw reasoning we deliberately discarded. We record that it HAPPENED
 * (as a status, with no content) so the UI can say "the model thought" without us ever
 * persisting private reasoning. This is the "non-content status" the contract allows.
 */
export const ReasoningStatusItemSchema = z.object({
  ...ItemBase,
  type: z.literal('reasoning-status'),
  reasoningOccurred: z.literal(true),
  /** Token count only — never the text. */
  reasoningTokens: z.number().int().nonnegative().nullable(),
});

export const ToolCallItemSchema = z.object({
  ...ItemBase,
  type: z.literal('tool-call'),
  callId: ToolCallIdSchema,
  toolName: z.string().min(1).max(200),
  /** Raw argument JSON as the model produced it, retained for audit and exact-approval binding. */
  argumentsJson: z.string(),
  /** Parsed + schema-validated arguments. Absent until validation succeeds (PV-05). */
  arguments: z.record(z.string(), z.unknown()).nullable(),
});

export const ToolResultItemSchema = z.object({
  ...ItemBase,
  type: z.literal('tool-result'),
  callId: ToolCallIdSchema,
  toolName: z.string(),
  ok: z.boolean(),
  /** Bounded preview; full payload lives behind `outputRef` when offloaded (TL-10). */
  preview: z.string(),
  outputRef: z.string().nullable(),
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  errorCategory: z.string().nullable(),
});

export const ApprovalItemSchema = z.object({
  ...ItemBase,
  type: z.literal('approval'),
  callId: ToolCallIdSchema.nullable(),
  decision: z.enum(['allow', 'deny', 'ask', 'passthrough']),
  scope: z.enum(['once', 'session', 'rule']).nullable(),
  /** The exact normalized action the user saw. Approval binds to THIS, not to a tool name. */
  normalizedAction: z.string(),
  actor: ActorSchema,
});

export const ErrorItemSchema = z.object({
  ...ItemBase,
  type: z.literal('error'),
  category: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.string().nullable(),
});

export const UsageItemSchema = z.object({
  ...ItemBase,
  type: z.literal('usage'),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  /** Reasoning tokens are OUTPUT tokens and are billable (PV-09). */
  reasoningTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
});

export const CompactionItemSchema = z.object({
  ...ItemBase,
  type: z.literal('compaction'),
  trigger: z.enum(['proactive', 'reactive-overflow', 'manual']),
  /** Where full pre-compaction history was persisted before we replaced it (CX-03). */
  transcriptBoundaryRef: z.string(),
  summary: z.string(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
});

export const UserShellItemSchema = z.object({
  ...ItemBase,
  type: z.literal('user-shell'),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  truncated: z.boolean(),
});

export const ItemSchema = z.discriminatedUnion('type', [
  UserMessageItemSchema,
  AssistantMessageItemSchema,
  ReasoningSummaryItemSchema,
  ReasoningStatusItemSchema,
  ToolCallItemSchema,
  ToolResultItemSchema,
  ApprovalItemSchema,
  ErrorItemSchema,
  UsageItemSchema,
  CompactionItemSchema,
  UserShellItemSchema,
]);
export type Item = z.infer<typeof ItemSchema>;
export type ItemType = Item['type'];

// ---------------------------------------------------------------------------
// Thread / Turn
// ---------------------------------------------------------------------------

export const TurnSchema = z.object({
  id: TurnIdSchema,
  threadId: ThreadIdSchema,
  seq: z.number().int().nonnegative(),
  state: TurnStateSchema,
  terminationReason: TerminationReasonSchema.nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  permissionProfile: PermissionProfileSchema,
});
export type Turn = z.infer<typeof TurnSchema>;

export const ThreadSchema = z.object({
  id: ThreadIdSchema,
  name: z.string().max(200).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Canonical repository root. A thread keeps this identity across cwd changes (SS-08). */
  canonicalRepo: z.string().nullable(),
  cwd: z.string(),
  permissionProfile: PermissionProfileSchema,
  archived: z.boolean(),
  /** Lineage for fork/branch (SS-03). */
  forkedFrom: z.object({ threadId: ThreadIdSchema, atSeq: z.number().int() }).nullable(),
});
export type Thread = z.infer<typeof ThreadSchema>;
