import { SecretStore, selectBackend } from '@qwen-harness/secret-store';
import { ManualClock } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import { FixtureIssuer } from '../../src/fixtures/issuer.ts';
import { OAuthClient } from '../../src/oauth.ts';

/**
 * The OAuth flow against real local dependencies (MC-07, class I).
 *
 * The full auth-code + PKCE exchange runs through the REAL `SecretStore` (the Linux token-store
 * hierarchy — no plaintext, no colocated master key) and a fixture issuer. The integration property:
 * the token is PERSISTED in the store and REUSED by a fresh client instance — a "restart" reads the
 * durable token from the hierarchy rather than re-authorizing.
 */

describe('OAuth flow persists + reuses a token via the real SecretStore (MC-07 I)', () => {
  let store: SecretStore;
  let issuer: FixtureIssuer;
  let clock: ManualClock;

  const clientOn = (): OAuthClient =>
    new OAuthClient(
      {
        server: 'gh',
        issuer: issuer.baseUrl,
        clientId: 'client-1',
        redirectUri: 'https://app.example/callback',
        scopes: ['mcp'],
      },
      { gateway: issuer, secretStore: store, clock, randomBytes: (n) => Buffer.alloc(n, 7) },
    );

  beforeEach(() => {
    clock = new ManualClock(1_000_000);
    store = new SecretStore(selectBackend({ libsecretAvailable: () => false }));
    issuer = new FixtureIssuer();
  });

  it('runs the flow, persists the token, and a FRESH client reuses it without re-authorizing', async () => {
    const client = clientOn();
    const meta = await client.discover();
    const pending = client.beginAuthorization(meta);
    const { code, state } = issuer.authorize(pending.authorizationUrl);
    const token = await client.exchangeCode(
      meta,
      client.handleCallback({ code, state }, pending),
      pending,
    );
    expect(token.accessToken).toMatch(/^access_/);

    // Persisted in the real store (the token-store hierarchy), not a log line or plaintext field.
    const raw = await store.get('mcp.oauth.gh');
    expect(raw).not.toBeNull();

    // A fresh client instance — as a new process would build — reads the DURABLE token and reuses it.
    const restarted = clientOn();
    expect(await restarted.accessToken(meta)).toBe(token.accessToken);
  });
});
