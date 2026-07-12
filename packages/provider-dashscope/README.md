# @qwen-harness/provider-dashscope

The one production provider adapter: DashScope `qwen3.7-max` over the compatible-mode endpoint.
**Layer 2.**

This package owns model-endpoint traffic and is the **only reader of `DASHSCOPE_API_KEY` in the
product**. `pnpm architecture` rules 4 and 6 fail the build if any other package opens that
capability or so much as names that variable. Everything it exports is expressed in `provider-core`
types — `wire.ts` is deliberately not re-exported, so no vendor object can cross the boundary.

```ts
const provider = new DashScopeProvider(); // responses transport, env credential, medium effort
for await (const event of provider.stream(request)) {
  /* ProviderStreamEvent, never a wire object */
}
```

## Default safe configuration

| Setting             | Value                                                 |
| ------------------- | ----------------------------------------------------- |
| `model`             | `qwen3.7-max`                                         |
| `baseURL`           | `https://dashscope.aliyuncs.com/compatible-mode/v1`   |
| `apiKeyEnv`         | `DASHSCOPE_API_KEY`                                   |
| `transport`         | `responses` (Chat Completions is the compatibility transport) |
| `reasoningEffort`   | `medium`                                              |
| `contextWindowSize` | 1,000,000                                             |

## Capability table (frozen — PV-07)

|                              | Responses           | Chat Completions       |
| ---------------------------- | ------------------- | ---------------------- |
| text streaming               | yes                 | yes                    |
| reasoning summary            | yes                 | **no**                 |
| reasoning effort granularity | `graded`            | `binary`               |
| incremental tool args        | no (see below)      | yes                    |
| background                   | **false**           | **false**              |
| structured output            | **false**           | **false**              |
| tool stream                  | false               | false (not implemented) |

`background` is not merely "unsupported and ignored" — the live server answers HTTP 400 *"Currently
not support background."* (`fixtures/provider/dashscope/errors.json`). That is independent
confirmation of the frozen bit, so the key is never put on the wire at all. A successful response can
never upgrade a bit in this table: an unsupported parameter may simply be ignored, and "it did not
complain" is not evidence of support. Only newer official documentation plus a contract fixture and
an ADR may change one.

## Four decisions worth explaining

### 1. Tool arguments come from the completed item — the argument deltas are ignored on purpose

The Responses wire **does** emit `response.function_call_arguments.delta`, and we watched it do so in
the checkpoint-0 probe. The adapter reads none of them. The frozen contract (requirement 6) says the
completed item is sufficient and the adapter must not depend on incremental argument events, so
`RESPONSES_CAPABILITIES.incrementalToolArgs` is `false` and every tool call is built from
`response.output_item.done`. Declaring `true` because the deltas happen to be there today would
invite a consumer to depend on a stream the contract says may vanish.

Chat is the opposite case and has no choice: `delta.tool_calls` is genuinely fragmented, `id` and
`function.name` appear on the **first fragment only**, and every later fragment carries an empty `id`
plus a slice of the argument string. `index` is the sole stable identity, so assembly keys on it.

Either way, `tool-call-complete` is emitted **only** after the argument stream has closed *and*
`JSON.parse` has succeeded *and* the result is a JSON object (PV-05). Malformed JSON produces a typed
`provider.tool_call.malformed_arguments` error and **no** `tool-call-complete` — a partially-parsed
call is how a `delete` runs against the wrong path. `"42"` is valid JSON and invalid arguments; it is
rejected too.

### 2. Chat's `reasoning_content` is destroyed, not relabeled

`delta.reasoning_content` is raw private chain-of-thought. The Chat normalizer reads it **only to
learn that it happened** and drops the string on the floor: it is never accumulated, never returned,
never persisted, and never presented as a summary. What the consumer gets is a `reasoning-status`
event carrying a flag and (once the usage chunk arrives) a token count. That event type has no text
field, so there is no code path by which the reasoning could escape even by mistake.

`packages/provider-dashscope/test/integration/chat-contract.test.ts` replays the real captured stream
— which contains eleven chunks of `reasoning_content` and **no visible text at all**, so a leak would
be the entire output — and asserts that none of those strings appears anywhere in any emitted event.

### 3. Classification keys on HTTP status **plus** provider code, and an unrecognized 429 does not retry

DashScope returns 429 for at least three situations that need three behaviors: a burst that clears in
a second, an allocation quota that clears when a window rolls over, and an arrears state that never
clears without a human. "429 means slow down" would spend the 5-minute retry budget on an unpaid
bill. So:

- **retryable** — `Throttling`, `Throttling.RateQuota`, `Throttling.BurstRate`, 5xx, transport reset
- **hint-gated** — `AllocationQuota` / `insufficient_quota` retry **only** with explicit window
  evidence (a `Retry-After` header or a body `retry_after`). With no evidence they are
  indistinguishable from a permanent wall and degrade to *user action required*, never to a guess.
- **never** — `CommodityNotPurchased`, `PrepaidBillOverdue`, `PostpaidBillOverdue`, `invalid_api_key`
  (401), `model_not_found` (404), `InvalidParameter` (400)
- **unrecognized 429** — defaults to *user action required*, not retryable

Dotted codes resolve to their most specific rule: `Throttling.AllocationQuota` must **not** fall back
to the retryable `Throttling` prefix.

`InvalidParameter` is the one class marked `userActionRequired: false`. Nobody can pay or configure
their way out of a parameter the endpoint does not have — it is a client bug, and saying "user action
required" would send a user looking for a setting that does not exist.

Every error preserves the request ID from the body (`request_id`) **and** the `x-request-id` header,
and every provider-authored string is scrubbed of key material, stripped of terminal control
characters, and length-bounded before it becomes a `HarnessError`.

### 4. Reasoning effort: explicit always wins, and Chat refuses rather than degrades

`generationConfig.extra_body.enable_thinking` is accepted as a legacy compatibility shape and is
**never emitted**. `extra_body` is an OpenAI-Python convention for smuggling non-standard fields into
a request body; forwarding that key verbatim from TypeScript would put a literal `extra_body` object
on the wire, where it is not a parameter — it would be ignored, and thinking would quietly not be
configured at all.

| Input                              | Responses               | Chat                            |
| ---------------------------------- | ----------------------- | ------------------------------- |
| explicit `reasoningEffort`         | wins over legacy, always | wins over legacy, always        |
| `enable_thinking: false`           | `reasoning.effort=none` | `enable_thinking: false`        |
| `enable_thinking: true`            | `reasoning.effort=medium` | `enable_thinking: true`       |
| effort `none` / `medium`           | passed through          | `false` / `true`                |
| effort `minimal` / `low` / `high`  | passed through          | **typed error, before any request** |

Rounding `high` down to `enable_thinking: true` would bill the user for an effort they did not ask
for, with no way to see it. `provider.unsupported.reasoning_granularity` is thrown before the socket
opens.

## Credential

`CredentialSource` is an interface with an env-backed default (`EnvCredentialSource`); `secret-store`
will implement the same interface without this package changing. `requireApiKey` throws
`provider.credential.missing` **before the request body is built and before any socket opens** — the
contract test asserts `fetch` was called zero times. An empty or whitespace-only variable counts as
*absent*, because `export DASHSCOPE_API_KEY=` should produce "you have no key", not an opaque 401.

The key appears in exactly one place: the `Authorization` header. It is never logged, echoed into an
error, put in a URL, or written to a fixture.

## Not implemented, deliberately

`previous_response_id` (PV-08) is never sent. Local history is authoritative, the full input is
reconstructed and sent on every call, and the remote continuation has enough sharp edges (7-day
expiry, does not inherit instructions, cannot combine with `conversation`, cannot continue a
`store:false` response) that opting into it would buy nothing this design needs. The local-history
path *is* the fallback the contract asks to be tested — it is the only path.
