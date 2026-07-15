import { createHash } from 'node:crypto';

import { SecretStore, selectBackend } from '@qwen-harness/secret-store';
import { ManualClock } from '@qwen-harness/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FixtureIssuer } from './fixtures/issuer.ts';
import { OAuthClient, computeCodeChallenge } from './oauth.ts';

/**
 * OAuth resilience for MC-07: the PKCE challenge as a PROPERTY, and injected refresh FAILURE.
 *
 * `oauth.test.ts` covers the happy paths (auth-code flow, refresh+revoke, expiry auto-refresh, CSRF).
 * This adds the two remaining classes: `P` — the S256 code challenge is correct, deterministic, and
 * URL-safe for ANY verifier; and `F` — a refresh with an invalid/revoked token FAILS visibly (a typed
 * error), never silently returning a stale or empty token.
 */

function newClient() {
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

describe('OAuth PKCE code challenge (MC-07 P)', () => {
  it('is the URL-safe S256 of the verifier — deterministic and never the verifier itself', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 43, maxLength: 128 }), (verifier) => {
        const challenge = computeCodeChallenge(verifier);
        // S256, base64url-encoded — exactly what an RFC 7636 server recomputes.
        expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
        expect(computeCodeChallenge(verifier)).toBe(challenge); // deterministic
        expect(challenge).not.toMatch(/[+/=]/); // URL-safe: no standard-base64 chars or padding
        expect(challenge).not.toBe(verifier); // the verifier is never sent in the clear
      }),
      { numRuns: 1000 },
    );
  });
});

describe('OAuth failure handling (MC-07 F)', () => {
  it('a refresh with an invalid/revoked refresh token fails VISIBLY, never silently', async () => {
    const { client } = newClient();
    const meta = await client.discover();
    // The refresh token is not one the issuer will honour — the client must surface a typed failure,
    // not return a stale/blank token that a caller would treat as authenticated.
    await expect(client.refresh(meta, 'not-a-real-refresh-token')).rejects.toThrow();
  });
});
