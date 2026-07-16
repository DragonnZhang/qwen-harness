import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../src/index.ts';

/**
 * Offloaded tool output is content-addressed, so a transcript reference can never be a traversal
 * vector (TL-10, S).
 *
 * Large tool results are offloaded to the durable blob store under a CONTENT DIGEST key
 * (`blb_<hash>`, see `apps/cli/src/context.ts`), and retrieved only by that digest. A blob is NEVER
 * addressed by a path, so even if a tool's output is itself a path-traversal string, the reference the
 * transcript carries is a hash — it cannot be turned into a read of `../../etc/passwd`.
 */

describe('blob store is digest-addressed, never path-addressed (TL-10, S)', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-blob-'));
    store = new EventStore({
      path: join(dir, 'sessions.sqlite'),
      clock: new ManualClock(1),
      ids: new SequentialIds(),
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retrieves a blob only by its exact digest key', () => {
    const digest = 'blb_deadbeef';
    store.putBlob(digest, 'the full offloaded tool output');
    expect(store.readBlob(digest)).toBe('the full offloaded tool output');
    // A different (even one-char-off) key does not resolve.
    expect(store.readBlob('blb_deadbeee')).toBeUndefined();
  });

  it('a path or traversal string is not a valid blob key — it reads nothing', () => {
    store.putBlob('blb_abc123', 'secret transcript content');
    for (const attempt of [
      '../../../../etc/passwd',
      '/etc/passwd',
      '..\\..\\windows\\system32',
      'blb_abc123/../../../etc/passwd',
      './blb_abc123',
    ]) {
      expect(store.readBlob(attempt), `path-like key must not resolve: ${attempt}`).toBeUndefined();
    }
  });

  it('the SAME content the offloader stores is retrievable by its digest, and only that', () => {
    // Mirror the offload: the key is a `blb_`-prefixed hash, the value is the raw output — even when
    // that output is itself a path-traversal string, it is inert CONTENT, never a lookup path.
    const maliciousOutput = '../../../../etc/passwd\n'.repeat(200);
    const digest = 'blb_ffee0011';
    store.putBlob(digest, maliciousOutput);
    expect(store.readBlob(digest)).toBe(maliciousOutput); // by digest: fine
    expect(store.readBlob(maliciousOutput)).toBeUndefined(); // the content-as-key: nothing
  });
});
