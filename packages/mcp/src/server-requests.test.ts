import type { ActorId } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { McpError } from './errors.ts';
import { MCP_METHODS } from './protocol-types.ts';
import {
  DeferredSchemaCache,
  ServerRequestRouter,
  schemaDigest,
  type ToolSchemaState,
} from './server-requests.ts';

const ACTOR = { kind: 'mcp' as const, id: 'act_mcp0001' as ActorId };

describe('reverse channel routing (MC-08)', () => {
  it('routes elicitation through the injected channel with sanitized text', async () => {
    let seenMessage = '';
    const router = new ServerRequestRouter({
      server: 's',
      actor: ACTOR,
      elicitation: {
        elicit: (req) => {
          seenMessage = req.message as string;
          return Promise.resolve({ action: 'accept', content: { answer: 'yes' } });
        },
      },
    });
    const ESC = String.fromCharCode(27);
    const res = await router.handle(MCP_METHODS.elicitationCreate, {
      message: `please confirm${ESC}[2J`,
      requestedSchema: {},
    });
    expect(res).toMatchObject({ action: 'accept' });
    expect(seenMessage).not.toContain(ESC);
    expect(seenMessage).toContain('please confirm');
  });

  it('denies a capability the policy gate refuses — a server cannot enable itself', async () => {
    const router = new ServerRequestRouter({
      server: 's',
      actor: ACTOR,
      elicitation: { elicit: () => Promise.resolve({ action: 'accept' }) },
      allowCapability: () => false,
    });
    await expect(
      router.handle(MCP_METHODS.elicitationCreate, { message: 'x' }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('refuses server-driven sampling by default', async () => {
    const router = new ServerRequestRouter({ server: 's', actor: ACTOR });
    await expect(router.handle(MCP_METHODS.samplingCreate, {})).rejects.toBeInstanceOf(McpError);
  });
});

describe('deferred schema cache (MC-09)', () => {
  const state = (name: string, schema: unknown, deferred = false): ToolSchemaState => ({
    name,
    schemaDigest: schemaDigest(schema),
    deferred,
  });

  it('preserves the stable prefix when only a deferred schema changes', () => {
    const cache = new DeferredSchemaCache();
    cache.reconcile([state('a', { x: 1 }), state('lazy', { y: 1 }, true)]);
    // The deferred tool's schema changes; the eager prefix is untouched.
    const r = cache.reconcile([state('a', { x: 1 }), state('lazy', { y: 2 }, true)]);
    expect(r.prefixPreserved).toBe(true);
    expect(r.invalidated).toEqual([]);
  });

  it('invalidates only the affected boundary when an eager schema changes', () => {
    const cache = new DeferredSchemaCache();
    cache.reconcile([state('a', { x: 1 }), state('b', { y: 1 })]);
    const r = cache.reconcile([state('a', { x: 2 }), state('b', { y: 1 })]);
    expect(r.prefixPreserved).toBe(false);
    expect(r.invalidated).toEqual(['a']);
  });

  it('tracks additions and removals without leaking a removed schema', () => {
    const cache = new DeferredSchemaCache();
    cache.reconcile([state('a', { x: 1 })]);
    const r = cache.reconcile([state('b', { y: 1 })]);
    expect(r.added).toEqual(['b']);
    expect(r.removed).toEqual(['a']);
  });
});
