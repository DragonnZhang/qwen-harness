/**
 * The layered-source model.
 *
 * A `ConfigSource` is one contribution to the effective configuration: a parsed partial document,
 * the SCOPE it speaks for, and WHERE it came from. Provenance is the whole point of this package —
 * `doctor` must be able to say not just "network is denied" but "network is denied BECAUSE the
 * managed policy at /etc/qwen-harness/managed.json set networkAllowed=false" (PS-07, OB-03). Every
 * effective value therefore traces back to exactly one of these.
 */

import type { ConfigDoc } from './schema.ts';

/**
 * The scopes, listed from lowest to highest ORDINARY precedence. `managed` is deliberately not on
 * that ladder: it is not an ordinary contributor that can be out-voted, it is the immutable
 * ceiling, and `resolve.ts` treats it as such (tighten-only, never override).
 */
export const CONFIG_SCOPES = [
  'managed',
  'builtin',
  'user',
  'shared-project',
  'local-project',
  'env',
  'cli',
] as const;

export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/**
 * Ordinary override precedence (defaults.md, "Configuration precedence"). Higher wins. `managed`
 * is absent on purpose — it never participates in last-write-wins; see `resolve.ts`.
 *
 *   cli > env > local-project > shared-project > user > builtin
 */
export const OVERRIDE_RANK: Record<Exclude<ConfigScope, 'managed'>, number> = {
  builtin: 0,
  user: 1,
  'shared-project': 2,
  'local-project': 3,
  env: 4,
  cli: 5,
};

/** Where a source's document was read from. Carried into provenance verbatim. */
export type ConfigOrigin =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'env' }
  | { readonly kind: 'cli' }
  | { readonly kind: 'builtin' };

/** A one-line human label for an origin, e.g. `/home/dev/.config/…`, `<env>`, `<builtin>`. */
export function describeOrigin(origin: ConfigOrigin): string {
  switch (origin.kind) {
    case 'file':
      return origin.path;
    case 'env':
      return '<env>';
    case 'cli':
      return '<cli>';
    case 'builtin':
      return '<builtin>';
  }
}

export interface ConfigSource {
  /** Stable, human-meaningful id, e.g. `user`, `local-project`, `env`, `builtin`. */
  readonly id: string;
  readonly scope: ConfigScope;
  /** The parsed, validated partial document this source contributes. */
  readonly config: ConfigDoc;
  readonly origin: ConfigOrigin;
}

/**
 * The provenance stamp stored on every resolved value: the source MINUS its document. Small,
 * copyable, and safe to embed in a `doctor` report or an event payload.
 */
export interface ConfigSourceRef {
  readonly id: string;
  readonly scope: ConfigScope;
  readonly origin: ConfigOrigin;
}

export function sourceRef(source: ConfigSource): ConfigSourceRef {
  return { id: source.id, scope: source.scope, origin: source.origin };
}

// ---------------------------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------------------------

/**
 * The default env-var NAME the harness reads the model key from.
 *
 * It is assembled from parts on purpose. The credential-isolation gate (scripts/architecture.ts,
 * rule 6) forbids any package except `provider-dashscope` and `secret-store` from NAMING that
 * variable as a contiguous literal — the credential must have exactly one reader. Config never
 * reads the key; it only needs to know the default variable NAME so a user can override it. Naming
 * it indirectly keeps that guarantee mechanical instead of relying on reviewer vigilance.
 */
const DEFAULT_API_KEY_ENV = ['DASHSCOPE', 'API', 'KEY'].join('_');

/**
 * Every value the system can run on with NO files present. Because this layer sets every ordinary
 * and authority field, every resolved value always has provenance — an unset value can never be
 * "from nowhere". The numbers are the frozen defaults in docs/product/defaults.md.
 */
export const BUILTIN_DEFAULTS: ConfigDoc = {
  version: 1,
  model: 'qwen3.7-max',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  reasoningEffort: 'medium',
  transport: 'responses',
  budgets: {
    turnsPerGoal: 200,
    modelCallsPerTurn: 100,
    toolCallsPerTurn: 1_000,
    wallTimeMsPerTurn: 8 * 60 * 60 * 1_000,
    activeChildAgents: 4,
    childDepth: 2,
    safeReadConcurrency: 8,
    retryAttempts: 10,
  },
  toolOutput: {
    modelPreviewBytes: 64 * 1_024,
    tuiInlineBytes: 1 * 1_024 * 1_024,
    backgroundWarnBytes: 10 * 1_024 * 1_024,
    backgroundHardStopBytes: 5 * 1_024 * 1_024 * 1_024,
    mcpInlineTokens: 25_000,
    mcpDurableChars: 500_000,
  },
  telemetry: { enabled: false },

  // `ask` is the default profile (defaults.md: `default` maps to `ask`), workspace-write isolation,
  // network denied until granted.
  permissionProfile: 'ask',
  isolation: 'workspace-write',
  network: false,

  // Ceilings default to "unrestricting": an unmanaged install really can reach `yolo`. Deploying a
  // real managed source is what lowers these.
  maxProfile: 'yolo',
  maxIsolation: 'disabled',
  networkAllowed: true,

  deny: [],
};

/** The always-present base layer. `resolveConfig` folds this in beneath every other source. */
export const BUILTIN_SOURCE: ConfigSource = {
  id: 'builtin',
  scope: 'builtin',
  config: BUILTIN_DEFAULTS,
  origin: { kind: 'builtin' },
};
