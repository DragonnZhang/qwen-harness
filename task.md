# Goal: implement qwen-harness completely

## Goal contract

Starting from this specification-only repository, autonomously design, implement, test, repair, secure, package, and document a standalone coding-agent harness with a reusable runtime and terminal UI.

Continue until every required capability in `docs/product/capability-matrix.md` is implemented and verified, all deterministic gates pass, the real DashScope `qwen3.7-max` end-to-end gate passes, and the definition of done below is satisfied.

This is one persistent goal, not one generation or one patch. Internally use the checkpoints in `docs/execution/implementation-protocol.md`, persist progress in the repository, recover from failures, and keep working without requesting ordinary implementation choices from the user.

The coding agent and model executing this file are irrelevant to the product. You may be Codex, Qwen Code backed by GLM, or another agent. `/goal implement @task.md` is the expected outer-runner entry; an executor without that syntax must load this file as its persistent goal and use the committed active plan/checkpoint evidence for recovery. Do not introduce yourself, your SDK, your app server, your session format, or your provider as a product dependency. The result is an independent harness whose only required live model backend is DashScope `qwen3.7-max`.

## Read before acting

Read these files completely in order:

1. `AGENTS.md`
2. `docs/product/capability-matrix.md`
3. `docs/product/defaults.md`
4. `docs/architecture/design.md`
5. `docs/execution/implementation-protocol.md`
6. `docs/quality/acceptance.md`
7. `docs/security/threat-model.md`
8. `docs/references/sources.md`
9. every existing ADR under `docs/decisions/`

Then inspect the complete repository and Git state. Do not begin by generating broad scaffolding before you understand the acceptance matrix and checkpoint-0 probes.

The matrix exhaustively freezes the required external behavior as of 2026-07-12. External links explain that snapshot and generate no additional requirements. You may clarify implementation detail through an ADR, but may not delete, weaken, silently reinterpret, or mark out of scope a required behavior. If an external page later changes, the committed matrix still controls acceptance.

## Authority and autonomy

You are authorized to:

- create and edit files inside this repository;
- add well-maintained dependencies and pin them in the lockfile;
- run project commands, tests, local fixtures, local network servers, Git worktrees, and safe performance/failure experiments;
- install project-local tooling and, when the host allows it, required system packages through the normal package manager;
- create local branches and checkpoint commits;
- make normal naming, API, data-structure, library, and implementation decisions consistent with the approved design;
- consult the public documentation listed in `docs/references/sources.md`.

Do not pause for ordinary choices already covered by the design. Make a prudent choice, verify it, and record a material decision as an ADR.

Do not perform irreversible external actions, publish packages, modify unrelated repositories, alter global credentials, delete unrelated user data, force-push, or weaken host security. Do not print, persist, transmit to tools, or commit secret values.

If a genuine external blocker remains after safe diagnostics and alternatives, leave all deterministic work complete, record it in `docs/execution/blocked.md` with exact commands and remediation, and report the goal incomplete. Missing live credentials do not justify skipping implementation, but they do prevent final completion of the live gate.

## Research constraint

You may read public product and API documentation. You must not clone, browse, search, install, decompile, inspect source maps, or otherwise inspect source code for Claude Code, Codex, or another competing coding harness. You must not use a competitor binary to discover undocumented internals.

Generic open-source libraries selected as dependencies may be evaluated through their official documentation and source as normal. Never copy competitor implementation code or create a thin wrapper around an existing coding agent.

## Immutable product scope

Implement all rows in `docs/product/capability-matrix.md`, including:

- the full ShareAI s01-s20 progression and production behaviors frozen into the matrix on 2026-07-12;
- the public user-visible behavior frozen into the same matrix on that date to clarify permissions, hooks, tasks, sessions, agents, worktrees, MCP, and terminal interaction;
- the runtime, safety, persistence, recovery, observability, packaging, and TUI work needed for real use;
- deterministic and live acceptance evidence.

Feature presence is not completion. Evidence applicability is frozen by the matrix evidence codes and acceptance document before implementation. The implementing agent may not invent a new N/A during completion; a genuinely impossible evidence class needs an ADR that proves the original behavior remains fully satisfied. Every capability needs a real runtime path, the specified CLI/TUI surface, typed failure behavior, recovery behavior, security treatment, documentation, and executable evidence.

## Product and platform constraints

- Product code: TypeScript on Node.js, managed by pnpm.
- Target: the actual Linux cloud host on which this goal runs. Fail before implementation on a non-Linux host. Checkpoint 0 records the distribution, kernel, architecture, shell, terminal, resource, namespace, sandbox, and container capabilities. Claim no untested OS compatibility.
- Runtime: a per-user supervisor daemon owns thread state, background work, and the single-writer lease; TUI and CLI connect through a versioned Unix-domain-socket protocol and can detach/reconnect. A separate explicit service backend owns unattended scheduling. The runtime library remains headless and reusable.
- TUI: Ink/React behind an internal adapter, contingent on the required host spike. Do not switch the product runtime to Bun, Rust, Python, or an experimental FFI stack merely to simplify UI work.
- State: versioned append-only typed events in SQLite WAL with transactional projections, migrations, backups, and JSONL export/replay.
- Model: one production provider adapter named `provider-dashscope`; keep normalized core interfaces provider-neutral without speculative provider implementations.
- Secrets: `DASHSCOPE_API_KEY` or an approved secret store only. Configuration stores the environment-variable name, never its value.
- Safety: separate policy/approval from real Linux isolation. A deny-string list is not a sandbox.
- Telemetry: local and opt-in. Do not require an external analytics service.

Use strict TypeScript and runtime schemas at every untrusted boundary. Avoid broad `any`, unsafe global type assertions, shared mutable singletons, implicit I/O, and unbounded queues/retries.

## Required repository architecture

Create this shape, refining only with an ADR that preserves the boundary:

```text
apps/
  daemon/
  remote-worker/
  cli/
  tui/

packages/
  protocol/
  config/
  storage/
  provider-core/
  provider-dashscope/
  tools-core/
  tools-builtin/
  tool-worker/
  network/
  secret-store/
  policy/
  sandbox-linux/
  hooks/
  instructions/
  context/
  memory/
  tasks/
  background/
  scheduler/
  agents/
  teams/
  worktrees/
  mcp/
  runtime/
  telemetry/
  tui-kit/
  testkit/

evals/
fixtures/
scripts/
docs/
```

Required dependency direction:

```text
protocol
  -> config / storage / provider-core / tools-core / policy
  -> domain capability packages
  -> runtime
  -> cli / tui
```

`A -> B` means B may depend on A; A must not depend on B.

Enforce it with package exports, TypeScript project references, a dependency graph tool, lint rules, and architecture tests.

Non-negotiable boundaries:

1. No package imports an app.
2. `protocol` performs no filesystem, process, network, database, clock, random, or environment I/O.
3. `runtime` coordinates interfaces and state machines; it never directly spawns a process, reads a file, invokes Git, or opens an external network connection. Its Unix-socket server is a protocol adapter, not a model tool path.
4. All model-initiated file, shell, and Git I/O runs in a separate sandboxed tool-worker process through capability-scoped RPC. Main-process `fs` calls cannot implement model tools.
5. Legal I/O owners are explicit: storage -> SQLite/files; provider-dashscope -> model endpoint; MCP/network broker -> approved server targets; hook executor -> approved hook target/process; sandbox worker -> tool host I/O; telemetry -> local redacted observability. No other package opens host capabilities.
6. Provider wire types and vendor SDK objects never cross `provider-dashscope`.
7. Hooks can restrict, annotate, or add context but never elevate permission; command/HTTP hooks use controlled executors rather than direct hook-package I/O.
8. MCP tools use the same validation, policy, sandbox, audit, timeout, cancellation, and output pipeline as built-ins.
9. Child agents, teammates, background jobs, and Cron receive the intersection of requested authority, their creation-time ceiling, and current managed policy.
10. TUI renders typed projections and sends typed commands. Tests and automation never scrape UI when events exist.
11. Every package has a focused public API, README, tests, and no circular dependency.

## Core domain and runtime invariants

Use durable `Thread -> Turn -> Item/Event` concepts exactly as defined in the architecture document.

- Approval pauses and resumes the same turn; it is not a new user message.
- Persist a transition before presenting it as complete.
- Persist side-effect intent and identity before execution; persist result before continuing.
- Recovery must distinguish not-started, known-complete, known-failed, and indeterminate actions.
- Never automatically replay a known-complete or indeterminate destructive action.
- Every event has schema version, monotonic sequence, thread/turn/item IDs, actor, causation/correlation IDs, permission profile, redacted payload, and timestamp.
- Event projections must rebuild deterministically. Export schemas remain stable even if internal tables evolve.
- A single abort tree reaches model, tools, process groups, background work, MCP, subagents, teams, and UI.
- Budgets cover turns, model/tool calls, input/output/reasoning tokens, elapsed time, retries, background work, child count/depth, process output, and best-effort cost.
- Detect identical repeated calls, oscillation, no progress, context thrashing, diminishing continuation returns, runaway children, and resource denial-of-service.

## DashScope provider contract

Default safe configuration:

```json
{
  "model": "qwen3.7-max",
  "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "apiKeyEnv": "DASHSCOPE_API_KEY",
  "transport": "responses",
  "reasoningEffort": "medium",
  "contextWindowSize": 1000000
}
```

Requirements:

1. Use the DashScope-compatible Responses API as the preferred transport after checkpoint-0 contract proof. Maintain a tested Chat Completions compatibility transport.
2. Freeze `background=false` and `structuredOutput=false`. A successful response cannot upgrade these because unsupported parameters may be ignored; only newer official documentation plus a contract fixture and ADR can change them.
3. Use this transport capability table:

   | Capability                   | Responses                                   | Chat Completions                        |
   | ---------------------------- | ------------------------------------------- | --------------------------------------- |
   | text streaming               | supported                                   | supported                               |
   | reasoning summary            | supported when returned                     | unsupported                             |
   | reasoning effort granularity | none/minimal/low/medium/high                | binary thinking only                    |
   | raw reasoning                | never expose or persist                     | discard; do not relabel as summary      |
   | custom function calling      | supported                                   | supported                               |
   | incremental custom arguments | do not assume; completed item is sufficient | assemble `delta.tool_calls` by index/ID |
   | complex `tool_stream`        | not applicable                              | optional vendor capability              |
   | provider background mode     | unsupported                                 | not applicable                          |
   | structured output            | unsupported                                 | unsupported                             |

4. Normalize streamed text, supported reasoning summary, tool calls, finish states, errors, request IDs, and usage into provider-core events.
5. Do not expose or persist private raw chain-of-thought. Chat `reasoning_content` is not a reasoning summary and must be discarded or represented only as a non-content status.
6. Execute a tool only after a complete function-call item/argument stream, successful JSON parse, and local schema validation. Responses must work without incremental argument events; Chat assembles fragments by call/index identity.
7. Preserve exact call IDs and pair function outputs correctly.
8. Keep local history authoritative. Remote `previous_response_id` expires after seven days, does not inherit prior instructions, cannot combine with `conversation`, and cannot continue a `store:false` response. Test failure fallback to local durable-history reconstruction.
9. Responses usage comes from final `response.completed.response.usage`: input/output/total and `output_tokens_details.reasoning_tokens`. Chat sets `stream_options.include_usage=true` and reads the final empty-choices usage chunk. Missing values remain null; reasoning tokens are output tokens and billable.
10. Classify by HTTP status plus provider code and preserve redacted request ID. `Throttling`, `RateQuota`, and `BurstRate` may retry; `AllocationQuota`/`insufficient_quota` retries only with an explicit retry hint or window evidence and otherwise requires user action. `CommodityNotPurchased`, `PrepaidBillOverdue`, `PostpaidBillOverdue`, invalid auth/request/model, and permanent quota failures do not retry. Unrecognized 429 defaults to user-action-required. Never append a retry stream onto partial visible output.
11. Retry only transient classes with the frozen bounded backoff defaults and server hints.
12. Support the supplied compatibility shape `generationConfig.extra_body.enable_thinking`. Explicit `reasoningEffort` wins. For Responses, false maps to `reasoning.effort="none"` and true defaults to medium. For Chat/Qwen, `none` maps to top-level `enable_thinking:false`, `medium` maps to true, and minimal/low/high return a typed unsupported-granularity error rather than silently degrading. Never emit Python `extra_body` unchanged from TypeScript.
13. Fail before a live request if the key is absent. Never log authorization headers, environment values, full sensitive bodies, or encoded secret variants.

Capture safe redacted contract fixtures from the real service in checkpoint 0. Keep live tests budgeted and disposable.

## Tools and host interaction

Implement typed built-ins for:

- list/glob, search/grep, paged read, write, edit, structured apply patch;
- shell execution, optional PTY, process/background lifecycle, output tail, stop;
- Git status, diff, safe inspection, and worktree operations;
- permissioned web fetch/search and lazy tool search with URL/domain/content/output controls;
- user input, approval, elicitation, todo/task, skill, memory, background, Cron, agents/teams, and MCP surfaces required by the matrix.

All tools need strict input/output schemas, semantic validation, annotations, timeout, cancellation, output limits, errors, audit, and deterministic test fakes. Tool-worker RPC carries capability handles, not unrestricted host paths or environments.

Canonicalize and recheck paths after symlink resolution. Detect binary/encoding/line-ending/size conditions. Patches must detect stale files and return per-file results. Preserve user and pre-existing dirty changes. Shell uses process groups, separates stdout/stderr, sanitizes terminal controls, limits output/resources, and cleans all descendants.

Plan concurrent calls from real resource conflicts. Preserve original call order, parallelize only safe batches, serialize mutations, and persist enough identity to prevent early-stream execution from running twice.

## Permission, sandbox, and hook contract

Implement these profiles:

- `plan`: read/search/analysis only, read-only isolation, restricted network/process behavior.
- `ask`: exact side effects prompt for once/session/narrow-rule grant inside a workspace sandbox.
- `auto-accept-edits`: workspace edits/patches auto-allow; shell, network, external path, privilege, MCP side effect, executable/package/Git hook, and destructive Git still ask.
- `yolo`: prompts and default isolation disabled, maximum host/network authority allowed by managed policy, persistent unspoofable danger UI.

Permission and isolation are separate axes with the default mapping in `docs/product/defaults.md`. Managed hard deny dominates every scope. Repository content cannot add authority. Approval binds to complete canonical parameters. Children inherit no more authority. Even in `yolo`, the managed ceiling, credential invariants, redaction, audit, budgets, cancellation, data integrity, and terminal sanitization remain active.

Implement a real Linux sandbox backend using bubblewrap/namespaces or an equivalently strong, tested host capability. A policy-only fallback is degraded, clearly reported by doctor, and cannot pass release.

Implement the hook engine and then add each of the 30 events enumerated in the capability matrix when its owning domain is implemented. Do not create no-op emitters to satisfy an early checkpoint; all 30 become jointly verified only in checkpoint 09. Support command, HTTP, prompt/model, agent, and MCP hook handlers where applicable. Revalidate modified input, time-bound handlers, sanitize output, prevent Stop re-entry, and never let hook allow override policy.

## Context, instructions, skills, and memory

- Resolve repository instructions by scope and provenance, including nested/path-scoped rules, without letting repository content change managed policy.
- Compose deterministic prompt sections from actual runtime state. Separate stable and dynamic sections and test cache invalidation.
- Discover skill metadata first and load full content only on invocation. Validate roots and referenced scripts/assets/references. Support inline/forked context, arguments, conditions, source precedence, tool limits, and token budgets.
- Measure context budget and reserve output/tool headroom.
- Reduce cheaply first: offload large results, prune safe middle content while preserving tool pairs, then structured model compaction.
- Persist full transcript boundary before compaction. Preserve goal, constraints, decisions, plan, tasks, files, errors, identity, team, permission, and unfinished obligations.
- Support proactive and overflow-triggered compaction, pre/post hooks, circuit breakers, `/compact`, `/context`, and `/clear`.
- Implement typed long-term memories, bounded index, retrieval with fallback, safe extraction, deduplication, consolidation/Dream, conflict provenance, locks, and the exact survival/budget defaults in `docs/product/defaults.md`.

## Tasks, background work, scheduling, agents, and worktrees

Implement every behavior and concurrency invariant in matrix sections E, F, J, and K.

In particular:

- keep turn-local todos separate from durable dependency tasks;
- use durable high-water IDs and atomic claim/transition locks;
- make background result notifications separate idempotent events;
- add each required background category to one lifecycle only when its owning domain exists; no early no-op category counts as implemented;
- implement standards-correct five-field Cron with session/durable/supervisor/remote-peer distinctions and the frozen limit, expiry, jitter, missed-run, authority-ceiling, offline-approval, and remote protocol semantics in `docs/product/defaults.md`;
- keep task ownership and worktree ownership separate, persist recovery data, and refuse dirty deletion without exact approval;
- implement fresh/forked/sync/async/background/resumable subagents with bounded delegation;
- implement lead, teammate loops, inbox, protocol FSMs, plan/permission/shutdown flows, atomic task claiming, heartbeat/failure recovery, and identity across compaction;
- expose all of this in headless events and usable TUI panels.

## MCP contract

Implement standards-conformant JSON-RPC client behavior, stdio/Streamable HTTP/SSE/WebSocket/in-process transports and this product's documented `ide-sse` connection profile. `ide-sse` is ordinary SSE plus a typed IDE configuration/auth handshake, not an undocumented proprietary wire protocol. Implement discovery, invocation, dynamic refresh, transport-specific reconnect, health, output limits, and process cleanup. HTTP/SSE reconnect by default; stdio restarts only when explicitly configured.

Normalize `mcp__server__tool` names and handle collisions/untrusted metadata. Implement the exact configuration precedence and trust rules in `docs/product/defaults.md`. Implement OAuth 2.0 with PKCE, metadata discovery, state/nonce, the defined Linux secure-token-store hierarchy, refresh, revocation, and fixture issuer. Implement resources, prompts, elicitation, reverse notifications/permissions, lazy tool schemas, monitor tasks, and child inheritance. Deferred schema refresh preserves a stable prompt prefix; upfront schema content changes invalidate only their cache boundary.

Never create a privileged MCP bypass. Every MCP action uses normal policy, hooks, sandbox, audit, timeout, cancellation, and output handling.

## TUI and CLI contract

Use Ink behind `tui-kit`, pinning exact versions after checkpoint-0 proof. Keep editor/view-model state independent from renderer components.

The TUI must implement matrix section N, including:

- classic immutable completed summaries plus efficient live stream, and a separate virtualized transcript inspector for interactive history;
- Markdown/code/reasoning summary/tool/diff/error/progress rendering;
- multiline Unicode editor, history/search, paste, file and slash completion, shell mode, configurable keymap and optional Vim bindings;
- exact approval dialogs and current-mode/sandbox indicators;
- the exact Ctrl-C/Esc/rewind, trusted-user `!`, steering, and background semantics in `docs/product/defaults.md`;
- todo/task/agent/team/background/Cron/worktree/MCP/hook/memory/session/status views;
- session create/resume/fork/branch/rewind/recap/rename/export/archive/delete/clear/compact/context with the frozen single-writer semantics;
- terminal-safe control sanitization, resize, suspend, SSH disconnect, signal/error restoration;
- the performance spike and measured limits in `docs/quality/acceptance.md`.

Implement a headless CLI with equivalent typed events, JSON/JSONL, stdin/one-shot/interactive modes, no-color/quiet, stable exit codes, resume, and an approval channel. CI and integrations must not depend on terminal rendering.

## Observability and configuration

- Structured local logs, metrics, events, trace, and support bundle are redacted and attributable.
- Doctor explains environment, provider, key presence without value, config provenance, sandbox, terminal, storage, migrations, Git, MCP, and degradation.
- Config has schemas, migrations, the managed ceiling and exact ordinary/MCP precedence in `docs/product/defaults.md`, source provenance, and safe defaults.
- Track timing, retry, compaction, cancellation, tool, approval, hook, child, usage, and acceptance evidence.
- Telemetry is disabled unless explicitly opted in.

## Required execution order

Follow the checkpoints in `docs/execution/implementation-protocol.md` in order:

0. host, provider, sandbox, and Ink probes;
1. workspace, protocol, storage, testkit;
2. deny-by-default policy, real sandbox worker, provider, loop, and foundational tools;
3. full permission profiles, approvals, and hook engine/core-domain events;
4. sessions, recovery, CLI, TUI vertical slice;
5. instructions, skills, context, memory, recovery;
6. todo, tasks, background, Cron, worktrees;
7. subagents, teams, protocols, autonomy;
8. MCP and extension;
9. product/release hardening;
10. final deterministic and live acceptance.

Do not implement ten disconnected skeletons. Finish a working vertical slice and its gates at each checkpoint. Create and maintain `docs/execution/active-plan.md`, checkpoint evidence, matrix status, and ADRs. Commit only after the checkpoint gate passes.

At context pressure, persist exact progress, failures, commands, and next action before compaction. On restart, inspect Git and control files rather than repeating work.

## Required command contract

Create and keep these root commands working:

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
pnpm test:performance
pnpm test:migrations
pnpm architecture
pnpm build
pnpm check
```

`pnpm check` is the complete deterministic release gate. `pnpm test:live` is separate, credentialed, and mandatory for final completion.

## Anti-shortcut rules

Do not:

- use TODOs, placeholders, empty adapters, fake UI controls, unconditional success, or `not implemented` for required behavior;
- claim a feature from types/routes alone or mock-only tests;
- delete, skip, quarantine, weaken, or snapshot-overwrite a valid failing test;
- catch and ignore errors, add arbitrary sleeps, use unbounded retries, or hide unsupported behavior;
- make broad unsafe casts or disable type/lint/security rules to move faster;
- bypass production validation/policy/storage in tests;
- claim sandboxing from string matching alone;
- expose raw provider reasoning/private chain-of-thought;
- commit generated secrets, credentials, local state, huge logs, or provider payloads containing sensitive data;
- stop because the scope is large while safe meaningful progress remains.

Search for incomplete patterns before each checkpoint and manually inspect results. A term in a test or specification may be legitimate, but implementation shortcuts are not.

## Definition of done

Do not mark this goal complete until all of the following are true:

1. Every required row in `docs/product/capability-matrix.md` is `VERIFIED` with reproducible current evidence.
2. All ten cross-capability golden paths pass.
3. `pnpm check` passes from a clean clone on the recorded Linux target.
4. `pnpm test:live` passes against `qwen3.7-max` with streamed text, reasoning summary, multiple tools, edit/test/diff, usage, interruption/recovery, and secret scan.
5. The CLI package installs, starts, completes a deterministic task, resumes/exports, and uninstalls as documented.
6. The TUI passes PTY/SSH, Unicode, resize, long-transcript, diff, approval, interrupt, session, and terminal-restoration gates.
7. Real sandbox modes and the full adversarial suite pass; `yolo` risk is explicit.
8. Crash/failure injection proves no known-complete side effect is repeated.
9. Architecture and schema/migration checks pass.
10. Documentation covers installation, quickstart, concepts, configuration, permissions, sandbox, tools, hooks, skills, memory, agents/teams, tasks, background/Cron, worktrees, MCP/OAuth, sessions, TUI/CLI, recovery, security, troubleshooting, and development.
11. No undisclosed critical limitation, required blocker, secret, unrelated change, or implementation shortcut remains.
12. The final clean tree contains checkpoint commits and a concise final evidence report.

## Final response

Lead with the usable result. Report the target environment, artifact and entry commands, capability/evidence summary, exact checks and results, live Qwen result, sandbox/security and recovery proof, clean-install result, checkpoint/final commit IDs, and known non-critical limitations.

If any required condition is not satisfied, explicitly say the goal is incomplete, identify the exact matrix rows and evidence still missing, leave a reproducible active plan, and continue working whenever the goal mechanism permits. Never call partial completion success.
