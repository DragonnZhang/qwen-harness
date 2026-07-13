# @qwen-harness/network

The approved outbound connection broker (an `IO_OWNERS` entry). **Every** outbound HTTP request the
product makes — web fetch, an HTTP hook, an MCP HTTP transport — goes through here, so the network
policy is enforced in exactly one place. A component cannot open its own socket and skip the checks.

## The checks, before any request leaves

- **Scheme allowlist** — http/https only; `file:`, `gopher:`, etc. are refused.
- **SSRF guard** — loopback, RFC-1918 private ranges, link-local, and the cloud metadata endpoints
  (`169.254.169.254`, Alibaba's `100.100.100.100`, `metadata.google.internal`) are refused. This is
  the check that stops a fetch from exfiltrating cloud credentials.
- **Redirects re-checked at every hop** — redirects are followed manually, and each target is
  re-validated. An allowed origin that 302s to the metadata endpoint or a denied host is caught
  mid-chain, not after. Blindly following redirects is the classic SSRF bug; this does not.
- **Streamed download cap** — the byte limit is enforced *while* reading, so a server advertising
  (or lying about) a huge body cannot exhaust memory before we notice.
- **Content-type check**, then the body crosses the `UntrustedText` sanitizer before it is
  returned — a fetched page is hostile input, not trusted content (TL-13/TL-14).

The `fetch` implementation is injected, so tests replay fixtures without a socket. The SSRF suite
proves both direct requests and redirects to private/metadata addresses are refused.
