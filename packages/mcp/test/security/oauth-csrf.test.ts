/**
 * Security: OAuth callback CSRF and PKCE binding (MC-07).
 *
 *  - A callback whose `state` does not match the one we minted is rejected BEFORE any exchange.
 *  - The authorization code is bound to the PKCE challenge: a code presented with the wrong
 *    verifier is refused by the issuer.
 */
import { SecretStore, selectBackend } from '@qwen-harness/secret-store';
import { ManualClock } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { FixtureIssuer, McpError, OAuthClient } from '../../src/index.ts';

function client(randomSeed: number): { client: OAuthClient; issuer: FixtureIssuer } {
  const issuer = new FixtureIssuer();
  const oauth = new OAuthClient(
    { server: 'gh', issuer: issuer.baseUrl, clientId: 'c', redirectUri: 'https://app/cb' },
    {
      gateway: issuer,
      secretStore: new SecretStore(selectBackend({ libsecretAvailable: () => false })),
      clock: new ManualClock(0),
      randomBytes: (n) => Buffer.alloc(n, randomSeed),
    },
  );
  return { client: oauth, issuer };
}

describe('OAuth CSRF + PKCE binding (MC-07 security)', () => {
  it('rejects a callback with a forged state', async () => {
    const { client: c } = client(3);
    const meta = await c.discover();
    const pending = c.beginAuthorization(meta);
    expect(() => c.handleCallback({ code: 'stolen', state: 'attacker' }, pending)).toThrow(
      McpError,
    );
  });

  it('refuses an exchange when the PKCE verifier does not match the challenge', async () => {
    const { client: c, issuer } = client(4);
    const meta = await c.discover();
    const legit = c.beginAuthorization(meta);
    const { code, state } = issuer.authorize(legit.authorizationUrl);
    const validCode = c.handleCallback({ code, state }, legit);

    // Attacker replays the code but with a DIFFERENT verifier (a fresh pending with a new challenge).
    const forged = { ...legit, codeVerifier: 'a-different-verifier-entirely' };
    await expect(c.exchangeCode(meta, validCode, forged)).rejects.toBeInstanceOf(McpError);
  });
});
