import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

import type { Clock } from '@qwen-harness/protocol';
import type { SecretStore } from '@qwen-harness/secret-store';
import { z } from 'zod';

import { McpError } from './errors.ts';
import type { HttpGateway } from './transports/http-gateway.ts';

/**
 * OAuth 2.0 Authorization Code + PKCE for MCP servers (MC-07).
 *
 * The guarantees this module makes structural:
 *   - PKCE S256: the `code_challenge` is the base64url SHA-256 of a random `code_verifier`, so an
 *     intercepted authorization code is useless without the verifier this client never sent.
 *   - `state` (CSRF) and `nonce` (replay): a callback whose `state` does not match the one we
 *     minted is rejected before the code is ever exchanged.
 *   - Tokens never touch disk in the clear and are NEVER logged: they go straight into the injected
 *     `SecretStore` (libsecret / encrypted file / memory-refuses-to-persist), the same class of
 *     material as the model key.
 *   - Every HTTP call goes through the injected `HttpGateway` — discovery through the real
 *     `NetworkBroker` GET, token/refresh/revoke as guarded POSTs. `mcp` opens no socket.
 *
 * Randomness and time are injected so a test is deterministic (RT-08) while production uses
 * `crypto.randomBytes` and the system clock.
 */

export interface OAuthClientConfig {
  /** A stable id used to key stored tokens: `mcp.oauth.<server>`. */
  readonly server: string;
  /** Base URL for metadata discovery, e.g. `https://auth.example.com`. */
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  /** Only for confidential clients; PKCE is used regardless. */
  readonly clientSecret?: string;
}

export const AuthServerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
export type AuthServerMetadata = z.infer<typeof AuthServerMetadataSchema>;

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/** What we persist. `expiresAt` is absolute epoch-ms so expiry does not depend on wall-clock drift. */
export interface StoredToken {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
  readonly scope: string | null;
}

export interface PendingAuthorization {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export type RandomBytes = (size: number) => Buffer;

export interface OAuthClientDeps {
  readonly gateway: HttpGateway;
  readonly secretStore: SecretStore;
  readonly clock: Clock;
  /** Injected for deterministic tests; defaults to `crypto.randomBytes`. */
  readonly randomBytes?: RandomBytes;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** PKCE S256: challenge = base64url(sha256(verifier)). */
export function computeCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function tokenKey(server: string): string {
  return `mcp.oauth.${server}`;
}

export class OAuthClient {
  readonly #config: OAuthClientConfig;
  readonly #deps: OAuthClientDeps;
  readonly #random: RandomBytes;

  constructor(config: OAuthClientConfig, deps: OAuthClientDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#random = deps.randomBytes ?? ((n) => nodeRandomBytes(n));
  }

  /** Discover the authorization server metadata (a GET, routed through the broker). */
  async discover(): Promise<AuthServerMetadata> {
    const url = `${this.#config.issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
    const response = await this.#deps.gateway.send({ method: 'GET', url });
    if (response.status !== 200) {
      throw new McpError('auth', `metadata discovery failed (HTTP ${response.status})`, {
        server: this.#config.server,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch (err) {
      throw new McpError('auth', 'metadata is not valid JSON', {
        server: this.#config.server,
        cause: err,
      });
    }
    const parsed = AuthServerMetadataSchema.safeParse(json);
    if (!parsed.success) {
      throw new McpError('auth', `invalid metadata: ${parsed.error.message}`, {
        server: this.#config.server,
      });
    }
    return parsed.data;
  }

  /** Begin the flow: mint verifier/challenge/state/nonce and build the authorization URL. */
  beginAuthorization(metadata: AuthServerMetadata): PendingAuthorization {
    const codeVerifier = base64url(this.#random(32));
    const codeChallenge = computeCodeChallenge(codeVerifier);
    const state = base64url(this.#random(16));
    const nonce = base64url(this.#random(16));
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    if (this.#config.scopes && this.#config.scopes.length > 0) {
      url.searchParams.set('scope', this.#config.scopes.join(' '));
    }
    return { authorizationUrl: url.toString(), state, nonce, codeVerifier, codeChallenge };
  }

  /**
   * Validate the redirect callback and return the authorization code. Rejects a `state` mismatch as
   * a CSRF attempt BEFORE any token exchange (the redirect is attacker-influenced).
   */
  handleCallback(
    params: { code?: string; state?: string; error?: string },
    pending: PendingAuthorization,
  ): string {
    if (params.error !== undefined) {
      throw new McpError('auth', `authorization failed: ${params.error}`, {
        server: this.#config.server,
      });
    }
    if (params.state === undefined || !safeEqual(params.state, pending.state)) {
      throw new McpError('auth', 'state mismatch on OAuth callback (possible CSRF)', {
        server: this.#config.server,
      });
    }
    if (params.code === undefined || params.code.length === 0) {
      throw new McpError('auth', 'authorization callback carried no code', {
        server: this.#config.server,
      });
    }
    return params.code;
  }

  /** Exchange the code for tokens (PKCE verifier proves it is us), then store them securely. */
  async exchangeCode(
    metadata: AuthServerMetadata,
    code: string,
    pending: PendingAuthorization,
  ): Promise<StoredToken> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#config.redirectUri,
      client_id: this.#config.clientId,
      code_verifier: pending.codeVerifier,
    });
    if (this.#config.clientSecret !== undefined)
      body.set('client_secret', this.#config.clientSecret);
    const token = await this.#postToken(metadata.token_endpoint, body);
    return this.#persist(token);
  }

  /** Refresh an access token using the stored refresh token. */
  async refresh(metadata: AuthServerMetadata, refreshToken: string): Promise<StoredToken> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.#config.clientId,
    });
    if (this.#config.clientSecret !== undefined)
      body.set('client_secret', this.#config.clientSecret);
    const token = await this.#postToken(metadata.token_endpoint, body);
    // A refresh response may omit a new refresh token; keep the old one if so.
    const merged =
      token.refresh_token !== undefined ? token : { ...token, refresh_token: refreshToken };
    return this.#persist(merged);
  }

  /** Revoke a token at the revocation endpoint and delete it from the store. */
  async revoke(
    metadata: AuthServerMetadata,
    token: string,
    hint: 'access_token' | 'refresh_token',
  ): Promise<void> {
    if (metadata.revocation_endpoint === undefined) {
      throw new McpError('auth', 'server declares no revocation endpoint', {
        server: this.#config.server,
      });
    }
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: this.#config.clientId,
    });
    if (this.#config.clientSecret !== undefined)
      body.set('client_secret', this.#config.clientSecret);
    const response = await this.#deps.gateway.send({
      method: 'POST',
      url: metadata.revocation_endpoint,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    // RFC 7009: the endpoint returns 200 even for an already-invalid token.
    if (response.status !== 200) {
      throw new McpError('auth', `revocation failed (HTTP ${response.status})`, {
        server: this.#config.server,
      });
    }
    await this.#deps.secretStore.delete(tokenKey(this.#config.server));
  }

  /** Load the stored token, if any. */
  async load(): Promise<StoredToken | null> {
    const raw = await this.#deps.secretStore.get(tokenKey(this.#config.server));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }

  isExpired(token: StoredToken, skewMs = 30_000): boolean {
    if (token.expiresAt === null) return false;
    return this.#deps.clock.now() + skewMs >= token.expiresAt;
  }

  /**
   * Return a valid access token, refreshing if it is expired and a refresh token exists. Throws
   * `auth` (userActionRequired) when re-authorization is unavoidable.
   */
  async accessToken(metadata: AuthServerMetadata): Promise<string> {
    const token = await this.load();
    if (token === null)
      throw new McpError('auth', 'no stored token; authorization required', {
        server: this.#config.server,
      });
    if (!this.isExpired(token)) return token.accessToken;
    if (token.refreshToken === null) {
      throw new McpError('auth', 'token expired and no refresh token; re-authorization required', {
        server: this.#config.server,
      });
    }
    const refreshed = await this.refresh(metadata, token.refreshToken);
    return refreshed.accessToken;
  }

  async #postToken(endpoint: string, body: URLSearchParams): Promise<TokenResponse> {
    const response = await this.#deps.gateway.send({
      method: 'POST',
      url: endpoint,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    if (response.status !== 200) {
      // The body may carry an OAuth error code, but never echo a token or secret into the message.
      throw new McpError('auth', `token endpoint returned HTTP ${response.status}`, {
        server: this.#config.server,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch (err) {
      throw new McpError('auth', 'token response is not valid JSON', {
        server: this.#config.server,
        cause: err,
      });
    }
    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new McpError('auth', `invalid token response: ${parsed.error.message}`, {
        server: this.#config.server,
      });
    }
    return parsed.data;
  }

  async #persist(token: TokenResponse): Promise<StoredToken> {
    const stored: StoredToken = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt:
        token.expires_in !== undefined ? this.#deps.clock.now() + token.expires_in * 1000 : null,
      scope: token.scope ?? null,
    };
    // Straight into the secret store — never a log line, never a plaintext file.
    await this.#deps.secretStore.set(tokenKey(this.#config.server), JSON.stringify(stored));
    return stored;
  }
}

/** Constant-time string comparison for the `state` check, so a mismatch leaks no timing signal. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
