# AGENTS.md

This file is the repository map, not the full specification. Keep it concise. Detailed truth lives under `docs/` and must be updated with the code.

## Mission

Build a standalone, production-minded coding-agent harness with a headless runtime and an Ink TUI. It must implement and verify the complete capability matrix, run against DashScope `qwen3.7-max`, and remain independent of the coding agent used to create it.

## Mandatory reading order

The outer goal loads `task.md` first. From there, read:

1. `AGENTS.md`
2. `docs/product/capability-matrix.md`
3. `docs/product/defaults.md`
4. `docs/architecture/design.md`
5. `docs/execution/implementation-protocol.md`
6. `docs/quality/acceptance.md`
7. `docs/security/threat-model.md`
8. `docs/references/sources.md`
9. all existing ADRs

Read deeper documents only when their capability becomes active. This is progressive disclosure, not permission to skip requirements.

## Hard constraints

- Product code is TypeScript on Node.js, managed by pnpm.
- The target is the actual Linux cloud host. Record `/etc/os-release`, `uname -a`, CPU architecture, shell, terminal, Node, pnpm, sandbox, and container capabilities before implementation.
- Runtime is headless. TUI and CLI are clients of a typed protocol and never own agent-loop state.
- Use `Thread -> Turn -> Item/Event` as the durable domain model.
- Persist every state transition before exposing it as completed. Recovery must not repeat successful side effects.
- Model-initiated file, shell, and Git I/O runs in a separate sandboxed tool worker through capability-scoped RPC; the main runtime cannot execute it in-process.
- Legal I/O owners are explicit: storage owns its database; provider-dashscope owns model-endpoint traffic; the MCP/network broker owns approved external connections; controlled hook executors own hook I/O; telemetry owns local redacted observability. No other package opens host capabilities.
- Model wire formats terminate inside provider adapters. Core packages consume normalized typed events only.
- `provider-dashscope` is the only required live provider; keep the provider interface extensible without implementing speculative providers.
- Secrets come from environment or an approved secret store and are redacted at every boundary.
- Public competitor documentation may be consulted. Do not clone, browse, install, decompile, or otherwise inspect Claude Code, Codex, or another competing harness source code.
- Do not wrap Codex SDK, Codex App Server, Qwen Code, Claude Code, or another existing coding agent and call it the harness.

## Architecture boundaries

Target dependency flow:

```text
protocol
  -> config / storage / provider-core / tools-core / policy
  -> domain capabilities
  -> runtime
  -> cli / tui
```

`A -> B` means B may depend on A; A must not depend on B.

- No package may import from an app.
- `protocol` contains data types and schemas, not I/O.
- `runtime` orchestrates interfaces; it does not directly read files or spawn commands.
- `tools-builtin` defines client contracts and worker handlers; handlers execute only inside the sandboxed tool-worker process, never in the runtime process.
- Hooks can restrict or add context but can never elevate policy.
- MCP tools use the same schema, permission, sandbox, audit, timeout, and cancellation pipeline as built-in tools.
- A child agent inherits no more authority, budget, tools, or network access than its parent.
- Background, Cron, and teammate work must be attributable to a thread, turn, owner, permission profile, and audit event.
- Enforce boundaries with TypeScript project references, package exports, dependency checks, lint rules, and architecture tests.

## Execution discipline

- Maintain `docs/execution/active-plan.md` while implementation is active.
- Work through the numbered checkpoints in `task.md`; do not skip ahead to breadth before the current vertical slice is green.
- Write or tighten acceptance tests before each feature implementation.
- Keep `docs/product/capability-matrix.md` synchronized with implementation and evidence.
- Record meaningful decisions under `docs/decisions/`.
- At each checkpoint run the required checks, inspect the full diff, update docs, and create a local checkpoint commit.
- Ordinary failures are work to diagnose and repair, not reasons to ask the user what to do.
- Never delete, weaken, skip, or quarantine a valid failing test to make a checkpoint pass.
- Never label a mock-only path, placeholder, TODO, empty adapter, or unexercised UI control as implemented.
- If a real external dependency is unavailable, finish deterministic coverage and mark the live gate `BLOCKED`, with exact remediation. Do not mark the goal complete.

## Target commands

Create and keep these root commands working once the workspace is bootstrapped:

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:security
pnpm test:pty
pnpm test:e2e
pnpm test:live
pnpm build
pnpm check
```

`pnpm check` is the local release gate and must compose all deterministic checks. `pnpm test:live` is the credentialed DashScope gate and must fail closed when the key is absent.

## Completion

The goal is complete only when every required capability is implemented, its evidence is current, all deterministic gates pass, the real Qwen E2E passes, the clean install path works on the target server, and the repository contains no undisclosed critical limitation.
