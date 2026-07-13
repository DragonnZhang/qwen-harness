import type { Clock } from '@qwen-harness/protocol';
import type { SecretStore } from '@qwen-harness/secret-store';
import { z } from 'zod';

import { McpError } from '../errors.ts';
import type { HttpGateway } from './http-gateway.ts';
import { HttpTransport } from './http.ts';

/**
 * The `ide-sse` connection profile (MC-02, defaults.md "MCP transport and cache defaults").
 *
 * This is NOT a proprietary protocol — it is ordinary MCP SSE wire transport plus a documented
 * handshake an IDE adapter uses to register a server over the local daemon socket. The daemon:
 *   1. authenticates the local peer (socket credentials — the caller supplies the verdict here);
 *   2. validates a canonical workspace and HTTPS/loopback URLs;
 *   3. resolves the OPAQUE credential handle through secret-store (never a raw token on the wire);
 *   4. then performs a standard MCP `initialize` over SSE.
 *
 * Each step has a typed failure so the caller can tell "your profile is malformed" from "that peer
 * is not allowed" from "these URLs are unsafe".
 */
export const IdeSseProfileSchema = z.object({
  profileVersion: z.number().int().positive(),
  serverId: z.string().min(1).max(128),
  sseUrl: z.string().url(),
  postUrl: z.string().url(),
  workspaceRoot: z.string().min(1),
  clientName: z.string().min(1).max(128),
  capabilityHints: z.array(z.string().max(64)).max(64),
  /** Opaque handle resolved via secret-store; NEVER the token itself. */
  credentialHandle: z.string().min(1).max(256),
  /** Epoch ms after which this registration is stale. */
  expiresAt: z.number().int().nonnegative(),
});
export type IdeSseProfile = z.infer<typeof IdeSseProfileSchema>;

export interface IdeSseContext {
  readonly gateway: HttpGateway;
  readonly clock: Clock;
  readonly secretStore: SecretStore;
  /** Canonical absolute workspace root the daemon is bound to. Must match the profile's. */
  readonly canonicalWorkspaceRoot: string;
  /**
   * The daemon's verdict on the local peer, from socket credentials. Injected because socket-peer
   * authentication is the daemon's job, not this module's — here it is a boolean the daemon proved.
   */
  readonly peerAuthorized: boolean;
}

/** A safe URL is HTTPS, or HTTP only to loopback (an IDE on the same machine). */
function isSafeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }
  return false;
}

export interface ValidatedIdeSse {
  readonly profile: IdeSseProfile;
  /** The resolved token from secret-store, ready to be used as a bearer credential. */
  readonly credential: string;
}

/**
 * Validate a registration and resolve its credential. Throws a typed `McpError` on any failure:
 * invalid-profile, unauthorized-peer, expired-profile, workspace-mismatch, unsafe-url, or auth.
 */
export async function validateIdeSseProfile(
  raw: unknown,
  ctx: IdeSseContext,
): Promise<ValidatedIdeSse> {
  const parsed = IdeSseProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new McpError('invalid-profile', `ide-sse profile is malformed: ${parsed.error.message}`);
  }
  const profile = parsed.data;

  if (!ctx.peerAuthorized) {
    throw new McpError('unauthorized-peer', 'the registering local peer is not authorized', {
      server: profile.serverId,
    });
  }
  if (profile.expiresAt !== 0 && ctx.clock.now() >= profile.expiresAt) {
    throw new McpError('expired-profile', 'ide-sse registration has expired', {
      server: profile.serverId,
    });
  }
  // Compare against the canonical root the daemon is bound to; a mismatch is a workspace-escape.
  if (profile.workspaceRoot.normalize('NFC') !== ctx.canonicalWorkspaceRoot.normalize('NFC')) {
    throw new McpError('workspace-mismatch', 'ide-sse workspaceRoot does not match the daemon', {
      server: profile.serverId,
    });
  }
  if (!isSafeUrl(profile.sseUrl) || !isSafeUrl(profile.postUrl)) {
    throw new McpError('unsafe-url', 'ide-sse URLs must be HTTPS or loopback HTTP', {
      server: profile.serverId,
    });
  }

  const credential = await ctx.secretStore.get(profile.credentialHandle);
  if (credential === null) {
    throw new McpError('auth', 'ide-sse credential handle did not resolve to a secret', {
      server: profile.serverId,
    });
  }

  return { profile, credential };
}

/**
 * Validate the profile, then build the standard SSE transport it describes. The transport is
 * ordinary `HttpTransport` in `ide-sse` mode: POST to `postUrl`, SSE from `sseUrl`, bearer the
 * resolved credential. From here the client does a normal MCP `initialize`.
 */
export async function connectIdeSse(raw: unknown, ctx: IdeSseContext): Promise<HttpTransport> {
  const { profile, credential } = await validateIdeSseProfile(raw, ctx);
  return new HttpTransport({
    kind: 'ide-sse',
    url: profile.postUrl,
    sseUrl: profile.sseUrl,
    gateway: ctx.gateway,
    clock: ctx.clock,
    headers: { authorization: `Bearer ${credential}` },
  });
}
