# @qwen-harness/mcp

The MCP (Model Context Protocol) client: connect to external tool servers over standards-conformant
JSON-RPC 2.0, discover their tools/resources/prompts, and run every invocation through the **same**
policy / hook / sandbox / audit / timeout pipeline a built-in tool uses. Capability rows **L**
(MC-01 … MC-10).

## Transports (MC-02)

A `Transport` moves opaque JSON-RPC frames; a `JsonRpcPeer` sits on top of any transport and does id
correlation once, so the wire logic is written and tested a single time.

| Transport | Owner | Framing |
|---|---|---|
| `InProcessTransport` | this package | in-memory hand-off (tests + built-in servers) |
| `StdioTransport` | this package (`node:child_process`) | newline-delimited JSON-RPC over stdin/stdout |
| `HttpTransport` | injected `HttpGateway` | Streamable HTTP POST + SSE stream |
| `ide-sse` | `HttpTransport` + a handshake | ordinary SSE plus a validated IDE profile |

**Why HTTP is injected.** `mcp` owns `node:child_process` and `node:net`, but the architecture gate
forbids it from opening an HTTP socket — "outbound HTTP still goes through network". So the HTTP/SSE
transport and OAuth talk to an injected `HttpGateway`. The production `brokeredGateway` routes
discovery GETs through the real `NetworkBroker` (SSRF-guarded, sanitized) and POST/SSE through a raw
primitive from the composition root, after applying the **same** `NetworkPolicy` guard the broker
uses (`assertUrlAllowed`) — a POST reaches nowhere a GET could not.

**Reconnect (MC-06).** HTTP/SSE reconnects on a stream drop with bounded exponential backoff and
full jitter (500 ms base, 30 s cap), resuming from the last event id. **Stdio does not auto-restart**
unless the server config opts in.

**`ide-sse`** is *not* a proprietary protocol. It is SSE wire transport plus a documented handshake
(`profileVersion, serverId, sseUrl, postUrl, workspaceRoot, clientName, capabilityHints,
credentialHandle, expiresAt`). Validation yields typed failures — `invalid-profile`,
`unauthorized-peer`, `expired-profile`, `workspace-mismatch`, `unsafe-url` — then the client does a
standard MCP `initialize` over SSE. The opaque `credentialHandle` is resolved through secret-store,
never a raw token on the wire.

## The no-bypass guarantee (MC-04)

An MCP tool is adapted into a tools-core `ToolDefinition` and invoked through `invokeMcpTool`, whose
order **is** the security property:

```
schema validation → semantic validation → policy decision → (hooks/sandbox, runtime-owned) → tools/call
```

There is no code path that reaches a server's `tools/call` before the policy engine returns `allow`.
A managed deny, a deny rule, or `plan`'s seal stops an MCP tool exactly as it stops a shell command.
The server's own annotations are read as **hints** but never trusted to relax anything: the harness
re-derives its own `readOnly`/`destructive`/`openWorld` classification (a tool with no read-only
hint is treated as a side effect, open-world by default). A mutating MCP tool is absent from `plan`.

Server-authored text (descriptions, elicitation prompts, resource names) is **untrusted**: it crosses
the `sanitize` boundary (`origin: 'mcp'`) before any display, so an ANSI/OSC payload cannot forge TUI
chrome. A hostile input schema degrades to "accept any object" instead of crashing discovery.

## Naming (MC-03)

Tools are namespaced `mcp__<server>__<tool>`. Invalid characters are replaced (a hostile name cannot
inject `__` boundaries), collisions get deterministic numeric suffixes, and a built-in name always
wins — an MCP tool that would shadow one is suffixed instead.

## Config precedence (MC-05)

`resolveMcpServers` resolves managed-exclusive policy first (a ceiling; a managed deny dominates),
then `connector < plugin < user < approved-project < local`. A **project** server is never silently
trusted — it stays inactive until explicitly trusted. Every resolved server carries its provenance.

## OAuth 2.0 + PKCE (MC-07)

`OAuthClient` implements Authorization Code + PKCE:

- **PKCE S256** — `code_challenge = base64url(sha256(code_verifier))`; an intercepted code is useless
  without the verifier the client never transmits.
- **`state` (CSRF) + `nonce` (replay)** — a callback whose `state` does not match the minted one is
  rejected (constant-time compare) **before** any token exchange.
- **Metadata discovery** through `.well-known/oauth-authorization-server` (a GET via the broker),
  then token exchange / refresh / revocation as guarded POSTs.
- **Tokens never touch disk in the clear and are never logged** — they go straight into the injected
  `SecretStore` (libsecret → encrypted 0600 file → memory-refuses-to-persist).

A `FixtureIssuer` (in-memory, enforces PKCE) backs the tests.

## Reverse channel + scale (MC-08 … MC-10)

`ServerRequestRouter` routes server→client requests (elicitation, roots) — attributed and
policy-gated; a server cannot enable a capability for itself, and sampling is refused by default.
`DeferredSchemaCache` preserves the stable prompt prefix across `list_changed` and invalidates only
the affected boundary. `scale.ts` provides large-output offload (>500 k chars → durable ref), tool
search / lazy schema loading, monitor tasks, per-server logs, and a doctor surface.

## Determinism

Everything is written against injected `Clock` / `IdSource`, so a `ManualClock` + `SequentialIds`
give a reproducible run (RT-08). `SystemClock` / `RandomIds` are the production implementations.
