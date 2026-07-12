/**
 * Child-environment minimization.
 *
 * The rule (threat model, "Secret handling"): a child environment uses an ALLOWLIST, and the
 * provider credential is not on it. This file names no secret at all — it cannot leak one by
 * mentioning it, and the architecture gate proves that only the provider boundary ever names the
 * credential. The allowlist is POSITIVE: a variable the child sees is one we deliberately chose to
 * pass, never one we forgot to strip.
 */

/** The only host variables a sandboxed tool has any business inheriting. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
];

export interface EnvMinimizeOptions {
  /** Extra variable NAMES to allow through (never values). */
  readonly allow?: readonly string[];
  /** Values to force, overriding anything inherited. HOME/TMPDIR are set to the scratch dir. */
  readonly overrides?: Readonly<Record<string, string>>;
}

/**
 * Build the child environment from the parent's, keeping only allowlisted names and then applying
 * overrides. A name that is not on the allowlist and not an override simply does not exist for the
 * child — there is no code path by which the provider key, an SSH agent socket, or an AWS session
 * token reaches a sandboxed tool.
 */
export function minimizeEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  options: EnvMinimizeOptions = {},
): Record<string, string> {
  const allowed = new Set([...DEFAULT_ENV_ALLOWLIST, ...(options.allow ?? [])]);
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = parentEnv[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    result[name] = value;
  }
  // A predictable minimal PATH if the parent had none — a sandbox with no PATH cannot find `sh`.
  if (result['PATH'] === undefined) result['PATH'] = '/usr/bin:/bin';
  return result;
}
