/**
 * Resolution: many partial sources in, one effective config out — with PROVENANCE on every value.
 *
 * There are exactly TWO merge strategies, and keeping them distinct is the whole security story:
 *
 *   • override   Ordinary product values resolve last-write-wins by scope precedence
 *                (cli > env > local-project > shared-project > user > builtin). The highest scope
 *                that set a key owns it. `managed` never participates — it cannot out-vote a value,
 *                only cap it.
 *
 *   • deny-merge Security deny lists take the UNION across EVERY scope. A higher scope can add a
 *                deny but can NEVER drop one a lower scope contributed. There is deliberately no
 *                "allow" that removes a deny, so the union only ever grows. This is why a malicious
 *                project file cannot re-enable something the user or managed policy denied.
 *
 * On top of both sits the managed CEILING. `maxProfile`, `maxIsolation`, and `networkAllowed`
 * resolve tighten-only (the strictest value across all scopes wins, managed included), and the
 * authority values they bound (`permissionProfile`, `isolation`, `network`) are clamped to them
 * AFTER ordinary resolution. A lower source can therefore make authority MORE restrictive but can
 * never widen it past managed — the clamp is applied last, so nothing downstream can loosen it.
 */

import type { IsolationMode, PermissionProfile } from '@qwen-harness/protocol';

import type { ReasoningEffort, TelemetryLevel, Transport } from './schema.ts';
import {
  BUILTIN_SOURCE,
  OVERRIDE_RANK,
  sourceRef,
  type ConfigSource,
  type ConfigSourceRef,
} from './sources.ts';
import type { ConfigDoc } from './schema.ts';

// ---------------------------------------------------------------------------------------------
// Local ordering. Duplicated from `policy` on purpose: `config` sits at layer 1 and must not
// depend on a domain package. The rankings are small, frozen (defaults.md), and unit-tested.
// ---------------------------------------------------------------------------------------------

/** Lower rank = LESS authority = tighter. */
const PROFILE_RANK: Record<PermissionProfile, number> = {
  plan: 0,
  ask: 1,
  'auto-accept-edits': 2,
  yolo: 3,
};

/** Lower rank = stricter isolation. `read-only` is strictest, `disabled` is no isolation. */
const ISOLATION_RANK: Record<IsolationMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  disabled: 2,
};

/** `false` is tighter than `true` for a boolean ceiling (deny is more restrictive than allow). */
const boolTightness = (value: boolean): number => (value ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Resolved shapes
// ---------------------------------------------------------------------------------------------

/** A single effective value and the one source that won it. */
export interface Resolved<T> {
  readonly value: T;
  readonly source: ConfigSourceRef;
}

/** One deny entry and the scope that contributed it. Multiple scopes may contribute the same one. */
export interface DenyContribution {
  readonly value: string;
  readonly source: ConfigSourceRef;
}

/** The merged security deny list: the de-duplicated union plus per-entry attribution. */
export interface ResolvedDeny {
  readonly value: readonly string[];
  readonly contributions: readonly DenyContribution[];
}

export interface ResolvedBudgets {
  readonly turnsPerGoal: Resolved<number>;
  readonly modelCallsPerTurn: Resolved<number>;
  readonly toolCallsPerTurn: Resolved<number>;
  readonly wallTimeMsPerTurn: Resolved<number>;
  readonly activeChildAgents: Resolved<number>;
  readonly childDepth: Resolved<number>;
  readonly safeReadConcurrency: Resolved<number>;
  readonly retryAttempts: Resolved<number>;
}

export interface ResolvedToolOutput {
  readonly modelPreviewBytes: Resolved<number>;
  readonly tuiInlineBytes: Resolved<number>;
  readonly backgroundWarnBytes: Resolved<number>;
  readonly backgroundHardStopBytes: Resolved<number>;
  readonly mcpInlineTokens: Resolved<number>;
  readonly mcpDurableChars: Resolved<number>;
}

export interface ResolvedConfig {
  readonly model: Resolved<string>;
  readonly baseUrl: Resolved<string>;
  readonly apiKeyEnv: Resolved<string>;
  readonly reasoningEffort: Resolved<ReasoningEffort>;
  readonly transport: Resolved<Transport>;
  readonly telemetry: Resolved<boolean>;
  /** Trace verbosity, meaningful only when `telemetry` is enabled (OB-02). */
  readonly telemetryLevel: Resolved<TelemetryLevel>;
  /** Days a trace file is kept before it is deleted (OB-02). */
  readonly telemetryRetentionDays: Resolved<number>;
  readonly budgets: ResolvedBudgets;
  readonly toolOutput: ResolvedToolOutput;

  /** Effective authority — already clamped to the ceiling. */
  readonly permissionProfile: Resolved<PermissionProfile>;
  readonly isolation: Resolved<IsolationMode>;
  readonly network: Resolved<boolean>;

  /** The ceiling itself, exposed so `doctor` can show what bounded the authority above. */
  readonly maxProfile: Resolved<PermissionProfile>;
  readonly maxIsolation: Resolved<IsolationMode>;
  readonly networkAllowed: Resolved<boolean>;

  readonly deny: ResolvedDeny;
}

/** Raised only if a required field has no built-in default — a programming error, never user input. */
export class ConfigResolutionError extends Error {
  override readonly name = 'ConfigResolutionError';
}

// ---------------------------------------------------------------------------------------------
// Strategy 1: override (highest scope wins; `managed` excluded)
// ---------------------------------------------------------------------------------------------

function resolveOverride<T>(
  sources: readonly ConfigSource[],
  key: string,
  select: (doc: ConfigDoc) => T | undefined,
): Resolved<T> {
  let best: { value: T; source: ConfigSource; rank: number } | undefined;
  for (const source of sources) {
    // Managed policy is a ceiling, not an ordinary contributor: it never sets a product value.
    if (source.scope === 'managed') continue;
    const value = select(source.config);
    if (value === undefined) continue;
    const rank = OVERRIDE_RANK[source.scope];
    // `>=` so a later source of equal rank wins; with builtin placed first this is deterministic.
    if (best === undefined || rank >= best.rank) {
      best = { value, source, rank };
    }
  }
  if (best === undefined) {
    throw new ConfigResolutionError(`no source (not even builtin) provides '${key}'`);
  }
  return { value: best.value, source: sourceRef(best.source) };
}

// ---------------------------------------------------------------------------------------------
// Strategy for ceilings: tightest across ALL scopes (managed included)
// ---------------------------------------------------------------------------------------------

function resolveCeiling<T>(
  sources: readonly ConfigSource[],
  key: string,
  select: (doc: ConfigDoc) => T | undefined,
  tightnessOf: (value: T) => number,
): Resolved<T> {
  let best: { value: T; source: ConfigSource; tight: number } | undefined;
  for (const source of sources) {
    const value = select(source.config);
    if (value === undefined) continue;
    const tight = tightnessOf(value);
    // Strictly-tighter replaces, so the FIRST source achieving the minimum is attributed.
    if (best === undefined || tight < best.tight) {
      best = { value, source, tight };
    }
  }
  if (best === undefined) {
    throw new ConfigResolutionError(`no source (not even builtin) provides ceiling '${key}'`);
  }
  return { value: best.value, source: sourceRef(best.source) };
}

// ---------------------------------------------------------------------------------------------
// Strategy 2: deny-merge (union across every scope)
// ---------------------------------------------------------------------------------------------

function resolveDeny(sources: readonly ConfigSource[]): ResolvedDeny {
  const contributions: DenyContribution[] = [];
  const seen = new Set<string>();
  const value: string[] = [];
  for (const source of sources) {
    for (const entry of source.config.deny ?? []) {
      contributions.push({ value: entry, source: sourceRef(source) });
      if (!seen.has(entry)) {
        seen.add(entry);
        value.push(entry);
      }
    }
  }
  return { value, contributions };
}

// ---------------------------------------------------------------------------------------------
// Clamping authority to its ceiling
// ---------------------------------------------------------------------------------------------

/** If the ceiling is tighter than the desired value, the ceiling (and its source) wins. */
function clamp<T>(
  desired: Resolved<T>,
  ceiling: Resolved<T>,
  tightnessOf: (value: T) => number,
): Resolved<T> {
  return tightnessOf(ceiling.value) < tightnessOf(desired.value) ? ceiling : desired;
}

// ---------------------------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------------------------

export function resolveConfig(sources: readonly ConfigSource[]): ResolvedConfig {
  // The built-in layer is ALWAYS present and lowest: every value therefore has provenance, and a
  // caller never has to remember to pass defaults.
  const all: readonly ConfigSource[] = [BUILTIN_SOURCE, ...sources];

  const profileTight = (p: PermissionProfile): number => PROFILE_RANK[p];
  const isolationTight = (m: IsolationMode): number => ISOLATION_RANK[m];

  const maxProfile = resolveCeiling(all, 'maxProfile', (d) => d.maxProfile, profileTight);
  const maxIsolation = resolveCeiling(all, 'maxIsolation', (d) => d.maxIsolation, isolationTight);
  const networkAllowed = resolveCeiling(
    all,
    'networkAllowed',
    (d) => d.networkAllowed,
    boolTightness,
  );

  const desiredProfile = resolveOverride(all, 'permissionProfile', (d) => d.permissionProfile);
  const desiredIsolation = resolveOverride(all, 'isolation', (d) => d.isolation);
  const desiredNetwork = resolveOverride(all, 'network', (d) => d.network);

  // network is an AND: the ceiling can force it false, but cannot turn a denied network on.
  const network: Resolved<boolean> =
    desiredNetwork.value && !networkAllowed.value
      ? { value: false, source: networkAllowed.source }
      : { value: desiredNetwork.value && networkAllowed.value, source: desiredNetwork.source };

  return {
    model: resolveOverride(all, 'model', (d) => d.model),
    baseUrl: resolveOverride(all, 'baseUrl', (d) => d.baseUrl),
    apiKeyEnv: resolveOverride(all, 'apiKeyEnv', (d) => d.apiKeyEnv),
    reasoningEffort: resolveOverride(all, 'reasoningEffort', (d) => d.reasoningEffort),
    transport: resolveOverride(all, 'transport', (d) => d.transport),
    telemetry: resolveOverride(all, 'telemetry', (d) => d.telemetry?.enabled),
    telemetryLevel: resolveOverride(all, 'telemetryLevel', (d) => d.telemetry?.level),
    telemetryRetentionDays: resolveOverride(
      all,
      'telemetryRetentionDays',
      (d) => d.telemetry?.retentionDays,
    ),

    budgets: {
      turnsPerGoal: resolveOverride(all, 'budgets.turnsPerGoal', (d) => d.budgets?.turnsPerGoal),
      modelCallsPerTurn: resolveOverride(
        all,
        'budgets.modelCallsPerTurn',
        (d) => d.budgets?.modelCallsPerTurn,
      ),
      toolCallsPerTurn: resolveOverride(
        all,
        'budgets.toolCallsPerTurn',
        (d) => d.budgets?.toolCallsPerTurn,
      ),
      wallTimeMsPerTurn: resolveOverride(
        all,
        'budgets.wallTimeMsPerTurn',
        (d) => d.budgets?.wallTimeMsPerTurn,
      ),
      activeChildAgents: resolveOverride(
        all,
        'budgets.activeChildAgents',
        (d) => d.budgets?.activeChildAgents,
      ),
      childDepth: resolveOverride(all, 'budgets.childDepth', (d) => d.budgets?.childDepth),
      safeReadConcurrency: resolveOverride(
        all,
        'budgets.safeReadConcurrency',
        (d) => d.budgets?.safeReadConcurrency,
      ),
      retryAttempts: resolveOverride(all, 'budgets.retryAttempts', (d) => d.budgets?.retryAttempts),
    },

    toolOutput: {
      modelPreviewBytes: resolveOverride(
        all,
        'toolOutput.modelPreviewBytes',
        (d) => d.toolOutput?.modelPreviewBytes,
      ),
      tuiInlineBytes: resolveOverride(
        all,
        'toolOutput.tuiInlineBytes',
        (d) => d.toolOutput?.tuiInlineBytes,
      ),
      backgroundWarnBytes: resolveOverride(
        all,
        'toolOutput.backgroundWarnBytes',
        (d) => d.toolOutput?.backgroundWarnBytes,
      ),
      backgroundHardStopBytes: resolveOverride(
        all,
        'toolOutput.backgroundHardStopBytes',
        (d) => d.toolOutput?.backgroundHardStopBytes,
      ),
      mcpInlineTokens: resolveOverride(
        all,
        'toolOutput.mcpInlineTokens',
        (d) => d.toolOutput?.mcpInlineTokens,
      ),
      mcpDurableChars: resolveOverride(
        all,
        'toolOutput.mcpDurableChars',
        (d) => d.toolOutput?.mcpDurableChars,
      ),
    },

    permissionProfile: clamp(desiredProfile, maxProfile, profileTight),
    isolation: clamp(desiredIsolation, maxIsolation, isolationTight),
    network,

    maxProfile,
    maxIsolation,
    networkAllowed,

    deny: resolveDeny(all),
  };
}

// ---------------------------------------------------------------------------------------------
// Provenance lookup (doctor, PS-07 / OB-03)
// ---------------------------------------------------------------------------------------------

/** Every leaf value doctor can explain, as a dotted key. Kept in sync with the shape by the types. */
export type ConfigKey =
  | 'model'
  | 'baseUrl'
  | 'apiKeyEnv'
  | 'reasoningEffort'
  | 'transport'
  | 'telemetry'
  | 'telemetryLevel'
  | 'telemetryRetentionDays'
  | 'permissionProfile'
  | 'isolation'
  | 'network'
  | 'maxProfile'
  | 'maxIsolation'
  | 'networkAllowed'
  | 'deny'
  | `budgets.${keyof ResolvedBudgets}`
  | `toolOutput.${keyof ResolvedToolOutput}`;

export const CONFIG_KEYS: readonly ConfigKey[] = [
  'model',
  'baseUrl',
  'apiKeyEnv',
  'reasoningEffort',
  'transport',
  'telemetry',
  'telemetryLevel',
  'telemetryRetentionDays',
  'permissionProfile',
  'isolation',
  'network',
  'maxProfile',
  'maxIsolation',
  'networkAllowed',
  'deny',
  'budgets.turnsPerGoal',
  'budgets.modelCallsPerTurn',
  'budgets.toolCallsPerTurn',
  'budgets.wallTimeMsPerTurn',
  'budgets.activeChildAgents',
  'budgets.childDepth',
  'budgets.safeReadConcurrency',
  'budgets.retryAttempts',
  'toolOutput.modelPreviewBytes',
  'toolOutput.tuiInlineBytes',
  'toolOutput.backgroundWarnBytes',
  'toolOutput.backgroundHardStopBytes',
  'toolOutput.mcpInlineTokens',
  'toolOutput.mcpDurableChars',
];

/** The answer `doctor` prints for one key: a single winning source, or a merged deny list. */
export type Provenance =
  | { readonly kind: 'value'; readonly value: unknown; readonly source: ConfigSourceRef }
  | {
      readonly kind: 'merged';
      readonly value: readonly string[];
      readonly contributions: readonly DenyContribution[];
    };

function isResolvedDeny(node: unknown): node is ResolvedDeny {
  return typeof node === 'object' && node !== null && 'contributions' in node;
}

function isResolvedValue(node: unknown): node is Resolved<unknown> {
  return typeof node === 'object' && node !== null && 'source' in node && 'value' in node;
}

/**
 * Where did the effective value of `key` come from? This is the function `doctor` calls for every
 * winning value (PS-07). It walks the resolved tree by dotted path so a new field needs no new
 * branch here — only an entry in `ConfigKey`.
 */
export function provenanceOf(resolved: ResolvedConfig, key: ConfigKey): Provenance {
  let node: unknown = resolved;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) {
      throw new ConfigResolutionError(`config key '${key}' does not exist`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (isResolvedDeny(node)) {
    return { kind: 'merged', value: node.value, contributions: node.contributions };
  }
  if (isResolvedValue(node)) {
    return { kind: 'value', value: node.value, source: node.source };
  }
  throw new ConfigResolutionError(`config key '${key}' is not a resolved value`);
}
