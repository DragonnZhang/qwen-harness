#!/usr/bin/env node
/**
 * A REAL MCP server, in a REAL separate process, speaking REAL JSON-RPC over stdio.
 *
 * This is a test fixture, not product code: it is never bundled and the CLI gains no flag to reach
 * it. It exists so `mcp.test.ts` connects to something that actually implements the protocol —
 * newline-delimited JSON-RPC 2.0, `initialize`, `tools/list`, `tools/call` — rather than to an
 * in-process fake. A stdio transport that is only ever tested against a mock has not been tested.
 *
 * It exposes one tool, `echo`, annotated as READ-ONLY, and one, `destroy`, that is not. The pair
 * lets the test prove that the harness's own annotation classification (and therefore its policy
 * decision) follows what the server declares.
 */

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    handle(JSON.parse(line));
  }
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(request) {
  // A notification has no id and expects no response.
  if (request.id === undefined || request.id === null) return;

  switch (request.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo', version: '1.0.0' },
        },
      });

    case 'tools/list':
      return send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo a message straight back.',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'destroy',
              description: 'Pretends to destroy something. Declares itself destructive.',
              inputSchema: {
                type: 'object',
                properties: { target: { type: 'string' } },
                required: ['target'],
              },
              annotations: { readOnlyHint: false, destructiveHint: true },
            },
          ],
        },
      });

    case 'tools/call': {
      const { name, arguments: args } = request.params ?? {};
      if (name === 'echo') {
        return send({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: `echo: ${args?.message ?? ''}` }] },
        });
      }
      if (name === 'destroy') {
        return send({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: `destroyed ${args?.target ?? ''}` }] },
        });
      }
      return send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: `unknown tool: ${name}` },
      });
    }

    case 'ping':
      return send({ jsonrpc: '2.0', id: request.id, result: {} });

    default:
      return send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `method not found: ${request.method}` },
      });
  }
}
