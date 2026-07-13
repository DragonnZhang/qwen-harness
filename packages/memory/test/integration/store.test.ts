import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRedactor } from '@qwen-harness/storage';
import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { ManualClock } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore, recordsToCandidates, retrieve, type Memory } from '../../src/index.ts';

/** The on-disk store against REAL files in a REAL temp dir (MM-01, MM-02, MM-05). */
describe('MemoryStore integration', () => {
  let dir: string;
  let store: MemoryStore;
  const clock = new ManualClock(1_700_000_000_000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-memory-'));
    store = new MemoryStore({ clock });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const memory = (name: string, description: string, body: string): Memory => ({
    name,
    description,
    type: 'project',
    body,
  });

  it('writes then reads a memory back, byte-for-byte through the format', async () => {
    const m = memory('pnpm-usage', 'Build and test with pnpm', 'Run `pnpm test`.');
    const { path } = await store.writeMemory(dir, m, 'project');
    const record = await store.readMemory(path, 'project');
    expect(record.memory).toEqual(m);
    expect(record.provenance.scope).toBe('project');
  });

  it('lists memories and isolates one unreadable/malformed file (MM-02, F)', async () => {
    await store.writeMemory(dir, memory('good-one', 'first', 'a'), 'project');
    await store.writeMemory(dir, memory('good-two', 'second', 'b'), 'project');
    // A malformed memory file (no closing fence) must not break the whole listing.
    writeFileSync(join(dir, 'broken.md'), '---\nname: broken\n');

    const result = await store.listMemories(dir, 'project');
    expect(result.records.map((r) => r.memory.name).sort()).toEqual(['good-one', 'good-two']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain('broken.md');
  });

  it('retrieval over the store skips the malformed file and returns the match', async () => {
    await store.writeMemory(
      dir,
      memory('jitter-note', 'retry backoff jitter', 'full jitter'),
      'project',
    );
    writeFileSync(join(dir, 'broken.md'), 'not a memory at all');
    const { records } = await store.listMemories(dir, 'project');
    const result = retrieve('jitter', recordsToCandidates(records));
    expect(result.memories.map((m) => m.name)).toEqual(['jitter-note']);
  });

  it('loads MEMORY.md truncated to the first 200 lines (MM-01)', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n'));
    const loaded = await store.loadIndex(dir);
    expect(loaded.truncated).toBe(true);
    expect(loaded.lines).toBe(200);
    expect(loaded.content).not.toContain('line 201');
  });

  it('returns an empty index when MEMORY.md is absent', async () => {
    const loaded = await store.loadIndex(dir);
    expect(loaded.content).toBe('');
    expect(loaded.truncated).toBe(false);
  });

  it('redacts a secret at the storage boundary so no memory file contains it (MM-03, S)', async () => {
    const redactingStore = new MemoryStore({ clock, redactor: createRedactor() });
    const m = memory('deploy', 'deploy steps', `token is ${CANARY_API_KEY} keep safe`);
    const { path } = await redactingStore.writeMemory(dir, m, 'project');
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain(CANARY_API_KEY);
    expect(onDisk).toContain('[REDACTED]');
  });
});
