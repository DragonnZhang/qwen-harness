import { describe, expect, it } from 'vitest';

import { MemorySecretBackend, SecretStore, SecretStoreError, selectBackend } from './index.ts';

describe('backend selection (MC-07, fail-safe)', () => {
  it('prefers libsecret when available', () => {
    const sel = selectBackend({ libsecretAvailable: () => true });
    expect(sel.kind).toBe('libsecret');
  });

  it('falls back to an encrypted file when libsecret is absent AND a master key is provided', () => {
    const sel = selectBackend({
      libsecretAvailable: () => false,
      encryptedFilePath: '/tmp/x/secrets.json',
      masterKey: 'a-master-key-from-elsewhere',
    });
    expect(sel.kind).toBe('encrypted-file');
  });

  it('falls back to MEMORY when neither is available — never an insecure disk write', () => {
    const sel = selectBackend({ libsecretAvailable: () => false });
    expect(sel.kind).toBe('memory');
    expect(sel.backend.persistent).toBe(false);
  });

  it('memory backend REFUSES to pretend it persisted', () => {
    const mem = new MemorySecretBackend();
    expect(() => mem.requirePersistent()).toThrow(SecretStoreError);
  });

  it('a store round-trips through memory', async () => {
    const store = new SecretStore(selectBackend({ libsecretAvailable: () => false }));
    await store.set('oauth.github', 'token-abc');
    expect(await store.get('oauth.github')).toBe('token-abc');
    expect(await store.list()).toEqual(['oauth.github']);
    await store.delete('oauth.github');
    expect(await store.get('oauth.github')).toBeNull();
  });
});
