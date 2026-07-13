/**
 * @qwen-harness/network
 *
 * The approved outbound connection broker (an IO_OWNERS entry). EVERY outbound HTTP request — web
 * fetch, an HTTP hook, an MCP HTTP transport — goes through here, so the network policy is enforced
 * in exactly one place. A component cannot open its own socket and skip the checks.
 *
 * The broker enforces a scheme allowlist, a host policy with an SSRF guard (loopback/link-local/
 * metadata refused), redirects re-checked at EVERY hop, a streamed download cap, and a content-type
 * check — and every response body crosses the UntrustedText sanitizer before it is returned, because
 * a fetched page is hostile input, not trusted content.
 */

export { NetworkBroker, NetworkError, DEFAULT_NETWORK_POLICY } from './broker.ts';
export type { NetworkPolicy, FetchImpl, FetchResponse, FetchResult } from './broker.ts';
