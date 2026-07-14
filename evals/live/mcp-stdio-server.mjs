#!/usr/bin/env node
/**
 * A REAL MCP server, in a REAL separate process, speaking REAL JSON-RPC 2.0 over stdio.
 *
 * This is a live-test fixture, not product code: it is never bundled and the CLI gains no flag to
 * reach it. It exists so the LIVE MCP test (`mcp.test.ts`) connects the real DashScope model to a
 * genuine second-process server that implements the protocol — `initialize`, `tools/list`,
 * `tools/call` — rather than to an in-process fake. A transport tested only against a mock has not
 * been tested.
 *
 * It exposes ONE read-only tool, `fetch_project_codeword`, whose answer the model cannot possibly
 * know on its own. That is the point: the only way for the model to answer the prompt is to actually
 * call the tool, so a passing turn proves the live model chose to invoke MCP and the result flowed
 * back through the harness.
 */

const CODEWORDS = {
  atlas: 'marmalade-quokka-1987',
  orion: 'clockwork-tangerine-2043',
};

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
          serverInfo: { name: 'demo', version: '1.0.0' },
        },
      });

    case 'tools/list':
      return send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'fetch_project_codeword',
              description:
                'Return the secret codeword for a project. The codeword is not derivable and ' +
                'must be fetched from this tool.',
              inputSchema: {
                type: 'object',
                properties: {
                  project: { type: 'string', description: 'The project name, e.g. "atlas".' },
                },
                required: ['project'],
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });

    case 'tools/call': {
      const { name, arguments: args } = request.params ?? {};
      if (name === 'fetch_project_codeword') {
        const project = String(args?.project ?? '')
          .trim()
          .toLowerCase();
        const codeword = CODEWORDS[project] ?? 'unknown-project';
        return send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: `The codeword for ${project} is ${codeword}.` }],
          },
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
