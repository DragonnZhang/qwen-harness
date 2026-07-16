import type { ActorId } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { McpError } from './errors.ts';
import { MCP_METHODS } from './protocol-types.ts';
import { ServerRequestRouter } from './server-requests.ts';

/**
 * A hostile or malformed reverse request from a server is refused fail-closed, never crashing the
 * client or opening a privileged path (MC-08, F).
 *
 * The reverse channel is the most dangerous surface an MCP server has: it lets the server ask the
 * CLIENT to do things. Every unsupported, unconfigured, or policy-denied request must terminate in a
 * typed `McpError` — not a thrown-through exception, not a silent success, and never the effect the
 * server asked for.
 */

const ACTOR = { kind: 'mcp' as const, id: 'act_mcp0001' as ActorId };

describe('the reverse channel fails closed on a hostile server request (MC-08, F)', () => {
  it('an arbitrary/unknown method is refused — a server cannot invoke client internals', async () => {
    const router = new ServerRequestRouter({ server: 'evil', actor: ACTOR });
    await expect(router.handle('client/shutdown', {})).rejects.toBeInstanceOf(McpError);
    await expect(router.handle('../../escape', { x: 1 })).rejects.toBeInstanceOf(McpError);
  });

  it('elicitation with NO channel configured is refused, not silently accepted', async () => {
    // A server tries to elicit before any user-facing channel exists — there is no path to grant it.
    const router = new ServerRequestRouter({ server: 'evil', actor: ACTOR });
    await expect(
      router.handle(MCP_METHODS.elicitationCreate, { message: 'give me your token' }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('a policy-denied elicitation is refused even when a channel IS configured', async () => {
    let elicited = false;
    const router = new ServerRequestRouter({
      server: 'evil',
      actor: ACTOR,
      elicitation: {
        elicit: () => {
          elicited = true;
          return Promise.resolve({ action: 'accept' });
        },
      },
      allowCapability: () => false,
    });
    await expect(
      router.handle(MCP_METHODS.elicitationCreate, { message: 'x' }),
    ).rejects.toBeInstanceOf(McpError);
    // The gate ran BEFORE the channel — the elicitation callback was never reached.
    expect(elicited).toBe(false);
  });

  it('roots with no provider returns an empty list — a safe default, not a crash', async () => {
    const router = new ServerRequestRouter({ server: 's', actor: ACTOR });
    const res = (await router.handle(MCP_METHODS.rootsList, {})) as { roots: unknown[] };
    expect(res.roots).toEqual([]);
  });
});
