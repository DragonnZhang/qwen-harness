import type { InProcessServer, ServerToClient } from '../transports/in-process.ts';
import { MCP_METHODS, PROTOCOL_VERSION } from '../protocol-types.ts';

/**
 * A tiny in-process MCP server for tests and as a reference built-in server. It implements the real
 * initialize/list/call methods, so a round trip against it exercises the genuine client path — it
 * is not a stub that shortcuts the protocol.
 *
 * It offers two tools on purpose: a read-only `echo` and a `delete_all` marked destructive, so a
 * policy test can prove a mutating MCP tool is gated exactly like a built-in mutation (MC-04).
 */
export class EchoMcpServer implements InProcessServer {
  #sink: ServerToClient | null = null;
  #extraTool = false;

  attachClient(sink: ServerToClient): void {
    this.#sink = sink;
  }

  handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case MCP_METHODS.initialize:
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: { name: 'echo-fixture', version: '1.0.0' },
          instructions: 'echo server',
        });
      case MCP_METHODS.listTools:
        return Promise.resolve({ tools: this.#tools() });
      case MCP_METHODS.callTool:
        return Promise.resolve(this.#call(params));
      case MCP_METHODS.listResources:
        return Promise.resolve({
          resources: [{ uri: 'echo://greeting', name: 'greeting', mimeType: 'text/plain' }],
        });
      case MCP_METHODS.readResource:
        return Promise.resolve({
          contents: [{ uri: 'echo://greeting', mimeType: 'text/plain', text: 'hello' }],
        });
      case MCP_METHODS.listPrompts:
        return Promise.resolve({
          prompts: [
            {
              name: 'greet',
              description: 'greet someone',
              arguments: [{ name: 'who', required: true }],
            },
          ],
        });
      case MCP_METHODS.getPrompt:
        return Promise.resolve({
          messages: [{ role: 'user', content: { type: 'text', text: 'hello there' } }],
        });
      case MCP_METHODS.ping:
        return Promise.resolve({});
      default:
        return Promise.reject(new Error(`method not found: ${method}`));
    }
  }

  #tools(): unknown[] {
    const tools: unknown[] = [
      {
        name: 'echo',
        description: 'Echo the input text back.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: 'delete_all',
        description: 'Delete everything (destructive).',
        inputSchema: { type: 'object', properties: {} },
        annotations: { destructiveHint: true },
      },
    ];
    if (this.#extraTool) {
      tools.push({
        name: 'added_later',
        description: 'A tool that appeared after a list_changed.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      });
    }
    return tools;
  }

  #call(params: unknown): unknown {
    const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    if (p.name === 'echo') {
      const text = typeof p.arguments?.['text'] === 'string' ? p.arguments['text'] : '';
      return { content: [{ type: 'text', text }], isError: false };
    }
    if (p.name === 'delete_all') {
      return { content: [{ type: 'text', text: 'deleted' }], isError: false };
    }
    return { content: [{ type: 'text', text: `unknown tool ${String(p.name)}` }], isError: true };
  }

  /** Simulate a dynamic catalog change: add a tool and notify the client (MC-06 list_changed). */
  triggerListChanged(): void {
    this.#extraTool = true;
    this.#sink?.notify(MCP_METHODS.toolsListChanged);
  }

  /** Simulate a server-initiated elicitation request (reverse channel). */
  async elicit(message: string): Promise<unknown> {
    if (this.#sink === null) throw new Error('not attached');
    return this.#sink.request(MCP_METHODS.elicitationCreate, { message, requestedSchema: {} });
  }
}
