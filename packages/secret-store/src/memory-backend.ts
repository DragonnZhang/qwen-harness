import { SecretStoreError, type SecretBackend } from './backend.ts';

/**
 * The in-memory backend. Session-scoped only.
 *
 * It exists as the LAST resort on a host with no secure persistent option — and it makes that
 * situation safe by REFUSING to pretend it persisted. Nothing is written to disk, so a token can
 * never leak into a file in the clear; the tradeoff (tokens are lost on restart) is the correct one
 * when the alternative is an insecure write.
 */
export class MemorySecretBackend implements SecretBackend {
  readonly kind = 'memory' as const;
  readonly persistent = false;
  readonly #store = new Map<string, string>();

  set(key: string, value: string): Promise<void> {
    this.#store.set(key, value);
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#store.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.#store.delete(key);
    return Promise.resolve();
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.#store.keys()].sort());
  }

  /** Refuse a caller that explicitly needs persistence — better an error than a silent memory store. */
  requirePersistent(): never {
    throw new SecretStoreError(
      'refused-persistent',
      'no secure persistent secret store is available on this host; refusing to persist OAuth credentials',
    );
  }
}
