# Security threat model

## Security claim

The product offers explicit approval profiles and a real Linux isolation backend. It does not claim that user approval alone makes untrusted code safe. In `yolo`, the user deliberately grants full host and network authority; the product must make that risk unmistakable.

## Assets

- user files and repositories;
- credentials, environment, SSH agents, cloud metadata, and tokens;
- Git history and uncommitted work;
- model prompts, responses, memory, session transcripts, and private source;
- terminal integrity and clipboard;
- process, network, CPU, memory, disk, and cost budgets;
- task/team ownership, approvals, audit history, and release artifacts.

## Trust boundaries and controls

| Boundary | Threats | Required controls | Verification |
|---|---|---|---|
| Repository -> context | prompt injection, hostile instructions, secret requests | provenance, instruction precedence, no authority elevation, sensitive-path policy | malicious-repo suite |
| Model -> tool | destructive or confused action, hallucinated approval | schema/semantic validation, hard policy, exact approval, sandbox, audit | all-mode action matrix |
| Tool -> host | path escape, process breakout, network exfiltration | canonicalization, real Linux isolation, environment minimization, process groups, resource caps | path/process/network attacks |
| External text -> TUI/model | model/repository/tool/hook/MCP/web ANSI spoofing, unsafe links, clipboard injection, prompt injection, huge output | typed UntrustedText sanitizer, safe schemes, trust styling, bounded previews, offload, provenance | terminal injection/load tests from every origin |
| Hook -> runtime | changed input, policy bypass, infinite loop, secret leak | typed outcomes, revalidation, no elevation, timeout, re-entry guard, redaction | hook adversarial suite |
| MCP -> runtime | malicious schema/description/result, OAuth theft, arbitrary process | server trust, namespacing, shared policy, PKCE/state, token store, process isolation | malicious MCP/issuer fixtures |
| Parent -> child/team | excessive delegated authority, recursive explosion | authority intersection, depth/count/budget, correlated approvals, audit | delegation property tests |
| Background/Cron -> user | invisible or stale side effects | owner/thread identity, permission snapshot, expiry, notification, cancel, supervisor status | restart/scheduler tests |
| Storage/logs -> reader | credential/source leakage, tampering, replay | redaction, file permissions, versioned events, integrity, retention, stable exports | secret canaries and migration tests |
| Provider/network | request leakage, retry duplication, cost denial | TLS, configurable endpoint, error classes, budgets, idempotent boundaries | live/failure tests |
| Dependency/update -> product | supply-chain compromise | lockfile, provenance, audit/SBOM, minimal dependencies, reproducible build | clean-host/release gate |

## Permission profiles

### plan

- Only read, search, inspect, and reason operations are available.
- Workspace and process view are read-only and network restricted.
- No hook, skill, MCP server, child, shell interpreter, or Git command may mutate on behalf of the agent.

### ask

- Side effects require an exact normalized prompt.
- Grants can apply once, for the current session, or to a narrow validated rule.
- External path, network, privilege, destructive Git, package scripts, and MCP side effects are never implied by an edit grant.

### auto-accept-edits

- Canonical workspace file edits and structured patches auto-allow.
- Shell, executable files, package/Git hooks, network, external paths, privilege, MCP side effects, and destructive Git still ask.
- Generated edits still pass stale-file, sensitive-path, policy, sandbox, and audit checks.

### yolo

- Prompts and OS isolation are disabled.
- A persistent trusted UI banner explains maximum host/network access allowed by managed policy.
- Redaction, audit, usage limits, no-progress limits, cancellation, terminal sanitization, and data integrity still apply.

## Non-bypassable invariants

1. Managed hard deny dominates every allow or hook outcome.
2. Repository-controlled content cannot alter managed/user policy or obtain credentials.
3. A child receives the intersection of requested and parent authority.
4. Approval binds to canonical complete parameters and expires according to its displayed scope.
5. Every host side effect has an actor, correlation ID, policy decision, sandbox identity, and durable result state.
6. Known-complete side effects never replay automatically after crash or disconnect.
7. Provider credentials never become prompt/context/tool data unless a user explicitly supplies a different non-secret value.
8. Untrusted output never controls trusted TUI chrome.

## Secret handling

- Read `DASHSCOPE_API_KEY` only at the provider boundary.
- Store the environment-variable name in config, never the value.
- Avoid dumping complete environment or process command lines.
- Only the provider boundary may read `DASHSCOPE_API_KEY`; lint/architecture tests reject other `process.env` access to it, and child environments use an allowlist that excludes it by default.
- Redact exact values and common encoded/header forms before persistence or rendering.
- Use canary credentials in tests and scan Git history, build output, logs, SQLite, JSONL, snapshots, fixtures, and support bundles.
- Error messages expose provider code and request ID but not authorization material or full sensitive response bodies.
- Any credential disclosed in chat or logs is considered rotation-required.

## Sandbox acceptance

A sandbox backend must demonstrate filesystem, network, process, environment, device/IPC, and resource constraints on the target Linux server. Merely classifying command strings is insufficient. When a required backend is unavailable, `doctor` reports the exact missing kernel/package capability and safe profiles fail closed or visibly degrade; release cannot pass in degraded mode.

Model-initiated file, shell, and Git work must execute in a separate worker created by the sandbox backend. Sandboxing only child shell commands while running Node file tools in the unrestricted runtime process does not satisfy this claim.

## OAuth credentials

Use Secret Service/libsecret when available. A headless fallback is an encrypted mode-0600 file whose master key comes from a separate approved secret provider. If neither is available, keep tokens in memory and refuse persistent OAuth login. SQLite plaintext, a colocated master key, logs, exports, and child environments are forbidden token stores.

## Residual risk

No local coding agent can make arbitrary untrusted native execution risk-free, especially in `yolo` or with kernel vulnerabilities. Documentation must state the supported threat model, patch expectations, and high-value host isolation recommendations. It must not market policy prompts as a security boundary.
