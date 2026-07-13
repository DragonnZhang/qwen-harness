import { McpError } from './errors.ts';
import type { McpClient } from './client.ts';

/**
 * Bounded parallel connect across many servers (MC-06). Connecting 20 servers must not open 20
 * handshakes at once, and — crucially — one server's failure must not sink the others. Each result
 * is captured independently as connected-or-classified-error, and at most `concurrency` connects
 * run at a time.
 */
export interface ConnectOutcome {
  readonly server: string;
  readonly ok: boolean;
  readonly error: McpError | null;
}

export async function connectAll(
  clients: readonly McpClient[],
  concurrency = 4,
): Promise<ConnectOutcome[]> {
  const results: ConnectOutcome[] = new Array<ConnectOutcome>(clients.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= clients.length) return;
      const client = clients[index];
      if (client === undefined) return;
      try {
        await client.connect();
        results[index] = { server: client.server, ok: true, error: null };
      } catch (err) {
        const mcpError =
          err instanceof McpError
            ? err
            : new McpError('connection', err instanceof Error ? err.message : String(err), {
                server: client.server,
              });
        results[index] = { server: client.server, ok: false, error: mcpError };
      }
    }
  };

  const pool = Math.max(1, Math.min(concurrency, clients.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}
