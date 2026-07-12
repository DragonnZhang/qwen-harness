import type { HarnessError } from '@qwen-harness/protocol';
import { harnessError } from '@qwen-harness/protocol';

/**
 * The credential boundary (PV-12, requirement 13).
 *
 * This package is the ONLY reader of the key in the whole product — `pnpm architecture` rule 6
 * fails the build if any other package so much as names the environment variable. Configuration
 * everywhere else stores the variable's NAME, never its value.
 *
 * `CredentialSource` exists so that the real secret store can be substituted later without this
 * package changing: `secret-store` will implement this interface, and the env-backed default below
 * remains the fallback and the doctor's baseline.
 */
export const DASHSCOPE_API_KEY_ENV = 'DASHSCOPE_API_KEY';

export interface CredentialSource {
  /** Where the key comes from, e.g. `env:DASHSCOPE_API_KEY`. NEVER the key itself. */
  readonly description: string;
  /** The key, or `null` when it is not configured. Callers must not log the return value. */
  read(): string | null;
}

export class EnvCredentialSource implements CredentialSource {
  readonly description: string;
  readonly #envVar: string;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(
    envVar: string = DASHSCOPE_API_KEY_ENV,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.#envVar = envVar;
    this.#env = env;
    this.description = `env:${envVar}`;
  }

  read(): string | null {
    const value = this.#env[this.#envVar];
    // An empty or whitespace-only variable is *not* a credential. Treating `export KEY=` as a
    // present key would turn a clear "you have no key" into an opaque 401 from the server.
    return value !== undefined && value.trim() !== '' ? value : null;
  }
}

/** A source that never has a key. Used by `plan` mode and by tests that must not reach a network. */
export class NoCredentialSource implements CredentialSource {
  readonly description = 'none';
  read(): string | null {
    return null;
  }
}

export function missingCredentialError(source: CredentialSource): HarnessError {
  return harnessError({
    origin: 'config',
    category: 'provider.credential.missing',
    message:
      `No DashScope API key found (${source.description}). ` +
      `Set ${DASHSCOPE_API_KEY_ENV} in the environment, then retry. ` +
      'The harness stores the variable name, never its value.',
    retryable: false,
    userActionRequired: true,
    sideEffectCertainty: 'not-started',
  });
}

/**
 * Resolve the key or fail. Called BEFORE the request is constructed, so a missing key can never
 * turn into a live HTTP round trip that leaks the fact that we tried.
 */
export function requireApiKey(source: CredentialSource): string {
  const key = source.read();
  if (key === null) throw missingCredentialError(source);
  return key;
}
