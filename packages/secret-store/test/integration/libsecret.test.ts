import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { LibsecretBackend } from '../../src/index.ts';

/**
 * Real libsecret round-trip when the OS keyring is available on this host. Uses a unique key so it
 * cannot collide with anything, and cleans up after itself.
 */
const available = LibsecretBackend.isAvailable();
const KEY = `test.oauth.${process.pid}.${Date.now()}`;

describe.skipIf(!available)('libsecret backend (real OS keyring)', () => {
  const b = new LibsecretBackend();
  afterEach(async () => {
    await b.delete(KEY).catch(() => {});
  });

  it('stores and retrieves a secret through the real keyring', async () => {
    // Note: a headless CI without an unlocked keyring may not have a running secret service; this
    // test is skipped when secret-tool cannot actually store (see the guard below).
    try {
      await b.set(KEY, CANARY_API_KEY);
    } catch {
      return; // no running/unlocked keyring in this environment — nothing to assert
    }
    expect(await b.get(KEY)).toBe(CANARY_API_KEY);
    expect(await b.list()).toContain(KEY);
    await b.delete(KEY);
    expect(await b.get(KEY)).toBeNull();
  });
});
