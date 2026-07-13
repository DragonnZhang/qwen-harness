/**
 * @qwen-harness/secret-store
 *
 * Secure storage for OAuth tokens, authorization codes, and client secrets (MC-07) — the same class
 * of material as the model key, treated with the same care.
 *
 * Three backends in preference order: Linux Secret Service (libsecret), an encrypted 0600 file whose
 * master key comes from a SEPARATE provider (never colocated with the ciphertext), and in-memory —
 * which REFUSES to persist rather than writing a token to disk in the clear. The store never
 * silently downgrades to an insecure store; the worst case fails safe.
 *
 * A declared I/O owner: the only package that opens the OS keyring or a secrets file.
 */

export { SecretStore, selectBackend } from './store.ts';
export type { SelectBackendOptions, BackendSelection } from './store.ts';
export { SecretStoreError, SECRET_NAMESPACE } from './backend.ts';
export type { SecretBackend, BackendKind } from './backend.ts';
export { MemorySecretBackend } from './memory-backend.ts';
export { EncryptedFileBackend } from './encrypted-file-backend.ts';
export { LibsecretBackend } from './libsecret-backend.ts';
