import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualClock } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MemoryStore,
  runDream,
  serializeMemory,
  type DreamModelInput,
  type DreamState,
  type Memory,
} from '../../src/index.ts';

/** Dream orchestration against REAL files (MM-04): eligibility, one model call, atomic no-write. */
describe('runDream integration (MM-04)', () => {
  let dir: string;
  let store: MemoryStore;
  const clock = new ManualClock(30 * 24 * 60 * 60 * 1000); // 30 days in

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-dream-'));
    store = new MemoryStore({ clock });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeMemoryFile = (stem: string, m: Memory, mtimeSec?: number): string => {
    const path = join(dir, `${stem}.md`);
    writeFileSync(path, serializeMemory(m));
    if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
    return path;
  };

  const seedMemories = (count: number): void => {
    for (let i = 0; i < count; i++) {
      writeMemoryFile(`topic-${i}`, {
        name: `topic-${i}`,
        description: `description ${i}`,
        type: 'project',
        body: `body ${i}`,
      });
    }
  };

  const eligibleState: DreamState = {
    sessionsSinceLastConsolidation: 5,
    lastConsolidationAt: null,
  };
  const summarize = (input: DreamModelInput) => ({
    summary: `Consolidated ${input.memories.length} memories.`,
  });

  it('runs when eligible: exactly one model call, index rebuilt with the summary', async () => {
    seedMemories(10);
    let calls = 0;
    const result = await runDream({
      store,
      clock,
      dir,
      scope: 'project',
      state: eligibleState,
      summarize: (input) => {
        calls++;
        return summarize(input);
      },
    });

    expect(result.ran).toBe(true);
    expect(result.written).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.modelCalls).toBe(1);
    expect(calls).toBe(1);
    expect(result.inputTokens).toBeLessThanOrEqual(64_000);
    expect(result.outputTokens).toBeLessThanOrEqual(8_000);

    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    expect(index).toContain('Consolidated 10 memories.');
    expect(index).toContain('topic-0');
  });

  it('resolves a same-name conflict on disk, keeping the newer and removing the loser', async () => {
    seedMemories(10);
    // Two files with mismatched stems but the SAME frontmatter name -> a conflict.
    const older = writeMemoryFile(
      'note-old',
      { name: 'note', description: 'old', type: 'project', body: 'use tabs' },
      1000,
    );
    const newer = writeMemoryFile(
      'note-new',
      { name: 'note', description: 'new', type: 'project', body: 'use two spaces' },
      9000,
    );

    const result = await runDream({
      store,
      clock,
      dir,
      scope: 'project',
      state: eligibleState,
      summarize,
    });

    expect(result.written).toBe(true);
    expect(result.plan?.conflicts.map((c) => c.name)).toContain('note');
    // Both mismatched-stem files are gone; the canonical note.md holds the newer body.
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(false);
    const canonical = readFileSync(join(dir, 'note.md'), 'utf8');
    expect(canonical).toContain('use two spaces');
  });

  it('does NOT run when there are too few candidates (eligibility short-circuit)', async () => {
    seedMemories(3);
    let calls = 0;
    const result = await runDream({
      store,
      clock,
      dir,
      scope: 'project',
      state: eligibleState,
      summarize: (input) => {
        calls++;
        return summarize(input);
      },
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('not-enough-candidates');
    expect(calls).toBe(0);
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false);
  });

  it('does NOT run twice within 24h', async () => {
    seedMemories(10);
    const twelveHoursAgo = clock.now() - 12 * 60 * 60 * 1000;
    const result = await runDream({
      store,
      clock,
      dir,
      scope: 'project',
      state: { sessionsSinceLastConsolidation: 100, lastConsolidationAt: twelveHoursAgo },
      summarize,
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('within-24h');
  });

  it('writes NOTHING when the model result fails the schema check (MM-04)', async () => {
    seedMemories(10);
    await store.writeIndex(dir, '# prior index\n');

    const result = await runDream({
      store,
      clock,
      dir,
      scope: 'project',
      state: eligibleState,
      summarize: () => ({
        summary: 'attempted rewrite',
        memories: [
          { name: 'valid-one', description: 'ok', type: 'project', body: 'fine' },
          { name: 'INVALID NAME', description: 'bad slug', type: 'project', body: 'nope' },
        ],
      }),
    });

    expect(result.written).toBe(false);
    expect(result.reason).toBe('schema-check-failed');
    // The model was consulted once, but nothing was committed: the prior index is intact and the
    // original topic files remain.
    expect(result.modelCalls).toBe(1);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('# prior index\n');
    expect(existsSync(join(dir, 'topic-0.md'))).toBe(true);
    expect(existsSync(join(dir, 'valid-one.md'))).toBe(false);
  });

  it('caps the model input to the 64K token budget by trimming candidates', async () => {
    // One oversized memory (~400 KiB) blows past 64K tokens on its own; the input must be trimmed.
    writeMemoryFile('huge', {
      name: 'huge',
      description: 'oversized',
      type: 'project',
      body: 'z'.repeat(400 * 1024),
    });
    seedMemories(10);
    let sawTokens = Infinity;
    const result = await runDream({
      store,
      clock,
      dir,
      scope: 'project',
      state: eligibleState,
      summarize: (input) => {
        sawTokens = input.memories.reduce((n, m) => n + m.body.length, 0) / 4;
        return { summary: 'ok' };
      },
    });
    expect(result.written).toBe(true);
    expect(result.inputTokens).toBeLessThanOrEqual(64_000);
    expect(sawTokens).toBeLessThanOrEqual(64_000);
  });
});
