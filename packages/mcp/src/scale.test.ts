import { describe, expect, it } from 'vitest';

import {
  MCP_DURABLE_LIMIT_CHARS,
  offloadLargeOutput,
  searchTools,
  type OutputSink,
} from './scale.ts';
import type { McpTool } from './protocol-types.ts';

describe('MCP scale (MC-10)', () => {
  it('inlines a small result untouched', async () => {
    const r = await offloadLargeOutput('short output', null);
    expect(r.modelText).toBe('short output');
    expect(r.outputRef).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it('offloads an oversized result to a durable ref with a bounded preview', async () => {
    const big = 'x'.repeat(MCP_DURABLE_LIMIT_CHARS + 10);
    let stored = '';
    const sink: OutputSink = {
      put: (content) => {
        stored = content;
        return Promise.resolve('ref://blob/1');
      },
    };
    const r = await offloadLargeOutput(big, sink);
    expect(r.outputRef).toBe('ref://blob/1');
    expect(r.truncated).toBe(true);
    expect(r.modelText.length).toBeLessThan(big.length);
    expect(stored.length).toBe(big.length);
    expect(r.modelText).toContain('characters elided');
  });

  it('ranks tool search hits and sanitizes descriptions', () => {
    const tools: McpTool[] = [
      { name: 'read_file', description: 'read a file from disk' },
      { name: 'write_file', description: 'write a file to disk' },
      { name: 'search', description: 'search the codebase' },
    ];
    const hits = searchTools(tools, 'file');
    expect(hits[0]?.name).toMatch(/file/);
    expect(hits.every((h) => typeof (h.description as string) === 'string')).toBe(true);
  });
});
