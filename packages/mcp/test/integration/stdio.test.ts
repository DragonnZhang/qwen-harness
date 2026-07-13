/**
 * Integration: a REAL child process over stdio. A tiny Node MCP echo server is written to a temp
 * file and spawned; the client connects over stdin/stdout, initializes, calls a tool, and shuts
 * the process down cleanly (MC-02/MC-06). Stdio is the workhorse local transport, so it is proven
 * against an actual OS process, not a stub.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { McpClient, StdioTransport } from '../../src/index.ts';

// A minimal, standards-conformant MCP echo server: newline-delimited JSON-RPC over stdio.
const SERVER_SOURCE = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
function handle(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'stdio-echo', version: '1.0.0' },
    });
  } else if (msg.method === 'notifications/initialized') {
    // no response to a notification
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [
        { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      ],
    });
  } else if (msg.method === 'tools/call') {
    const text = (msg.params && msg.params.arguments && msg.params.arguments.text) || '';
    reply(msg.id, { content: [{ type: 'text', text: 'echo:' + text }], isError: false });
  } else if (msg.method === 'ping') {
    reply(msg.id, {});
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no method' } }) + '\\n');
  }
}
`;

let dir: string;
let scriptPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qwen-mcp-stdio-'));
  scriptPath = join(dir, 'server.cjs');
  writeFileSync(scriptPath, SERVER_SOURCE, 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('stdio transport (MC-02) — real child process', () => {
  it('connects, calls a tool, and shuts down cleanly', async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [scriptPath],
      terminationGraceMs: 500,
    });
    const client = new McpClient({
      server: 'stdio-echo',
      transport,
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });

    await client.connect();
    expect(client.state).toBe('ready');
    expect(client.serverInfo?.serverInfo.name).toBe('stdio-echo');
    expect(client.tools.map((t) => t.name)).toEqual(['echo']);

    const out = await client.callTool('echo', { text: 'hi' });
    expect(out.text).toBe('echo:hi');

    // Graceful termination: closing stdin makes the well-behaved server exit.
    await client.disconnect();
    expect(client.state).toBe('disconnected');
  });
});
