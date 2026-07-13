import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EncryptedFileBackend, SecretStoreError } from '../../src/index.ts';

describe('encrypted-file backend (defaults.md OAuth storage)', () => {
  let dir: string;
  let path: string;
  const MASTER = 'master-key-from-a-separate-provider-not-colocated';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-secret-'));
    path = join(dir, 'secrets.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('requires a master key — no key, no backend (fail closed)', () => {
    expect(() => new EncryptedFileBackend({ path, masterKey: '' })).toThrow(SecretStoreError);
  });

  it('round-trips a secret and writes a mode-0600 file', async () => {
    const b = new EncryptedFileBackend({ path, masterKey: MASTER });
    await b.set('oauth.token', CANARY_API_KEY);
    expect(await b.get('oauth.token')).toBe(CANARY_API_KEY);

    // The file is 0600 — not world/group readable.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('the ciphertext file NEVER contains the plaintext secret or the master key', async () => {
    const b = new EncryptedFileBackend({ path, masterKey: MASTER });
    await b.set('oauth.token', CANARY_API_KEY);
    const raw = readFileSync(path, 'utf8');
    // The whole point of encryption: neither the secret nor the master key is in the file.
    expect(raw).not.toContain(CANARY_API_KEY);
    expect(raw).not.toContain(MASTER);
  });

  it('a WRONG master key cannot decrypt (authenticated encryption)', async () => {
    const b = new EncryptedFileBackend({ path, masterKey: MASTER });
    await b.set('oauth.token', CANARY_API_KEY);

    const attacker = new EncryptedFileBackend({ path, masterKey: 'a-different-key-entirely-9999' });
    await expect(attacker.get('oauth.token')).rejects.toThrow(/decrypt|tampered|wrong/i);
  });

  it('a TAMPERED file fails to decrypt rather than returning garbage', async () => {
    const b = new EncryptedFileBackend({ path, masterKey: MASTER });
    await b.set('oauth.token', CANARY_API_KEY);
    // Flip the ciphertext.
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: Record<string, { data: string }>;
    };
    file.entries['oauth.token']!.data = Buffer.from('tampered-data-here').toString('base64');
    writeFileSync(path, JSON.stringify(file));

    await expect(b.get('oauth.token')).rejects.toThrow(SecretStoreError);
  });

  it('survives multiple keys and deletes', async () => {
    const b = new EncryptedFileBackend({ path, masterKey: MASTER });
    await b.set('a', '1');
    await b.set('b', '2');
    expect(await b.list()).toEqual(['a', 'b']);
    await b.delete('a');
    expect(await b.list()).toEqual(['b']);
    expect(await b.get('b')).toBe('2');
    // The file still exists and is coherent.
    expect(existsSync(path)).toBe(true);
  });
});
