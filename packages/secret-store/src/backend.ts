/**
 * The secret-store backend contract.
 *
 * Secrets here are OAuth tokens (access/refresh), authorization codes, and client secrets — the
 * same class of material as the model key, and treated with the same care (defaults.md, "OAuth
 * token storage"). A backend either stores a secret securely or refuses; it never stores one
 * insecurely as a fallback.
 *
 * Three backends, in preference order (SB/MC-07):
 *   1. Linux Secret Service (libsecret) — the OS keyring.
 *   2. An encrypted 0600 file whose master key comes from a SEPARATE approved provider — never
 *      colocated with the ciphertext.
 *   3. In-memory only — session-scoped; it REFUSES to persist, so a headless host with no secure
 *      option cannot silently write tokens to disk in the clear.
 */

export type BackendKind = 'libsecret' | 'encrypted-file' | 'memory';

export interface SecretBackend {
  readonly kind: BackendKind;
  /** True if this backend persists across process restarts. `memory` does not. */
  readonly persistent: boolean;

  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export class SecretStoreError extends Error {
  constructor(
    readonly code:
      | 'backend-unavailable'
      | 'refused-persistent'
      | 'io-error'
      | 'decrypt-failed'
      | 'no-master-key',
    message: string,
  ) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/** A namespace prefix so this product's secrets never collide with other keyring entries. */
export const SECRET_NAMESPACE = 'qwen-harness';
