/**
 * The config DOCUMENT schema — the shape every scope's file, env slice, and CLI override is
 * validated against before it is allowed to influence a single effective value.
 *
 * Two invariants are enforced HERE, at the boundary, rather than hoped for downstream:
 *
 *   1. The document stores the NAME of the environment variable that holds the API key, never the
 *      key itself (SC threat model, PV-12). A schema that accepted a raw key value would put a
 *      secret into every config file, export, and support bundle. `apiKeyEnv` therefore only
 *      accepts an env-var identifier; a `sk-…` value fails the regex, not a later check.
 *
 *   2. Unknown keys are rejected (`z.strictObject`). A typo in a config file is a visible error,
 *      not a silently ignored setting that makes `doctor` explain a value the user never sees.
 *
 * Every product field is OPTIONAL: a scope contributes only the keys it actually sets, and
 * `resolve.ts` fills the rest from the built-in defaults. `version` is consumed by `migrations.ts`
 * before validation and is the only key that is not a product value.
 */

import {
  IsolationModeSchema,
  PermissionProfileSchema,
  resolveProfile,
  type PermissionProfile,
} from '@qwen-harness/protocol';
import { z } from 'zod';

/** Bump ONLY with a migration in `migrations.ts` and a round-trip test. */
export const CONFIG_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// API key env-var NAME (never a value)
// ---------------------------------------------------------------------------------------------

/** A POSIX-style environment variable identifier. A real key value never matches this. */
export const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Shapes a leaked SECRET tends to take. `apiKeyEnv` legitimately holds names like
 * `DASHSCOPE_API_KEY`; it must never hold `sk-…`, a JWT, or a long opaque token. The env-name
 * regex already rejects lowercase and hyphens, so this refine is defence-in-depth for the rare
 * all-caps token and, more importantly, produces an error that names the actual mistake.
 */
const LOOKS_LIKE_SECRET = /^(sk|pk|api|key|token|bearer|ghp|xox)[-_]/i;

export const ApiKeyEnvSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    ENV_VAR_NAME,
    'apiKeyEnv must be the NAME of an environment variable (e.g. DASHSCOPE_API_KEY), never a key value',
  )
  .refine(
    (value) => !LOOKS_LIKE_SECRET.test(value),
    'apiKeyEnv looks like a secret VALUE; store only the NAME of the env var that holds the key',
  );

// ---------------------------------------------------------------------------------------------
// Scalar product fields
// ---------------------------------------------------------------------------------------------

export const ReasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const TransportSchema = z.enum(['responses', 'chat']);
export type Transport = z.infer<typeof TransportSchema>;

/**
 * Accepts the four canonical profiles AND the documented compatibility aliases (`default`,
 * `manual`, `acceptEdits`, `bypassPermissions`) by mapping them through `resolveProfile` before
 * the enum sees them. A config file may therefore say `acceptEdits` and resolve to
 * `auto-accept-edits`, exactly as the CLI flag does.
 */
export const ProfileConfigSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (resolveProfile(value) ?? value) : value),
  PermissionProfileSchema,
);

const PositiveInt = z.int().positive();

/**
 * Budget overrides (defaults.md, "Runtime budgets"). A user may RAISE a budget within managed
 * limits; the value here is the requested override, still subject to the runtime's visible-warning
 * behaviour. Kept to the budgets a config file realistically tunes rather than the full table.
 */
export const BudgetsSchema = z
  .strictObject({
    turnsPerGoal: PositiveInt.optional(),
    modelCallsPerTurn: PositiveInt.optional(),
    toolCallsPerTurn: PositiveInt.optional(),
    wallTimeMsPerTurn: PositiveInt.optional(),
    activeChildAgents: PositiveInt.optional(),
    childDepth: PositiveInt.optional(),
    safeReadConcurrency: PositiveInt.optional(),
    retryAttempts: PositiveInt.optional(),
  })
  .partial();

/** Tool/output byte and token limits (defaults.md, "Tool and output defaults"). */
export const ToolOutputSchema = z
  .strictObject({
    modelPreviewBytes: PositiveInt.optional(),
    tuiInlineBytes: PositiveInt.optional(),
    backgroundWarnBytes: PositiveInt.optional(),
    backgroundHardStopBytes: PositiveInt.optional(),
    mcpInlineTokens: PositiveInt.optional(),
    mcpDurableChars: PositiveInt.optional(),
  })
  .partial();

/**
 * Trace verbosity (OB-02). Structurally identical to `@qwen-harness/telemetry`'s `TraceLevel`, and
 * declared HERE rather than imported: `config` is layer 1 and may not depend on a layer-2 domain
 * package. The app maps one onto the other at the composition root, where the two meet.
 */
export const TelemetryLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type TelemetryLevel = z.infer<typeof TelemetryLevelSchema>;

export const TelemetrySchema = z.strictObject({
  /** Telemetry is opt-in (OB-02). The built-in default is `false`. */
  enabled: z.boolean(),
  /**
   * Verbosity. `debug` additionally records redacted model INPUT ITEMS and tool arguments; `info`
   * records their shape (counts, digests, names) but not their content. Everything at every level
   * passes the redactor first — the level changes how much is written, never whether it is safe.
   */
  level: TelemetryLevelSchema.optional(),
  /** Retention (OB-02). Trace files older than this many days are deleted when a trace is opened. */
  retentionDays: PositiveInt.optional(),
});

/**
 * A security deny entry. An opaque string matched by the policy engine (a path glob, a host, a
 * tool name). Config stores the patterns; it never interprets them — that is `policy`'s job.
 */
export const DenyEntrySchema = z.string().min(1).max(1024);

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

export const ConfigDocSchema = z.strictObject({
  /** Present after migration; ignored during resolution. */
  version: z.literal(CONFIG_SCHEMA_VERSION).optional(),

  // Ordinary values (override precedence: highest scope wins).
  model: z.string().min(1).max(200).optional(),
  baseUrl: z.url().optional(),
  apiKeyEnv: ApiKeyEnvSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  transport: TransportSchema.optional(),
  budgets: BudgetsSchema.optional(),
  toolOutput: ToolOutputSchema.optional(),
  telemetry: TelemetrySchema.optional(),

  // Authority values (resolved by precedence, then clamped by the managed ceiling below).
  permissionProfile: ProfileConfigSchema.optional(),
  isolation: IsolationModeSchema.optional(),
  network: z.boolean().optional(),

  // Ceiling declarations (tighten-only: the tightest across ALL scopes wins, and the `managed`
  // scope's value can never be relaxed by a lower one).
  maxProfile: ProfileConfigSchema.optional(),
  maxIsolation: IsolationModeSchema.optional(),
  networkAllowed: z.boolean().optional(),

  // Security list (deny-first: the UNION across every scope; a higher scope can never remove a
  // deny a lower scope contributed).
  deny: z.array(DenyEntrySchema).optional(),
});

/** A validated partial config. Every field may be absent. */
export type ConfigDoc = z.infer<typeof ConfigDocSchema>;

export type Budgets = z.infer<typeof BudgetsSchema>;
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

/**
 * Re-export the canonical profile type so downstream code can talk about resolved authority
 * without importing both this package and `protocol` for one name.
 */
export type { PermissionProfile };
