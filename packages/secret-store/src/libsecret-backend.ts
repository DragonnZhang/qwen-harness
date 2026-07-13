import { execFileSync } from 'node:child_process';

import { SECRET_NAMESPACE, SecretStoreError, type SecretBackend } from './backend.ts';

/**
 * The Linux Secret Service backend, via `secret-tool` (libsecret). The OS keyring is the preferred
 * store: the kernel/session keeps the material, we never write it to a file ourselves.
 *
 * Every entry is tagged with our namespace and the logical key, so lookups are exact and we never
 * touch another application's secrets. The secret value is passed to `secret-tool` on STDIN, never
 * on the command line — an argv is visible in `/proc`, and a token must not appear there.
 */
export class LibsecretBackend implements SecretBackend {
  readonly kind = 'libsecret' as const;
  readonly persistent = true;

  static isAvailable(): boolean {
    try {
      execFileSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  set(key: string, value: string): Promise<void> {
    try {
      // `store` reads the secret from STDIN — never from argv (which /proc would expose).
      execFileSync(
        'secret-tool',
        ['store', '--label', `${SECRET_NAMESPACE}:${key}`, 'service', SECRET_NAMESPACE, 'key', key],
        { input: value, stdio: ['pipe', 'ignore', 'pipe'], timeout: 10_000 },
      );
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(this.#wrap('store', e));
    }
  }

  get(key: string): Promise<string | null> {
    try {
      const out = execFileSync('secret-tool', ['lookup', 'service', SECRET_NAMESPACE, 'key', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      });
      // secret-tool returns the value with no trailing newline; a missing key exits non-zero.
      return Promise.resolve(out.length > 0 ? out : null);
    } catch {
      // A lookup miss is a non-zero exit, not an error — return null.
      return Promise.resolve(null);
    }
  }

  delete(key: string): Promise<void> {
    try {
      execFileSync('secret-tool', ['clear', 'service', SECRET_NAMESPACE, 'key', key], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(this.#wrap('clear', e));
    }
  }

  list(): Promise<string[]> {
    try {
      // `search --all` prints attributes; parse our `key` attribute out of each record.
      const out = execFileSync('secret-tool', ['search', '--all', 'service', SECRET_NAMESPACE], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      });
      const keys = new Set<string>();
      for (const line of out.split('\n')) {
        const m = /^attribute\.key = (.+)$/.exec(line.trim());
        if (m) keys.add(m[1]!);
      }
      return Promise.resolve([...keys].sort());
    } catch {
      // No matches -> non-zero exit -> empty list.
      return Promise.resolve([]);
    }
  }

  #wrap(op: string, e: unknown): SecretStoreError {
    return new SecretStoreError(
      'io-error',
      `secret-tool ${op} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
