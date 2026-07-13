import { createHash } from 'node:crypto';

import { SecretStore, selectBackend } from '@qwen-harness/secret-store';
import { ManualClock } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import { FixtureIssuer } from './fixtures/issuer.ts';
import { McpError } from './errors.ts';
import { OAuthClient, computeCodeChallenge, type PendingAuthorization } from './oauth.ts';

function newClient(): {
  client: OAuthClient;
  issuer: FixtureIssuer;
  store: SecretStore;
  clock: ManualClock;
} {
  const clock = new ManualClock(1_000_000);
  const store = new SecretStore(selectBackend({ libsecretAvailable: () => false }));
  const issuer = new FixtureIssuer();
  const client = new OAuthClient(
    {
      server: 'gh',
      issuer: issuer.baseUrl,
      clientId: 'client-1',
      redirectUri: 'https://app.example/callback',
      scopes: ['mcp'],
    },
    { gateway: issuer, secretStore: store, clock, randomBytes: (n) => Buffer.alloc(n, 7) },
  );
  return { client, issuer, store, clock };
}

describe('OAuth 2.0 + PKCE (MC-07)', () => {
  let ctx: ReturnType<typeof newClient>;
  beforeEach(() => {
    ctx = newClient();
  });

  it('code_challenge is the S256 of the verifier', async () => {
    const meta = await ctx.client.discover();
    const pending = ctx.client.beginAuthorization(meta);
    const expected = createHash('sha256').update(pending.codeVerifier).digest('base64url');
    expect(pending.codeChallenge).toBe(expected);
    expect(computeCodeChallenge(pending.codeVerifier)).toBe(expected);
    expect(pending.codeChallenge).not.toBe(pending.codeVerifier);
  });

  it('runs the full auth-code flow to a token stored in the secret store', async () => {
    const meta = await ctx.client.discover();
    const pending = ctx.client.beginAuthorization(meta);
    const { code, state } = ctx.issuer.authorize(pending.authorizationUrl);
    const returnedCode = ctx.client.handleCallback({ code, state }, pending);
    const token = await ctx.client.exchangeCode(meta, returnedCode, pending);

    expect(token.accessToken).toMatch(/^access_/);
    expect(token.refreshToken).toMatch(/^refresh_/);
    // Persisted via the store — never returned in a log line.
    const raw = await ctx.store.get('mcp.oauth.gh');
    expect(raw).not.toBeNull();
    expect(raw).toContain('access_');
  });

  it('refreshes and then revokes, clearing the stored token', async () => {
    const meta = await ctx.client.discover();
    const pending = ctx.client.beginAuthorization(meta);
    const { code, state } = ctx.issuer.authorize(pending.authorizationUrl);
    const token = await ctx.client.exchangeCode(
      meta,
      ctx.client.handleCallback({ code, state }, pending),
      pending,
    );

    const refreshed = await ctx.client.refresh(meta, token.refreshToken!);
    expect(refreshed.accessToken).not.toBe(token.accessToken);

    await ctx.client.revoke(meta, refreshed.refreshToken!, 'refresh_token');
    expect(await ctx.store.get('mcp.oauth.gh')).toBeNull();
  });

  it('a valid access token is reused; an expired one auto-refreshes', async () => {
    const meta = await ctx.client.discover();
    const pending = ctx.client.beginAuthorization(meta);
    const { code, state } = ctx.issuer.authorize(pending.authorizationUrl);
    const token = await ctx.client.exchangeCode(
      meta,
      ctx.client.handleCallback({ code, state }, pending),
      pending,
    );

    expect(await ctx.client.accessToken(meta)).toBe(token.accessToken);
    ctx.clock.advance(4_000_000); // past the 1h lifetime
    const fresh = await ctx.client.accessToken(meta);
    expect(fresh).not.toBe(token.accessToken);
  });

  it('rejects a state mismatch on the callback (CSRF)', async () => {
    const meta = await ctx.client.discover();
    const pending: PendingAuthorization = ctx.client.beginAuthorization(meta);
    expect(() =>
      ctx.client.handleCallback({ code: 'x', state: 'attacker-state' }, pending),
    ).toThrow(McpError);
    try {
      ctx.client.handleCallback({ code: 'x', state: 'attacker-state' }, pending);
    } catch (err) {
      expect((err as McpError).class).toBe('auth');
    }
  });
});
