import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRedactor } from '@qwen-harness/storage';
import { ALL_CANARIES, CANARY_API_KEY, ManualClock } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maybeExtract, MemoryStore, type Memory } from '../../src/index.ts';

/**
 * Adversarial evidence for MM-03: a secret must NEVER end up in a stored memory, whether it comes in
 * through extraction or is smuggled into a write. Two independent barriers must both hold:
 *   1. Extraction REJECTS any candidate that contains secret-shaped material.
 *   2. The store REDACTS at the persistence boundary, so even a bypass of (1) writes no secret.
 */
describe('memory never stores a secret (MM-03, S)', () => {
  let dir: string;
  const clock = new ManualClock(1_700_000_000_000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-memsec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extraction rejects a candidate carrying any canary; nothing is extracted', () => {
    for (const canary of ALL_CANARIES) {
      const result = maybeExtract(
        { completed: true, cancelled: false },
        {
          propose: () => [
            { name: 'leaky', description: 'a note', type: 'project', body: `secret: ${canary}` },
          ],
          redactor: createRedactor(),
        },
      );
      expect(result.extracted).toHaveLength(0);
      expect(result.rejected[0]?.kind).toBe('contains-secret');
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  it('the storage boundary redacts a secret that reaches a write, leaving no canary on disk', async () => {
    const store = new MemoryStore({ clock, redactor: createRedactor() });
    const leaky: Memory = {
      name: 'runbook',
      description: 'deploy runbook',
      type: 'project',
      body: `Use ${CANARY_API_KEY} for the staging deploy. Also Authorization: Bearer ${CANARY_API_KEY}.`,
    };
    await store.writeMemory(dir, leaky, 'project');

    // Read the RAW bytes of every file the store produced — none may contain the canary.
    for (const entry of readdirSync(dir)) {
      const raw = readFileSync(join(dir, entry), 'utf8');
      expect(raw).not.toContain(CANARY_API_KEY);
    }
  });

  it('a live model-key value registered on the redactor is scrubbed from a memory too', async () => {
    const liveKey = CANARY_API_KEY;
    const store = new MemoryStore({ clock, redactor: createRedactor([liveKey]) });
    await store.writeMemory(
      dir,
      { name: 'note', description: 'x', type: 'user', body: `token ${liveKey}` },
      'user',
    );
    const raw = readFileSync(join(dir, 'note.md'), 'utf8');
    expect(raw).not.toContain(liveKey);
    expect(raw).toContain('[REDACTED]');
  });
});
