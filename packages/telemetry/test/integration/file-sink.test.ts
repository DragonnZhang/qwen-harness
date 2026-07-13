import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualClock } from '@qwen-harness/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTraceSink, Tracer } from '../../src/index.ts';

describe('FileTraceSink', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-trace-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes redacted JSONL that reads back as one record per line', () => {
    const path = join(dir, 'nested', 'trace.jsonl');
    const tracer = new Tracer({
      clock: new ManualClock(1000),
      sink: new FileTraceSink(path),
      redact: (v) => v,
    });
    tracer.info('a.b', 'first', { n: 1 });
    tracer.warn('c.d', 'second', { n: 2 });

    // The file (and its parent dir) were created on demand.
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { category: string; ts: number; fields: { n: number } };
    expect(first).toMatchObject({ category: 'a.b', ts: 1000, fields: { n: 1 } });
  });
});
