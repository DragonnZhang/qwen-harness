/**
 * Integration: the full client round trip against an in-process MCP server. Connect → initialize →
 * list tools → call a tool → receive a result → dynamic list_changed refresh → disconnect. This is
 * the real `McpClient` and the real `JsonRpcPeer`; only the transport is in-memory (MC-01/MC-06).
 */
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { EchoMcpServer, InProcessTransport, McpClient } from '../../src/index.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeClient(server: EchoMcpServer): McpClient {
  return new McpClient({
    server: 'echo',
    transport: new InProcessTransport(server),
    clock: new ManualClock(0),
    ids: new SequentialIds(),
    capabilities: { elicitation: {} },
  });
}

describe('in-process round trip (MC-01)', () => {
  it('connects, initializes, discovers, and calls a tool', async () => {
    const server = new EchoMcpServer();
    const client = makeClient(server);

    await client.connect();
    expect(client.state).toBe('ready');
    expect(client.serverInfo?.serverInfo.name).toBe('echo-fixture');

    // Discovery found the tools and namespaced them.
    expect(client.tools.map((t) => t.name).sort()).toEqual(['delete_all', 'echo']);
    expect(client.namedTools.map((t) => t.name)).toContain('mcp__echo__echo');
    expect(client.resources.length).toBe(1);
    expect(client.prompts.length).toBe(1);

    // THE round trip: call the tool, get the echoed result back.
    const out = await client.callTool('echo', { text: 'round trip' });
    expect(out.isError).toBe(false);
    expect(out.text).toBe('round trip');

    expect(await client.ping()).toBe(true);
    await client.disconnect();
    expect(client.state).toBe('disconnected');
  });

  it('refreshes tools dynamically on a list_changed notification (MC-06)', async () => {
    const server = new EchoMcpServer();
    const client = makeClient(server);
    await client.connect();
    expect(client.tools.map((t) => t.name)).not.toContain('added_later');

    server.triggerListChanged();
    await waitFor(() => client.tools.some((t) => t.name === 'added_later'));
    expect(client.namedTools.map((t) => t.name)).toContain('mcp__echo__added_later');

    await client.disconnect();
  });

  it('reads a resource and gets a prompt', async () => {
    const server = new EchoMcpServer();
    const client = makeClient(server);
    await client.connect();
    const resource = await client.readResource('echo://greeting');
    expect(resource.contents[0]).toMatchObject({ text: 'hello' });
    const prompt = await client.getPrompt('greet', { who: 'world' });
    expect(prompt.messages.length).toBe(1);
    await client.disconnect();
  });
});
