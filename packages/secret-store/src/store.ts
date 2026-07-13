import { SecretStoreError, type BackendKind, type SecretBackend } from './backend.ts';
import { EncryptedFileBackend } from './encrypted-file-backend.ts';
import { LibsecretBackend } from './libsecret-backend.ts';
import { MemorySecretBackend } from './memory-backend.ts';

/**
 * Backend selection (MC-07). The store picks the strongest AVAILABLE backend and reports which one,
 * so `doctor` can tell the user whether their tokens are on the keyring, in an encrypted file, or
 * only in memory for the session. It never silently downgrades to an insecure store — the worst
 * case is `memory`, which refuses to persist rather than writing a token in the clear.
 */
export interface SelectBackendOptions {
  /** Force a specific backend (tests). Otherwise the strongest available is chosen. */
  readonly prefer?: BackendKind;
  /** Path for the encrypted-file backend. */
  readonly encryptedFilePath?: string;
  /** Master key for the encrypted-file backend, from a SEPARATE approved provider (never colocated). */
  readonly masterKey?: string;
  /** Injected for tests, so libsecret availability can be simulated. */
  readonly libsecretAvailable?: () => boolean;
}

export interface BackendSelection {
  readonly backend: SecretBackend;
  readonly kind: BackendKind;
  /** Human-readable, for doctor. */
  readonly detail: string;
}

export function selectBackend(opts: SelectBackendOptions = {}): BackendSelection {
  const libsecretAvailable = opts.libsecretAvailable ?? (() => LibsecretBackend.isAvailable());

  const wants = (kind: BackendKind) => opts.prefer === undefined || opts.prefer === kind;

  // 1. Libsecret — the OS keyring, strongest.
  if (wants('libsecret') && libsecretAvailable()) {
    return {
      backend: new LibsecretBackend(),
      kind: 'libsecret',
      detail: 'Linux Secret Service (libsecret)',
    };
  }

  // 2. Encrypted file — only if a master key from a separate provider is available.
  if (
    wants('encrypted-file') &&
    opts.encryptedFilePath !== undefined &&
    opts.masterKey !== undefined
  ) {
    return {
      backend: new EncryptedFileBackend({
        path: opts.encryptedFilePath,
        masterKey: opts.masterKey,
      }),
      kind: 'encrypted-file',
      detail: `encrypted 0600 file at ${opts.encryptedFilePath} (master key from a separate provider)`,
    };
  }

  // 3. Memory — session only; refuses to persist. The safe last resort.
  if (wants('memory') || opts.prefer === undefined) {
    return {
      backend: new MemorySecretBackend(),
      kind: 'memory',
      detail: 'in-memory only (no secure persistent store available; OAuth persistence refused)',
    };
  }

  throw new SecretStoreError(
    'backend-unavailable',
    `requested secret backend ${opts.prefer} is not available`,
  );
}

/**
 * The public secret store. A thin, redaction-aware facade over a chosen backend. Values are OAuth
 * tokens and client secrets — never logged, never returned in an error, only handed back to the
 * exact caller that asked by key.
 */
export class SecretStore {
  readonly #backend: SecretBackend;
  readonly kind: BackendKind;

  constructor(selection: BackendSelection) {
    this.#backend = selection.backend;
    this.kind = selection.kind;
  }

  get persistent(): boolean {
    return this.#backend.persistent;
  }

  set(key: string, value: string): Promise<void> {
    return this.#backend.set(key, value);
  }
  get(key: string): Promise<string | null> {
    return this.#backend.get(key);
  }
  delete(key: string): Promise<void> {
    return this.#backend.delete(key);
  }
  list(): Promise<string[]> {
    return this.#backend.list();
  }
}
