import { describe, expect, it } from 'vitest';

import { type McpConfigLayer, type ManagedMcpPolicy, resolveMcpServers } from './config.ts';

function stdio(name: string, command: string): McpConfigLayer['servers'][number] {
  return { name, transport: { type: 'stdio', command } };
}

describe('MCP config precedence + trust (MC-05)', () => {
  it('a higher source overrides a lower one for the same server', () => {
    const layers: McpConfigLayer[] = [
      { source: 'user', servers: [stdio('db', 'user-cmd')] },
      { source: 'approved-project', servers: [stdio('db', 'project-cmd')] },
      { source: 'local', servers: [stdio('db', 'local-cmd')] },
    ];
    const [resolved] = resolveMcpServers({ layers, trustedServers: new Set(['db']) });
    expect(resolved?.source).toBe('local');
    expect(resolved?.config.transport).toMatchObject({ command: 'local-cmd' });
    expect(resolved?.overriddenBy).toEqual(['user', 'approved-project']);
  });

  it('a project server is NOT trusted (and not active) without explicit trust', () => {
    const layers: McpConfigLayer[] = [{ source: 'local', servers: [stdio('sketchy', 'x')] }];
    const [untrusted] = resolveMcpServers({ layers });
    expect(untrusted?.trusted).toBe(false);
    expect(untrusted?.active).toBe(false);
    expect(untrusted?.inactiveReason).toMatch(/trust/);

    const [trusted] = resolveMcpServers({ layers, trustedServers: new Set(['sketchy']) });
    expect(trusted?.trusted).toBe(true);
    expect(trusted?.active).toBe(true);
  });

  it('a user (non-project) server is trusted without a trust prompt', () => {
    const [resolved] = resolveMcpServers({
      layers: [{ source: 'user', servers: [stdio('user-srv', 'x')] }],
    });
    expect(resolved?.trusted).toBe(true);
    expect(resolved?.active).toBe(true);
  });

  it('managed-exclusive policy is the ceiling — an unlisted server cannot run', () => {
    const managed: ManagedMcpPolicy = {
      exclusive: true,
      allowedServers: ['approved'],
      deniedServers: [],
    };
    const layers: McpConfigLayer[] = [
      { source: 'user', servers: [stdio('approved', 'a'), stdio('other', 'b')] },
    ];
    const resolved = resolveMcpServers({ layers, managed });
    const approved = resolved.find((r) => r.config.name === 'approved');
    const other = resolved.find((r) => r.config.name === 'other');
    expect(approved?.active).toBe(true);
    expect(other?.active).toBe(false);
    expect(other?.inactiveReason).toMatch(/exclusive/);
  });

  it('a managed deny dominates every source', () => {
    const managed: ManagedMcpPolicy = {
      exclusive: false,
      allowedServers: [],
      deniedServers: ['blocked'],
    };
    const [resolved] = resolveMcpServers({
      layers: [{ source: 'local', servers: [stdio('blocked', 'x')] }],
      managed,
      trustedServers: new Set(['blocked']),
    });
    expect(resolved?.active).toBe(false);
    expect(resolved?.inactiveReason).toMatch(/managed/);
  });
});
