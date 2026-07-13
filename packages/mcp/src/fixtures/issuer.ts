import { createHash } from 'node:crypto';

import type {
  HttpGateway,
  HttpRequest,
  HttpResponse,
  SseConnection,
} from '../transports/http-gateway.ts';

/**
 * An in-memory OAuth 2.0 + PKCE authorization server for tests (MC-07 "a fixture issuer for
 * tests"). It implements the `HttpGateway` surface directly, so `OAuthClient` runs its real
 * discovery/exchange/refresh/revoke flow against it with no socket.
 *
 * It ENFORCES PKCE: the token endpoint recomputes S256 of the presented verifier and rejects a
 * mismatch, so a test can prove the challenge really binds the code. Token values are a
 * deterministic sequence so a golden assertion is stable.
 */
export interface FixtureIssuerOptions {
  readonly baseUrl?: string;
  /** Access-token lifetime in seconds. */
  readonly expiresInSeconds?: number;
}

interface IssuedCode {
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export class FixtureIssuer implements HttpGateway {
  readonly baseUrl: string;
  readonly #expiresIn: number;
  #seq = 0;
  readonly #codes = new Map<string, IssuedCode>();
  readonly #refreshTokens = new Set<string>();
  readonly #revoked = new Set<string>();

  constructor(opts: FixtureIssuerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://issuer.test';
    this.#expiresIn = opts.expiresInSeconds ?? 3600;
  }

  /**
   * The user-agent step: given the authorization URL the client built, record the PKCE challenge
   * and mint an authorization code, returning the `{code, state}` a real redirect would carry.
   */
  authorize(authorizationUrl: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const challenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? '';
    if (challenge === null || method !== 'S256' || redirectUri === null) {
      throw new Error('fixture issuer requires PKCE S256 and a redirect_uri');
    }
    const code = `code_${++this.#seq}`;
    this.#codes.set(code, { codeChallenge: challenge, redirectUri });
    return { code, state };
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return Promise.resolve(this.#json(200, this.#metadata()));
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      return Promise.resolve(this.#token(request.body ?? ''));
    }
    if (request.method === 'POST' && url.pathname === '/revoke') {
      return Promise.resolve(this.#revoke(request.body ?? ''));
    }
    return Promise.resolve(this.#json(404, { error: 'not_found' }));
  }

  openSse(): Promise<SseConnection> {
    // The OAuth flow never opens an SSE stream; present only for interface completeness.
    return Promise.reject(new Error('fixture issuer has no event stream'));
  }

  #metadata(): unknown {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/authorize`,
      token_endpoint: `${this.baseUrl}/token`,
      revocation_endpoint: `${this.baseUrl}/revoke`,
      code_challenge_methods_supported: ['S256'],
    };
  }

  #token(body: string): HttpResponse {
    const form = new URLSearchParams(body);
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const verifier = form.get('code_verifier') ?? '';
      const issued = this.#codes.get(code);
      if (issued === undefined) return this.#json(400, { error: 'invalid_grant' });
      // The PKCE check: recompute S256 of the verifier and compare to the stored challenge.
      const recomputed = createHash('sha256').update(verifier).digest('base64url');
      if (recomputed !== issued.codeChallenge) {
        return this.#json(400, {
          error: 'invalid_grant',
          error_description: 'PKCE verification failed',
        });
      }
      this.#codes.delete(code); // codes are single-use
      return this.#issue();
    }
    if (grant === 'refresh_token') {
      const refresh = form.get('refresh_token') ?? '';
      if (!this.#refreshTokens.has(refresh) || this.#revoked.has(refresh)) {
        return this.#json(400, { error: 'invalid_grant' });
      }
      return this.#issue();
    }
    return this.#json(400, { error: 'unsupported_grant_type' });
  }

  #issue(): HttpResponse {
    const access = `access_${++this.#seq}`;
    const refresh = `refresh_${++this.#seq}`;
    this.#refreshTokens.add(refresh);
    return this.#json(200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.#expiresIn,
      refresh_token: refresh,
      scope: 'mcp',
    });
  }

  #revoke(body: string): HttpResponse {
    const form = new URLSearchParams(body);
    const token = form.get('token');
    if (token !== null) this.#revoked.add(token);
    // RFC 7009: always 200, even for an unknown token.
    return this.#json(200, {});
  }

  #json(status: number, payload: unknown): HttpResponse {
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }
}
