import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MCP_CONFIG_SOURCES,
  MCP_SOURCE_RANK,
  resolveMcpServers,
  type McpConfigLayer,
} from './config.ts';

/**
 * MCP precedence and trust as properties (MC-05).
 *
 * For ANY set of sources defining the same server, the highest-ranked one wins
 * (`connector < plugin < user < approved-project < local`). And the trust rule holds for every
 * source: a PROJECT-sourced server (`approved-project`/`local`) is active only when the user has
 * explicitly trusted it — a repository can never make its own server run — while a non-project server
 * (`connector`/`plugin`/`user`) is trusted without a prompt.
 */

const stdio = (name: string, command: string): McpConfigLayer['servers'][number] => ({
  name,
  transport: { type: 'stdio', command },
});

describe('MCP precedence + trust (MC-05, P)', () => {
  it('the highest-rank source that defines a server always wins', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...MCP_CONFIG_SOURCES), { minLength: 1 }),
        (sources) => {
          const layers: McpConfigLayer[] = sources.map((s) => ({
            source: s,
            servers: [stdio('srv', `cmd-${s}`)],
          }));
          const [resolved] = resolveMcpServers({ layers, trustedServers: new Set(['srv']) });
          const winner = sources.reduce((a, b) =>
            MCP_SOURCE_RANK[a] >= MCP_SOURCE_RANK[b] ? a : b,
          );
          expect(resolved?.source).toBe(winner);
          expect(resolved?.config.transport).toMatchObject({ command: `cmd-${winner}` });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a project server is active iff explicitly trusted; a non-project one is always active', () => {
    fc.assert(
      fc.property(fc.constantFrom(...MCP_CONFIG_SOURCES), fc.boolean(), (source, trust) => {
        const layers: McpConfigLayer[] = [{ source, servers: [stdio('srv', 'x')] }];
        const [r] = resolveMcpServers({
          layers,
          ...(trust ? { trustedServers: new Set(['srv']) } : {}),
        });
        const isProject = source === 'approved-project' || source === 'local';
        if (isProject) {
          expect(r?.trusted).toBe(trust);
          expect(r?.active).toBe(trust);
        } else {
          expect(r?.trusted).toBe(true);
          expect(r?.active).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
