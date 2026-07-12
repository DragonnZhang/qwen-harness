/**
 * @qwen-harness/config
 *
 * Layered configuration with PROVENANCE. Every effective value knows which source produced it, so
 * `doctor` can explain every winning value (PS-07, PK-03, OB-03).
 *
 * A declared I/O owner (scripts/graph.ts): `load.ts` may read config files and the environment;
 * everything else in the package is pure. There are exactly two merge strategies — ordinary
 * `override` (highest scope wins) and security `deny-merge` (union across every scope) — and the
 * managed policy is an immutable ceiling that can only tighten authority, never relax it. See
 * README.md for why security is deny-first.
 */

export {
  CONFIG_SCHEMA_VERSION,
  ConfigDocSchema,
  ApiKeyEnvSchema,
  ENV_VAR_NAME,
  ReasoningEffortSchema,
  TransportSchema,
  ProfileConfigSchema,
  BudgetsSchema,
  ToolOutputSchema,
  TelemetrySchema,
  DenyEntrySchema,
} from './schema.ts';
export type {
  ConfigDoc,
  Budgets,
  ToolOutput,
  ReasoningEffort,
  Transport,
  PermissionProfile,
} from './schema.ts';

export {
  CONFIG_SCOPES,
  OVERRIDE_RANK,
  BUILTIN_DEFAULTS,
  BUILTIN_SOURCE,
  describeOrigin,
  sourceRef,
} from './sources.ts';
export type { ConfigScope, ConfigOrigin, ConfigSource, ConfigSourceRef } from './sources.ts';

export { resolveConfig, provenanceOf, CONFIG_KEYS, ConfigResolutionError } from './resolve.ts';
export type {
  ResolvedConfig,
  Resolved,
  ResolvedBudgets,
  ResolvedToolOutput,
  ResolvedDeny,
  DenyContribution,
  Provenance,
  ConfigKey,
} from './resolve.ts';

export {
  CONFIG_MIGRATIONS,
  migrateConfig,
  readConfigVersion,
  ConfigMigrationError,
  UnknownConfigVersionError,
} from './migrations.ts';
export type { MigrationResult } from './migrations.ts';

export {
  loadConfigFile,
  loadEnvSource,
  loadCliSource,
  loadConfigSources,
  loadResolvedConfig,
  computeConfigPaths,
  ENV_ALLOWLIST,
  PROJECT_CONFIG_DIR,
  SHARED_PROJECT_FILE,
  LOCAL_PROJECT_FILE,
  USER_CONFIG_SUBPATH,
  DEFAULT_MANAGED_PATH,
  ConfigError,
  ConfigFileError,
  ConfigEnvError,
} from './load.ts';
export type {
  ConfigPathOptions,
  ConfigPaths,
  LoadOptions,
  LoadedSources,
  LoadedConfig,
  EnvBinding,
  ConfigFileFailure,
} from './load.ts';
