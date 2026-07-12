/**
 * Config schema versioning (PK-03 "schema migration").
 *
 * A config file on disk outlives the binary that wrote it, so every document carries a `version`
 * and is migrated forward to `CONFIG_SCHEMA_VERSION` before it is validated. Two rules make this
 * safe rather than a source of silent corruption:
 *
 *   • An UNKNOWN FUTURE version is a typed error, never a silent downgrade. A newer install may
 *     have written keys this build cannot interpret; pretending we understand them would drop or
 *     misread settings. We refuse and say so.
 *
 *   • Migrations are pure, ordered, and append-only. A shipped migration is a contract with every
 *     file already on disk and is never edited; a fix is a NEW migration.
 *
 * The v0 -> v1 migration is real: v0 was the unversioned pre-release shape (`endpoint`, `keyEnv`,
 * `profile`, `reasoning`). It also DROPS any legacy raw `apiKey` field — a pre-release footgun —
 * rather than carrying a secret forward or inventing an env-var name from a value (SC threat model).
 */

import { CONFIG_SCHEMA_VERSION } from './schema.ts';

export class ConfigMigrationError extends Error {
  override readonly name: string = 'ConfigMigrationError';
}

/** A config written by a NEWER build than this one. We stop rather than guess. */
export class UnknownConfigVersionError extends ConfigMigrationError {
  override readonly name = 'UnknownConfigVersionError';
  constructor(
    readonly version: number,
    readonly maxKnown: number,
  ) {
    super(
      `config schema version ${version} is newer than this build understands (max ${maxKnown}); ` +
        'upgrade the harness rather than editing the version down',
    );
  }
}

type RawDoc = Record<string, unknown>;

interface Migration {
  readonly from: number;
  readonly to: number;
  readonly name: string;
  up(doc: RawDoc, notes: string[]): RawDoc;
}

/** Rename `from` to `to` if present, without clobbering an already-correct `to`. */
function rename(doc: RawDoc, from: string, to: string, notes: string[]): void {
  if (from in doc && !(to in doc)) {
    doc[to] = doc[from];
    notes.push(`renamed '${from}' to '${to}'`);
  }
  delete doc[from];
}

export const CONFIG_MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    name: 'v0-unversioned-to-v1',
    up(doc, notes) {
      const next: RawDoc = { ...doc };
      rename(next, 'endpoint', 'baseUrl', notes);
      rename(next, 'keyEnv', 'apiKeyEnv', notes);
      rename(next, 'profile', 'permissionProfile', notes);
      rename(next, 'reasoning', 'reasoningEffort', notes);
      if ('apiKey' in next) {
        // A raw key must never survive into a validated document. We cannot derive an env-var name
        // from a value, so we drop it and record that a manual `apiKeyEnv` may be needed.
        delete next['apiKey'];
        notes.push(
          'dropped legacy raw `apiKey` (a secret value); set `apiKeyEnv` to a variable NAME',
        );
      }
      next['version'] = 1;
      return next;
    },
  },
];

const MAX_KNOWN_VERSION = CONFIG_MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.to),
  CONFIG_SCHEMA_VERSION,
);

/** Read the declared version. Absent = the unversioned v0 shape; a non-integer version is an error. */
export function readConfigVersion(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigMigrationError('config document must be a JSON object');
  }
  const version = (raw as RawDoc)['version'];
  if (version === undefined) return 0;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new ConfigMigrationError(
      `config 'version' must be a non-negative integer, got ${JSON.stringify(version)}`,
    );
  }
  return version;
}

export interface MigrationResult {
  /** The document at `CONFIG_SCHEMA_VERSION`, ready for `ConfigDocSchema` validation. */
  readonly config: RawDoc;
  readonly fromVersion: number;
  readonly applied: readonly string[];
  /** Human-readable notes (renames, dropped fields) for `doctor` and migration reports. */
  readonly notes: readonly string[];
}

/**
 * Migrate a raw parsed document forward to the current schema version. Deterministic: the same
 * input always yields the same output. Throws `UnknownConfigVersionError` for a future version and
 * `ConfigMigrationError` for a document that is not a versioned object.
 */
export function migrateConfig(raw: unknown): MigrationResult {
  const fromVersion = readConfigVersion(raw);
  if (fromVersion > MAX_KNOWN_VERSION) {
    throw new UnknownConfigVersionError(fromVersion, MAX_KNOWN_VERSION);
  }

  let doc = { ...(raw as RawDoc) };
  const applied: string[] = [];
  const notes: string[] = [];
  let current = fromVersion;

  while (current < CONFIG_SCHEMA_VERSION) {
    const migration = CONFIG_MIGRATIONS.find((m) => m.from === current);
    if (migration === undefined) {
      // A gap in the chain is a build bug, not user input: we know of no way to advance.
      throw new ConfigMigrationError(
        `no migration from config version ${current} toward ${CONFIG_SCHEMA_VERSION}`,
      );
    }
    doc = migration.up(doc, notes);
    applied.push(migration.name);
    current = migration.to;
  }

  return { config: doc, fromVersion, applied, notes };
}
