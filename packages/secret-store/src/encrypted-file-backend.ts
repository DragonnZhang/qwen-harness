import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { SecretStoreError, type SecretBackend } from './backend.ts';

/**
 * The encrypted-file backend. AES-256-GCM, mode 0600, master key from a SEPARATE provider.
 *
 * The two rules that make this safe (defaults.md, threat model):
 *   - the master key is NEVER stored beside the ciphertext — it comes from an injected provider
 *     (an env var read at the app boundary, or a separate keyfile), so compromising the ciphertext
 *     file alone yields nothing;
 *   - every write is atomic (temp file + rename) and mode 0600, so a crash never leaves a
 *     half-written or world-readable secrets file.
 *
 * GCM gives authenticated encryption: a tampered file fails to decrypt rather than yielding garbage.
 */

interface EncryptedEntry {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}
interface EncryptedFile {
  readonly version: 1;
  readonly salt: string;
  readonly entries: Record<string, EncryptedEntry>;
}

export interface EncryptedFileOptions {
  readonly path: string;
  /**
   * The master key material, supplied by an approved provider. This is NOT stored — it is used to
   * derive the encryption key at runtime. If absent, the backend is unavailable (fail closed).
   */
  readonly masterKey: string;
}

export class EncryptedFileBackend implements SecretBackend {
  readonly kind = 'encrypted-file' as const;
  readonly persistent = true;
  readonly #path: string;
  readonly #masterKey: string;

  constructor(opts: EncryptedFileOptions) {
    if (!opts.masterKey || opts.masterKey.length < 8) {
      throw new SecretStoreError(
        'no-master-key',
        'encrypted-file backend requires a master key from a separate approved provider',
      );
    }
    this.#path = opts.path;
    this.#masterKey = opts.masterKey;
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.#read();
    const derived = scryptSync(this.#masterKey, Buffer.from(file.salt, 'base64'), 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const next: EncryptedFile = {
      ...file,
      entries: {
        ...file.entries,
        [key]: {
          iv: iv.toString('base64'),
          tag: tag.toString('base64'),
          data: enc.toString('base64'),
        },
      },
    };
    this.#write(next);
    await Promise.resolve();
  }

  async get(key: string): Promise<string | null> {
    const file = this.#read();
    const entry = file.entries[key];
    if (entry === undefined) return null;
    const derived = scryptSync(this.#masterKey, Buffer.from(file.salt, 'base64'), 32);
    try {
      const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const dec = Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]);
      return await Promise.resolve(dec.toString('utf8'));
    } catch {
      // Authentication failed — a wrong master key or a tampered file. Never return garbage.
      throw new SecretStoreError(
        'decrypt-failed',
        `cannot decrypt secret ${key}: wrong key or tampered file`,
      );
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.#read();
    if (!(key in file.entries)) return;
    const entries = { ...file.entries };
    delete entries[key];
    this.#write({ ...file, entries });
    await Promise.resolve();
  }

  list(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.#read().entries).sort());
  }

  #read(): EncryptedFile {
    if (!existsSync(this.#path)) {
      return { version: 1, salt: randomBytes(16).toString('base64'), entries: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as EncryptedFile;
      if (parsed.version !== 1) throw new Error('unknown version');
      return parsed;
    } catch (e) {
      throw new SecretStoreError(
        'io-error',
        `secrets file is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  #write(file: EncryptedFile): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    // Atomic: write a temp file, set 0600, then rename over the target. A crash mid-write leaves the
    // previous file intact and never a partial or world-readable one.
    const tmp = `${this.#path}.tmp-${randomBytes(6).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#path);
    chmodSync(this.#path, 0o600);
  }
}
