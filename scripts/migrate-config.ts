/**
 * PK-02 — config migration, as a shipped, runnable command.
 *
 * The installer calls this on every install, upgrade and rollback. A config file on disk outlives
 * the binary that wrote it, so an upgrade that leaves a v0 document in place — or, worse, a
 * DOWNgrade (rollback) that leaves a v2 document in front of a v1 binary — is exactly how a
 * harness silently loses a setting.
 *
 * There is NO migration logic in this file. It is a thin CLI over `@qwen-harness/config`'s existing
 * `migrateConfig` + `ConfigDocSchema`: the same ordered, append-only chain the product itself runs
 * at load time. A second implementation of migration would be a second source of truth, and the two
 * would drift.
 *
 * Behaviour:
 *   --check   report what WOULD change; exit 0 if already current, 4 if a migration is pending
 *   (write)   migrate in place, after writing a `.bak-v<from>` snapshot next to the file
 *
 * A config from a NEWER build (rollback case) is a typed `UnknownConfigVersionError` and is left
 * strictly alone: refusing is the only safe answer, because this binary cannot know what the keys
 * it does not recognise were protecting. It exits 5 and says so.
 *
 * Exit codes: 0 no-op/migrated · 1 usage · 3 unreadable or invalid config · 4 pending (--check)
 *             5 config is newer than this build (rollback beyond the config's floor)
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_SCHEMA_VERSION,
  ConfigDocSchema,
  UnknownConfigVersionError,
  migrateConfig,
  readConfigVersion,
} from '@qwen-harness/config';

interface Options {
  readonly path: string;
  readonly check: boolean;
}

function userConfigPath(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'qwen-harness', 'config.json');
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Options | null {
  let path: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined) return null;
      path = next;
      i += 1;
    } else if (arg === '-h' || arg === '--help') return null;
    else return null;
  }
  return { path: path ?? userConfigPath(env), check };
}

const USAGE = `qwen-harness-migrate-config [--config PATH] [--check]

  Migrate a qwen-harness config document forward to schema version ${String(CONFIG_SCHEMA_VERSION)},
  using the product's own migration chain (@qwen-harness/config).

  --config PATH   the document to migrate (default: $XDG_CONFIG_HOME/qwen-harness/config.json)
  --check         report only; change nothing. Exit 4 when a migration is pending.

  A backup is written to PATH.bak-v<from> before any in-place change.`;

export function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
): number {
  const options = parseArgs(argv, env);
  if (options === null) {
    out(USAGE);
    return 1;
  }

  const { path, check } = options;

  if (!existsSync(path)) {
    // No config is a perfectly good config: every value has a builtin default. This is the common
    // case on a first install and must not be an error, or every fresh install "fails" to migrate.
    out(`config: none at ${path} — nothing to migrate (builtin defaults apply)`);
    return 0;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    out(`config: ✗ ${path} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  let from: number;
  try {
    from = readConfigVersion(raw);
  } catch (e) {
    out(`config: ✗ ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  if (from === CONFIG_SCHEMA_VERSION) {
    out(
      `config: ${path} is already at schema version ${String(CONFIG_SCHEMA_VERSION)} — no change`,
    );
    return 0;
  }

  let result;
  try {
    result = migrateConfig(raw);
  } catch (e) {
    if (e instanceof UnknownConfigVersionError) {
      // The rollback hazard. Do not touch the file, do not "fix" the version field.
      out(`config: ✗ ${path} is at schema version ${String(e.version)}, newer than this build`);
      out(`        understands (max ${String(e.maxKnown)}).`);
      out('        This build will not downgrade it: the keys it cannot interpret may be the ones');
      out('        holding this host to a tighter policy. Roll FORWARD, or restore the config');
      out(`        backup taken by the newer install (${path}.bak-v*).`);
      return 5;
    }
    out(`config: ✗ ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  const applied = result.applied.length > 0 ? result.applied.join(', ') : '(none)';
  out(`config: ${path}`);
  out(`  schema v${String(result.fromVersion)} -> v${String(CONFIG_SCHEMA_VERSION)}`);
  out(`  migrations: ${applied}`);
  for (const note of result.notes) out(`    · ${note}`);

  // Validate the MIGRATED document against the real schema before writing it back. A migration that
  // produces something the loader would reject is a bug we must catch here, not at next startup.
  const parsed = ConfigDocSchema.safeParse(result.config);
  if (!parsed.success) {
    out('  ✗ the migrated document does not satisfy ConfigDocSchema; the file was NOT changed:');
    for (const issue of parsed.error.issues) {
      out(`      ${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
    return 3;
  }

  if (check) {
    out('  (--check: nothing was written)');
    return 4;
  }

  const backup = `${path}.bak-v${String(result.fromVersion)}`;
  copyFileSync(path, backup);
  writeFileSync(path, `${JSON.stringify(result.config, null, 2)}\n`, 'utf8');
  out(`  ✓ migrated in place. Previous document saved to ${backup}`);
  return 0;
}

// Only act when executed as a program, so the packaging tests can import `run` directly.
if (process.argv[1] !== undefined && /migrate-config/.test(process.argv[1])) {
  process.exit(
    run(process.argv.slice(2), process.env, (s) => {
      console.log(s);
    }),
  );
}
