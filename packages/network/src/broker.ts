import { sanitize, type SafeText } from '@qwen-harness/protocol';

/**
 * The approved outbound connection broker (the graph's `network` I/O owner).
 *
 * EVERY outbound HTTP request the product makes — web fetch, an HTTP hook, an MCP HTTP transport —
 * goes through here, so the network policy is enforced in exactly one place. A component cannot
 * open its own socket and skip the checks; there is one broker and it owns the fetch.
 *
 * The checks, before any request leaves:
 *   - scheme allowlist (http/https only — never file:, gopher:, etc.);
 *   - host policy (allowlist/denylist, and the SSRF guard against loopback/link-local/metadata);
 *   - redirects are followed manually and RE-CHECKED at every hop (a 302 to 169.254.169.254 is the
 *     classic SSRF, and an allowed origin redirecting to a denied one must be caught);
 *   - a download size cap, enforced while streaming so a huge body cannot exhaust memory;
 *   - a content-type check; and the response body crosses the UntrustedText sanitizer before it is
 *     ever returned — a fetched page is hostile input, not trusted content (TL-13/TL-14).
 */

export interface NetworkPolicy {
  /** If non-empty, ONLY these hosts are allowed (exact or suffix match on `.example.com`). */
  readonly allowHosts: readonly string[];
  /** Always-denied hosts, checked even against the allowlist. */
  readonly denyHosts: readonly string[];
  /** Block requests to private/loopback/link-local/metadata addresses. Default true. */
  readonly blockPrivateAddresses: boolean;
  readonly maxRedirects: number;
  readonly maxDownloadBytes: number;
  /** Allowed content-type prefixes, e.g. ['text/', 'application/json']. */
  readonly allowedContentTypes: readonly string[];
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  allowHosts: [],
  denyHosts: [],
  blockPrivateAddresses: true,
  maxRedirects: 5,
  maxDownloadBytes: 5 * 1024 * 1024,
  allowedContentTypes: ['text/', 'application/json', 'application/xml', 'application/xhtml+xml'],
};

export class NetworkError extends Error {
  constructor(
    readonly code:
      | 'scheme-denied'
      | 'host-denied'
      | 'private-address'
      | 'too-many-redirects'
      | 'too-large'
      | 'content-type-denied'
      | 'request-failed',
    message: string,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Injected so tests can supply a fake fetch that replays fixtures without a socket.
 *
 * `method`/`headers`/`body` were added for the guarded POST-with-body egress (`send`). They are
 * optional so the many GET-only fakes that ignore `init` keep working — a GET is `method`
 * undefined. `redirect: 'manual'` stays required because BOTH `fetch` and `send` follow redirects
 * themselves so every hop is re-checked against policy (an auto-followed 302 to a metadata endpoint
 * would be the classic SSRF).
 */
export type FetchImpl = (
  url: string,
  init: {
    readonly method?: string;
    readonly redirect: 'manual';
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<FetchResponse>;
export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
  /**
   * Every response header, for the RAW egress path (`send`). Optional so a GET-only fake that only
   * needs `headers.get` need not enumerate; the raw response reports `{}` when it is absent.
   */
  headerEntries?(): readonly (readonly [string, string])[];
}

/** A method+body request for the guarded raw egress: JSON-RPC POST, OAuth token POST, SSE GET. */
export interface OutboundRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * The RAW response from `send`. UNLIKE `fetch` it is NOT sanitized and NOT content-type-gated: a
 * JSON-RPC frame must be parsed byte-exact, and an SSE stream is `text/event-stream`, which the
 * page-oriented content-type allowlist would reject. The SCHEME/HOST/SSRF/allowlist/redirect guard
 * is identical — only the body handling differs, and that difference is the whole reason `send`
 * exists next to `fetch` rather than replacing it.
 */
export interface RawEgressResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Buffer the body under the same byte cap as `fetch`, but THROW on overflow — a truncated JSON-RPC frame is unparseable, so silent truncation would be worse than a clear error. */
  text(): Promise<string>;
  /** The raw byte stream, for SSE. `null` when the transport returned no stream. */
  stream(): AsyncIterable<Uint8Array> | null;
}

export interface FetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  /** Sanitized — a fetched page is untrusted input (TL-13/TL-14). */
  readonly content: SafeText;
  readonly truncated: boolean;
  readonly redirectChain: readonly string[];
}

// A host resolving to any of these is refused when `blockPrivateAddresses` is on. This is the SSRF
// guard: it stops a fetch (or a redirect) from reaching the loopback interface, the cloud metadata
// endpoint, or the private RFC-1918 ranges.
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i;
const PRIVATE_IPV4_172 = /^172\.(1[6-9]|2\d|3[01])\./;
const METADATA_HOSTS = new Set(['169.254.169.254', '100.100.100.100', 'metadata.google.internal']);

function checkHost(host: string, policy: NetworkPolicy): void {
  const lower = host.toLowerCase();

  if (METADATA_HOSTS.has(lower)) {
    throw new NetworkError(
      'private-address',
      `refusing to reach the cloud metadata endpoint ${host}`,
    );
  }
  if (policy.blockPrivateAddresses && (PRIVATE_HOST.test(lower) || PRIVATE_IPV4_172.test(lower))) {
    throw new NetworkError(
      'private-address',
      `refusing to reach a private/loopback address: ${host}`,
    );
  }
  for (const deny of policy.denyHosts) {
    if (lower === deny || lower.endsWith(`.${deny}`)) {
      throw new NetworkError('host-denied', `host ${host} is denied by policy`);
    }
  }
  if (policy.allowHosts.length > 0) {
    const allowed = policy.allowHosts.some((h) => lower === h || lower.endsWith(`.${h}`));
    if (!allowed) throw new NetworkError('host-denied', `host ${host} is not on the allowlist`);
  }
}

function checkUrl(url: string, policy: NetworkPolicy): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetworkError('request-failed', `invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkError(
      'scheme-denied',
      `scheme ${parsed.protocol} is not allowed (http/https only)`,
    );
  }
  checkHost(parsed.hostname, policy);
  return parsed;
}

export class NetworkBroker {
  readonly #fetch: FetchImpl;
  readonly #policy: NetworkPolicy;

  constructor(fetchImpl: FetchImpl, policy: NetworkPolicy = DEFAULT_NETWORK_POLICY) {
    this.#fetch = fetchImpl;
    this.#policy = policy;
  }

  /**
   * Fetch a URL, following redirects manually so each hop is re-checked against policy — an allowed
   * origin that 302s to a denied host or a metadata endpoint is caught mid-chain, not after.
   */
  async fetch(url: string, opts: { signal?: AbortSignal } = {}): Promise<FetchResult> {
    const redirectChain: string[] = [];
    let current = url;

    for (let hop = 0; hop <= this.#policy.maxRedirects; hop++) {
      const parsed = checkUrl(current, this.#policy);
      redirectChain.push(parsed.toString());

      const response = await this.#fetch(current, {
        redirect: 'manual',
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      // A redirect: re-check the next URL against policy before following it.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) {
          throw new NetworkError(
            'request-failed',
            `redirect ${response.status} with no Location header`,
          );
        }
        current = new URL(location, parsed).toString();
        continue;
      }

      // A terminal response. Enforce content-type and size, then sanitize.
      const contentType = response.headers.get('content-type');
      if (contentType !== null && this.#policy.allowedContentTypes.length > 0) {
        const ok = this.#policy.allowedContentTypes.some((t) => contentType.startsWith(t));
        if (!ok) {
          throw new NetworkError(
            'content-type-denied',
            `content-type ${contentType} is not allowed`,
          );
        }
      }

      const { text, truncated } = await this.#readBounded(response);
      const sanitized = sanitize(text, { origin: 'web', maxLength: this.#policy.maxDownloadBytes });

      return {
        url: parsed.toString(),
        status: response.status,
        contentType,
        content: sanitized.text,
        truncated: truncated || sanitized.truncated,
        redirectChain,
      };
    }

    throw new NetworkError('too-many-redirects', `exceeded ${this.#policy.maxRedirects} redirects`);
  }

  /**
   * The guarded raw egress (POST/DELETE, or a streaming GET for SSE). It runs the SAME redirect
   * loop and the SAME `checkUrl` guard as `fetch` — scheme allowlist, host denylist, the SSRF block
   * on loopback/link-local/metadata/RFC-1918, allowlist enforcement, and a re-check at EVERY
   * redirect hop — so a POST reaches nowhere a GET could not. What it does NOT do is sanitize or
   * content-type-gate the body: a JSON-RPC frame must be byte-exact and an SSE stream is
   * `text/event-stream`. The security-critical checks are unchanged; only body handling differs.
   */
  async send(request: OutboundRequest, opts: { signal?: AbortSignal } = {}): Promise<RawEgressResponse> {
    let current = request.url;

    for (let hop = 0; hop <= this.#policy.maxRedirects; hop++) {
      const parsed = checkUrl(current, this.#policy);

      const response = await this.#fetch(current, {
        method: request.method,
        redirect: 'manual',
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      // A redirect: re-check the next URL against policy before following it — identical to `fetch`,
      // so a 302 to 169.254.169.254 on the POST path is refused mid-chain exactly as on the GET path.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) {
          throw new NetworkError(
            'request-failed',
            `redirect ${response.status} with no Location header`,
          );
        }
        current = new URL(location, parsed).toString();
        continue;
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of response.headerEntries?.() ?? []) {
        headers[name.toLowerCase()] = value;
      }
      return {
        status: response.status,
        headers,
        text: () => this.#readBoundedStrict(response),
        stream: () => response.body,
      };
    }

    throw new NetworkError('too-many-redirects', `exceeded ${this.#policy.maxRedirects} redirects`);
  }

  /** Buffer a body under the byte cap, throwing on overflow rather than truncating (see `text`). */
  async #readBoundedStrict(response: FetchResponse): Promise<string> {
    const cap = this.#policy.maxDownloadBytes;
    if (response.body === null) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > cap) {
        throw new NetworkError('too-large', `response exceeds ${cap} bytes`);
      }
      return text;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > cap) throw new NetworkError('too-large', `response exceeds ${cap} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Read the body with a hard byte cap enforced WHILE streaming, so a server advertising (or
   * lying about) a huge body cannot exhaust memory before we notice.
   */
  async #readBounded(response: FetchResponse): Promise<{ text: string; truncated: boolean }> {
    if (response.body === null) return { text: await response.text(), truncated: false };

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > this.#policy.maxDownloadBytes) {
        // Keep only up to the cap, then stop reading.
        const room = this.#policy.maxDownloadBytes - (total - chunk.byteLength);
        if (room > 0) chunks.push(chunk.subarray(0, room));
        truncated = true;
        break;
      }
      chunks.push(chunk);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }
}

/**
 * The production `FetchImpl` the composition root injects into the broker: Node's built-in `fetch`
 * (undici under the hood — a declared I/O owner for this package). It is the ONLY socket the broker
 * ever opens, which is why the guard in `checkUrl` is the whole story: nothing reaches the network
 * except through a `FetchImpl`, and the real one lives here.
 *
 * The response body is exposed BOTH as an async iterable (for the streamed byte cap and for SSE) and
 * via `text()`; header enumeration is provided so the raw egress can report response headers.
 */
export function nodeFetchImpl(): FetchImpl {
  return async (url, init) => {
    const response = await globalThis.fetch(url, {
      method: init.method ?? 'GET',
      redirect: init.redirect,
      ...(init.headers ? { headers: { ...init.headers } } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return {
      status: response.status,
      headers: { get: (name) => response.headers.get(name) },
      body: toAsyncIterable(response.body),
      text: () => response.text(),
      headerEntries: () => [...response.headers.entries()],
    };
  };
}

/** Adapt a web `ReadableStream` to an async iterable so the broker can cap/stream it uniformly. */
function toAsyncIterable(
  stream: ReadableStream<Uint8Array> | null,
): AsyncIterable<Uint8Array> | null {
  if (stream === null) return null;
  return (async function* () {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  })();
}
