/**
 * The I/O owner (scripts/graph.ts: `config` may open node:fs / node:path / node:os and nothing
 * else). Everything that touches the disk or the environment lives here; the rest of the package
 * is pure and testable without a filesystem.
 *
 * Rules this file keeps:
 *   • Reads only. It never writes a config file and never reads a secret VALUE — a config document
 *     stores the NAME of the key's env var, never the key.
 *   • A MISSING file contributes nothing: no source, no error. Only a present-but-broken file is an
 *     error, and that error always NAMES the file (PS-07: doctor must be able to point at it).
 *   • Environment variables participate ONLY through the explicit `ENV_ALLOWLIST`. A variable not
 *     on that list is invisible to configuration, by construction.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { migrateConfig } from './migrations.ts';
import { resolveConfig, type ResolvedConfig } from './resolve.ts';
import { ConfigDocSchema, type ConfigDoc } from './schema.ts';
import { type ConfigScope, type ConfigSource } from './sources.ts';

// ---------------------------------------------------------------------------------------------
// Typed errors (every one names its origin)
// ---------------------------------------------------------------------------------------------

export class ConfigError extends Error {
  override readonly name: string = 'ConfigError';
}

export type ConfigFileFailure = 'read' | 'parse' | 'migration' | 'schema';

/** A present config file that could not be turned into a valid document. Always names the path. */
export class ConfigFileError extends ConfigError {
  override readonly name = 'ConfigFileError';
  constructor(
    readonly path: string,
    readonly reason: ConfigFileFailure,
    override readonly cause: unknown,
  ) {
    super(`config file ${path}: ${reason} failed (${describeCause(cause)})`, { cause });
  }
}

/** A malformed value in an allowlisted environment variable. Names the variable. */
export class ConfigEnvError extends ConfigError {
  override readonly name = 'ConfigEnvError';
  constructor(
    readonly variable: string,
    override readonly cause: unknown,
  ) {
    super(`environment variable ${variable}: ${describeCause(cause)}`, { cause });
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------------------------
// Paths (XDG-respecting, all documented)
// ---------------------------------------------------------------------------------------------

/** Project config lives under this directory at the project root. */
export const PROJECT_CONFIG_DIR = '.qwen-harness';
/** Shared (committed) project settings. */
export const SHARED_PROJECT_FILE = 'config.json';
/** Local (git-ignored) project overrides. Higher precedence than the shared file. */
export const LOCAL_PROJECT_FILE = 'config.local.json';
/** User settings, under `$XDG_CONFIG_HOME` (default `~/.config`). */
export const USER_CONFIG_SUBPATH = join('qwen-harness', 'config.json');
/** Administrator-managed policy ceiling. Immutable to any lower source. */
export const DEFAULT_MANAGED_PATH = join('/etc', 'qwen-harness', 'managed.json');

type Env = Record<string, string | undefined>;

export interface ConfigPathOptions {
  /** Project (repository) root the project-scope files are resolved against. */
  readonly projectRoot: string;
  /** Overridable for tests; defaults to the OS home directory. */
  readonly homeDir?: string;
  /** Overridable for tests; defaults to `process.env`. */
  readonly env?: Env;
  /** Overridable for tests / packaging; defaults to `DEFAULT_MANAGED_PATH`. */
  readonly managedPath?: string;
}

export interface ConfigPaths {
  readonly managed: string;
  readonly user: string;
  readonly sharedProject: string;
  readonly localProject: string;
}

function xdgConfigHome(env: Env, home: string): string {
  const xdg = env['XDG_CONFIG_HOME'];
  // The spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) return xdg;
  return join(home, '.config');
}

export function computeConfigPaths(options: ConfigPathOptions): ConfigPaths {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return {
    managed: options.managedPath ?? DEFAULT_MANAGED_PATH,
    user: join(xdgConfigHome(env, home), USER_CONFIG_SUBPATH),
    sharedProject: join(options.projectRoot, PROJECT_CONFIG_DIR, SHARED_PROJECT_FILE),
    localProject: join(options.projectRoot, PROJECT_CONFIG_DIR, LOCAL_PROJECT_FILE),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading a file into a source
// ---------------------------------------------------------------------------------------------

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigFileError(path, 'read', err);
  }
}

/**
 * Load one scope's file. Returns `undefined` when the file is absent (missing contributes
 * nothing). A present file is parsed, migrated to the current schema version, then validated;
 * any failure is a `ConfigFileError` that names the path and the stage that failed.
 */
export function loadConfigFile(
  path: string,
  scope: ConfigScope,
  id: string,
): ConfigSource | undefined {
  const text = readIfPresent(path);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigFileError(path, 'parse', err);
  }

  let migrated;
  try {
    migrated = migrateConfig(parsed);
  } catch (err) {
    throw new ConfigFileError(path, 'migration', err);
  }

  let config: ConfigDoc;
  try {
    config = ConfigDocSchema.parse(migrated.config);
  } catch (err) {
    throw new ConfigFileError(path, 'schema', err);
  }

  return { id, scope, config, origin: { kind: 'file', path } };
}

// ---------------------------------------------------------------------------------------------
// Environment source (allowlist only)
// ---------------------------------------------------------------------------------------------

type RawDoc = Record<string, unknown>;

/** One documented env override: which variable, which key it sets, and how to coerce its value. */
export interface EnvBinding {
  readonly variable: string;
  /** The config key it maps to, for documentation and `doctor`. */
  readonly key: string;
  apply(doc: RawDoc, value: string): void;
}

function parseEnvBool(variable: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new ConfigEnvError(variable, new Error(`expected a boolean, got '${value}'`));
}

/**
 * The COMPLETE set of config keys an environment variable may set. Security-sensitive keys (deny
 * lists, the managed ceiling) are deliberately ABSENT: an env var must never be able to relax a
 * safety decision. Anything not listed here is ignored, so a stray or hostile env var cannot
 * silently steer configuration.
 */
export const ENV_ALLOWLIST: readonly EnvBinding[] = [
  { variable: 'QWEN_HARNESS_MODEL', key: 'model', apply: (d, v) => void (d['model'] = v) },
  { variable: 'QWEN_HARNESS_BASE_URL', key: 'baseUrl', apply: (d, v) => void (d['baseUrl'] = v) },
  {
    variable: 'QWEN_HARNESS_API_KEY_ENV',
    key: 'apiKeyEnv',
    apply: (d, v) => void (d['apiKeyEnv'] = v),
  },
  {
    variable: 'QWEN_HARNESS_REASONING_EFFORT',
    key: 'reasoningEffort',
    apply: (d, v) => void (d['reasoningEffort'] = v),
  },
  {
    variable: 'QWEN_HARNESS_TRANSPORT',
    key: 'transport',
    apply: (d, v) => void (d['transport'] = v),
  },
  {
    variable: 'QWEN_HARNESS_PROFILE',
    key: 'permissionProfile',
    apply: (d, v) => void (d['permissionProfile'] = v),
  },
  {
    variable: 'QWEN_HARNESS_TELEMETRY',
    key: 'telemetry.enabled',
    apply: (d, v) => void (d['telemetry'] = { enabled: parseEnvBool('QWEN_HARNESS_TELEMETRY', v) }),
  },
];

/**
 * Build the env source from allowlisted variables only. Returns `undefined` when none are set, so
 * an env-free run produces no env scope at all.
 */
export function loadEnvSource(env: Env): ConfigSource | undefined {
  const raw: RawDoc = {};
  let touched = false;
  for (const binding of ENV_ALLOWLIST) {
    const value = env[binding.variable];
    if (value === undefined) continue;
    binding.apply(raw, value);
    touched = true;
  }
  if (!touched) return undefined;

  let config: ConfigDoc;
  try {
    config = ConfigDocSchema.parse(raw);
  } catch (err) {
    // Name the variables involved so the failure is actionable.
    const involved = ENV_ALLOWLIST.filter((b) => env[b.variable] !== undefined)
      .map((b) => b.variable)
      .join(', ');
    throw new ConfigEnvError(involved, err);
  }
  return { id: 'env', scope: 'env', config, origin: { kind: 'env' } };
}

// ---------------------------------------------------------------------------------------------
// CLI / session override source
// ---------------------------------------------------------------------------------------------

/**
 * Wrap an explicit CLI / session override (already an object, e.g. parsed from flags) as the
 * highest-precedence source. Validated like any other document so a bad flag fails visibly.
 */
export function loadCliSource(overrides: unknown): ConfigSource {
  let config: ConfigDoc;
  try {
    config = ConfigDocSchema.parse(overrides);
  } catch (err) {
    throw new ConfigError(`invalid CLI/session override: ${describeCause(err)}`);
  }
  return { id: 'cli', scope: 'cli', config, origin: { kind: 'cli' } };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface LoadOptions extends ConfigPathOptions {
  /** Explicit CLI/session overrides, if any. */
  readonly cli?: unknown;
}

export interface LoadedSources {
  /** Every present source EXCEPT the built-in layer, which `resolveConfig` always adds. */
  readonly sources: readonly ConfigSource[];
  readonly paths: ConfigPaths;
}

/**
 * Load every scope present on disk / in the environment, lowest precedence first. The built-in
 * defaults are NOT included here — `resolveConfig` folds them in as the base — so this array
 * contains only what the user or administrator actually provided.
 */
export function loadConfigSources(options: LoadOptions): LoadedSources {
  const paths = computeConfigPaths(options);
  const env = options.env ?? process.env;
  const sources: ConfigSource[] = [];

  const push = (source: ConfigSource | undefined): void => {
    if (source !== undefined) sources.push(source);
  };

  push(loadConfigFile(paths.managed, 'managed', 'managed'));
  push(loadConfigFile(paths.user, 'user', 'user'));
  push(loadConfigFile(paths.sharedProject, 'shared-project', 'shared-project'));
  push(loadConfigFile(paths.localProject, 'local-project', 'local-project'));
  push(loadEnvSource(env));
  if (options.cli !== undefined) push(loadCliSource(options.cli));

  return { sources, paths };
}

export interface LoadedConfig extends LoadedSources {
  readonly resolved: ResolvedConfig;
}

/** Convenience: load every scope and resolve it in one call. What `doctor` and the CLI use. */
export function loadResolvedConfig(options: LoadOptions): LoadedConfig {
  const loaded = loadConfigSources(options);
  return { ...loaded, resolved: resolveConfig(loaded.sources) };
}
