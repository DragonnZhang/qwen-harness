# Configuration reference

Every key below exists in `packages/config/src/schema.ts`. Every default below is the literal value
in `packages/config/src/sources.ts`. Nothing else is configurable — the document schema is **strict**,
so an unknown key is a visible error, not a silently ignored setting.

## Read this first: what actually consumes configuration today

The configuration system — schema, layering, precedence, provenance, migrations — is fully
implemented and tested, and it **is now consumed by `run` and `resume`**, not only by `doctor`.
`loadRunAuthority` resolves every scope and hands the result to the engine, so a managed policy file
genuinely constrains a run (`apps/cli/src/policy-from-config.ts`, `wiring.ts`).

Concretely, in today's CLI:

| Key | Affects `doctor` | Affects a `run` |
|---|---|---|
| `maxProfile`, `maxIsolation`, `networkAllowed`, `deny` | yes (resolved and reported) | **yes — enforced.** The managed ceiling clamps authority and the `deny` union becomes managed rules; `--profile yolo` under a managed `maxProfile: ask` resolves to `ask`. |
| `permissionProfile`, `isolation`, `network` | yes (reported) | **yes** — the resolved value (clamped to the ceiling) is the base authority; `--profile` is just the highest-precedence (`cli`) scope over it. |
| `model`, `baseUrl`, `apiKeyEnv`, `reasoningEffort`, `transport` | yes (reported with provenance) | **yes** — the provider is built from the resolved config. |
| `telemetry.enabled`, `telemetryLevel`, `telemetryRetentionDays` | yes (resolved) | **yes** — the trace sink is configured from them. |
| `budgets.*`, `toolOutput.*` | yes (resolved) | **not yet** — the runtime uses its own built-in defaults, which currently hold the same values. |

So a managed administrator's ceiling, the deny-union, the effective profile/isolation/network, the
model, the provider endpoint, and telemetry all flow into a real run. The one remaining gap is the
`budgets`/`toolOutput` numbers, which the engine still takes from its frozen defaults (identical
values today). See the [operator guide](operations.md#managed-policy) for deploying a managed policy.

## Files and scopes

| Scope | Location | Who writes it |
|---|---|---|
| `managed` | `/etc/qwen-harness/managed.json` | the administrator. An immutable ceiling. |
| `user` | `$XDG_CONFIG_HOME/qwen-harness/config.json` (default `~/.config/qwen-harness/config.json`) | you |
| `shared-project` | `<project>/.qwen-harness/config.json` | the repository — commit it |
| `local-project` | `<project>/.qwen-harness/config.local.json` | you, per checkout — git-ignore it |
| `env` | allowlisted environment variables (below) | your shell |
| `cli` | explicit CLI/session overrides | the command line |
| `builtin` | compiled in | the product |

A relative `XDG_CONFIG_HOME` is invalid and ignored, per the spec.

A **missing** file contributes nothing: no source, no error. Only a *present but broken* file is an
error, and the error always names the file and the stage that failed:

```text
config file /home/dev/.config/qwen-harness/config.json: parse failed (Unexpected token } in JSON at position 84)
config file /etc/qwen-harness/managed.json: schema failed (…)
```

## Precedence

Two merge strategies, and keeping them distinct is the whole security story.

**Ordinary values** — last-write-wins by scope:

```text
cli > env > local-project > shared-project > user > builtin
```

`managed` deliberately does **not** appear on that ladder. It is not an ordinary contributor that can
be out-voted; it is the ceiling.

**Security values** — never last-write-wins:

- `deny` takes the **union across every scope**. A higher scope may add a deny; it can never drop one
  a lower scope contributed. There is deliberately no "allow" that removes a deny, so the union only
  grows. This is why a malicious project file cannot re-enable something the user or the
  administrator denied.
- `maxProfile`, `maxIsolation`, and `networkAllowed` resolve **tighten-only**: the strictest value
  across all scopes wins, managed included.
- `permissionProfile`, `isolation`, and `network` are resolved by ordinary precedence and then
  **clamped** to those ceilings, *last*. A lower source can make authority more restrictive; it can
  never widen it past managed, because the clamp runs after everything else.

Every effective value carries provenance — the one source that won it — which is what lets `doctor`
say not just "network is denied" but "network is denied **because** the managed policy at
`/etc/qwen-harness/managed.json` set `networkAllowed=false`".

## The document

```jsonc
{
  "version": 1,
  "model": "qwen3.7-max",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "apiKeyEnv": "DASHSCOPE_API_KEY",
  "reasoningEffort": "medium",
  "transport": "responses",
  "permissionProfile": "ask",
  "isolation": "workspace-write",
  "network": false,
  "budgets": { "toolCallsPerTurn": 500 },
  "toolOutput": { "modelPreviewBytes": 32768 },
  "telemetry": { "enabled": false },

  // ceiling + security (meaningful in the managed file; tighten-only / union everywhere)
  "maxProfile": "auto-accept-edits",
  "maxIsolation": "workspace-write",
  "networkAllowed": false,
  "deny": ["**/secrets/**"]
}
```

Every product field is optional: a scope contributes only the keys it actually sets.

### Ordinary values

| Key | Type | Default | Affects |
|---|---|---|---|
| `version` | `1` | — | The schema version. Consumed by migration before validation; not a product value. |
| `model` | string, 1–200 chars | `qwen3.7-max` | The model name sent to DashScope. |
| `baseUrl` | URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` | The provider endpoint. |
| `apiKeyEnv` | **env-var NAME**, `^[A-Z][A-Z0-9_]*$` | `DASHSCOPE_API_KEY` | Which environment variable holds the key. **Never the key itself** — see below. |
| `reasoningEffort` | `none` \| `low` \| `medium` \| `high` | `medium` | Reasoning effort requested from the model. |
| `transport` | `responses` \| `chat` | `responses` | Which DashScope-compatible API shape to speak. |
| `telemetry.enabled` | boolean | `false` | Telemetry is **opt-in**. See [operator guide](operations.md#telemetry). |

### Authority values (clamped to the ceiling)

| Key | Type | Default | Affects |
|---|---|---|---|
| `permissionProfile` | `plan` \| `ask` \| `auto-accept-edits` \| `yolo` (aliases `default`, `manual`, `acceptEdits`, `bypassPermissions` are accepted and mapped) | `ask` | The permission profile. |
| `isolation` | `read-only` \| `workspace-write` \| `disabled` | `workspace-write` | Sandbox isolation mode. |
| `network` | boolean | `false` | Whether the agent may reach the network at all. Network is denied until granted. |

### Ceiling values (tighten-only across every scope)

| Key | Type | Default | Affects |
|---|---|---|---|
| `maxProfile` | profile | `yolo` | The most permissive profile anything may run under. |
| `maxIsolation` | isolation mode | `disabled` | The weakest isolation permitted. (`disabled` = the ceiling does not constrain isolation.) |
| `networkAllowed` | boolean | `true` | When `false`, network is denied everywhere — no profile, rule, or grant can reach it. `network` is ANDed with this. |

The defaults are deliberately **unrestricting**: an unmanaged installation really can reach `yolo`.
Pretending an unmanaged install has a ceiling it does not have would be the more dangerous lie.
Deploying a real managed file is what lowers these.

### Security list

| Key | Type | Default | Affects |
|---|---|---|---|
| `deny` | array of strings, each 1–1024 chars | `[]` | Deny patterns (path globs, hosts, tool names). Config stores the patterns; it never interprets them — that is the policy engine's job. **Union across all scopes.** |

### Budgets

Overrides for the runtime budgets. All are positive integers.

| Key | Default | Affects |
|---|---:|---|
| `budgets.turnsPerGoal` | 200 | Turns per user goal. |
| `budgets.modelCallsPerTurn` | 100 | Model calls in one turn. |
| `budgets.toolCallsPerTurn` | 1,000 | Tool calls in one turn. |
| `budgets.wallTimeMsPerTurn` | 28,800,000 (8 h) | Wall-clock per turn. |
| `budgets.activeChildAgents` | 4 | Concurrently active child agents. |
| `budgets.childDepth` | 2 | How deep delegation may nest. |
| `budgets.safeReadConcurrency` | 8 | Parallel safe (read) tool calls. |
| `budgets.retryAttempts` | 10 | Retries before visible output. |

### Tool output limits

| Key | Default | Affects |
|---|---:|---|
| `toolOutput.modelPreviewBytes` | 65,536 (64 KiB) | Model-facing inline tool preview, bounded head and tail. |
| `toolOutput.tuiInlineBytes` | 1,048,576 (1 MiB) | TUI inline output before pager/offload. |
| `toolOutput.backgroundWarnBytes` | 10,485,760 (10 MiB) | Background-output warning threshold. |
| `toolOutput.backgroundHardStopBytes` | 5,368,709,120 (5 GiB) | Background-output hard stop. |
| `toolOutput.mcpInlineTokens` | 25,000 | MCP model-facing inline result budget. |
| `toolOutput.mcpDurableChars` | 500,000 | MCP single-result durable limit before external offload. |

## Environment variables

Environment variables participate **only** through an explicit allowlist. A variable not on this list
is invisible to configuration, by construction — a stray or hostile env var cannot steer it.

| Variable | Sets | Notes |
|---|---|---|
| `QWEN_HARNESS_MODEL` | `model` | |
| `QWEN_HARNESS_BASE_URL` | `baseUrl` | |
| `QWEN_HARNESS_API_KEY_ENV` | `apiKeyEnv` | the variable NAME, never a key |
| `QWEN_HARNESS_REASONING_EFFORT` | `reasoningEffort` | |
| `QWEN_HARNESS_TRANSPORT` | `transport` | |
| `QWEN_HARNESS_PROFILE` | `permissionProfile` | |
| `QWEN_HARNESS_TELEMETRY` | `telemetry.enabled` | accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`; anything else is an error naming the variable |

**Security-sensitive keys are deliberately absent from this list.** No environment variable can set
`deny`, `maxProfile`, `maxIsolation`, or `networkAllowed`. An env var must never be able to relax a
safety decision.

`DASHSCOPE_API_KEY` is **not** a configuration variable — it is the credential itself, read only at
the provider boundary.

## The credential rule

`apiKeyEnv` accepts the **name** of an environment variable and nothing else. The regex rejects
lowercase and hyphens, and a second check rejects anything shaped like a secret value:

```text
apiKeyEnv must be the NAME of an environment variable (e.g. DASHSCOPE_API_KEY), never a key value
apiKeyEnv looks like a secret VALUE; store only the NAME of the env var that holds the key
```

This is enforced at the schema boundary rather than hoped for downstream, because a schema that
accepted a raw key would put a secret into every config file, every export, and every support
archive. There is no config key that takes a key value. There never will be.

## Migrations

A config file outlives the binary that wrote it, so every document carries a `version` and is
migrated forward before it is validated.

- **A newer version is a typed error, never a silent downgrade:**

  ```text
  config schema version 2 is newer than this build understands (max 1); upgrade the harness rather than editing the version down
  ```

  A newer install may have written keys this build cannot interpret; pretending to understand them
  would drop or misread settings.
- **Migrations are pure, ordered, and append-only.** A shipped migration is a contract with every
  file already on disk; a fix is a *new* migration, never an edit to an old one.
- The v0 → v1 migration is real: v0 was the unversioned pre-release shape. It renames `endpoint` →
  `baseUrl`, `keyEnv` → `apiKeyEnv`, `profile` → `permissionProfile`, `reasoning` →
  `reasoningEffort`, and **drops any legacy raw `apiKey` field** with the note
  `dropped legacy raw \`apiKey\` (a secret value); set \`apiKeyEnv\` to a variable NAME`. A raw key is
  never carried forward, and an env-var name is never invented from a value.
