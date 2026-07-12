# qwen-harness approved design

Status: approved for implementation seed
Date: 2026-07-12
Target: the Linux cloud host used by the autonomous implementation

## 1. Objective

Build a standalone coding-agent harness with a reusable headless runtime and an interactive terminal UI. The product is complete when every capability frozen in `docs/product/capability-matrix.md` is usable through a real interface, has failure and recovery behavior, and passes its automated acceptance evidence.

The expected outer runner uses one entry command:

```text
/goal implement @task.md
```

An executor without `/goal` or `@file` syntax loads `task.md` as its persistent goal and resumes from repository checkpoints. The implementing agent may be Codex, Qwen Code backed by GLM, or another capable system. That choice must not affect product architecture or appear as a runtime dependency.

## 2. Confirmed decisions

| Area | Decision |
|---|---|
| Product scope | Full ShareAI s01-s20 capability parity plus the TUI, product, safety, recovery, and observability work needed for actual use |
| Implementation language | TypeScript and Node.js only for product runtime |
| Workspace | pnpm monorepo with mechanically enforced dependency boundaries |
| Target platform | The actual Linux cloud server; record its distribution and architecture at checkpoint 0 |
| Live model | DashScope `qwen3.7-max` |
| Provider architecture | Provider-neutral normalized protocol; one production adapter named `provider-dashscope` |
| TUI | Ink behind an internal adapter; SSH/PTY friendly; headless JSON CLI is equally supported |
| Durable state | Append-only typed event store in SQLite WAL, with projections and JSONL export/replay |
| Permissions | `plan`, `ask`, `auto-accept-edits`, and `yolo` profiles, separate from isolation |
| Isolation | Linux sandbox defaults for the first three profiles; `yolo` disables default isolation/prompts but remains inside managed hard ceilings |
| Research | Public product documentation is allowed; competitor source inspection is forbidden |
| Completion | No placeholders or mock-only claims; deterministic suite and real Qwen E2E must pass |

## 3. Alternatives considered

### 3.1 Single-package modular monolith

This would minimize early setup, but the combined runtime, TUI, provider, permission, team, scheduling, MCP, and storage responsibilities would quickly become mutually dependent. It was rejected because full s01-s20 scope needs independently testable boundaries and multiple clients.

### 3.2 Event-driven TypeScript monorepo - selected

A typed command/event protocol separates the headless runtime from user interfaces and adapters. Domain packages can be tested with deterministic fakes. Architectural constraints can be enforced with package exports, TypeScript references, dependency checks, and structure tests. This has the best balance of autonomous implementation reliability and long-term maintainability.

### 3.3 Plugin-first microkernel

Making every first-party capability a dynamically versioned plugin would maximize extensibility but front-load discovery, compatibility, lifecycle, and security work. It was rejected for the initial implementation. Stable interfaces remain injectable, and third-party extensions enter through explicit skills, hooks, and MCP surfaces.

## 4. System shape

```text
                         commands
       +-----------+  ---------------->  +----------------------+
       | Ink TUI   |                      |                      |
       +-----------+  <----------------  |                      |
                         typed events     |                      |
       +-----------+  ---------------->  | Runtime state machine|
       | CLI / JSON|                      |                      |
       +-----------+  <----------------  |                      |
                                          +----------+-----------+
                                                     |
          +----------------+-------------------------+------------------+
          |                |               |          |                 |
          v                v               v          v                 v
   provider-dashscope   tool registry   policy     domains          storage
      Responses/Chat     + sandbox      + hooks   agents/tasks     event log
                                                   MCP/cron/etc.
```

Runtime accepts commands and emits events. It never calls UI code. A per-user supervisor daemon owns thread writers, background workloads, and a versioned Unix-domain-socket command/event server. CLI and TUI attach, detach, and reconnect; one daemon writer lease prevents independent processes from interleaving a thread. An optional systemd user service keeps explicitly durable scheduling alive. Local jobs stop when their owning daemon or machine stops unless that service is active.

Interfaces build projections from the same event stream and send typed commands such as start turn, approve, deny, interrupt, steer, compact, resume, or fork.

## 5. Domain model

### Thread

A durable user workspace conversation. It owns configuration snapshots, instruction provenance, permissions, budgets, memory references, child agents, and a sequence of turns. Threads can be created, listed, resumed, forked, renamed, exported, archived, and deleted.

### Turn

One user request and its complete execution. A turn remains the same turn while it is streaming, executing tools, awaiting approval, compacting, retrying, or recovering. Approvals are never represented as synthetic user messages.

Turn terminal states include completed, cancelled, failed, blocked, and budget-exhausted. Non-terminal states include preparing, model-streaming, awaiting-approval, executing, waiting-background, compacting, and recovering.

### Item

An ordered, durable unit inside a turn. Required item families include:

- user and assistant messages;
- reasoning summaries, never private raw chain-of-thought;
- model requests and normalized stream boundaries;
- tool calls, partial output, results, and failures;
- file patches, diffs, and Git state;
- approvals and policy decisions;
- hooks and injected context;
- todo and task changes;
- child-agent, team, and protocol messages;
- background, Cron, worktree, and MCP lifecycle;
- compaction, recovery, usage, budget, warning, and error items.

### Event

Events describe accepted state transitions. They have a schema version, monotonic sequence, timestamp, thread/turn/item identity, causation and correlation identifiers, actor, permission context, and redacted payload. A projection can always be rebuilt from events.

## 6. Target repository structure

The implementation may refine names through an ADR, but it must preserve these boundaries:

```text
apps/
  daemon/                    per-user supervisor and Unix socket server
  remote-worker/             authenticated reference peer for remote agents/routines
  cli/                       interactive entry and headless JSON mode
  tui/                       Ink UI, no runtime ownership

packages/
  protocol/                  commands, events, items, schemas, versions
  config/                    layered configuration and provenance
  storage/                   SQLite event store, projections, migrations
  provider-core/             normalized provider contracts/capabilities
  provider-dashscope/        Responses primary and Chat compatibility transport
  tools-core/                tool contracts, registry, scheduling metadata
  tools-builtin/             file, search, patch, shell, Git, interaction
  tool-worker/               capability-scoped RPC and sandboxed handlers
  network/                   approved web/hook/MCP connection broker
  secret-store/              provider/OAuth secret handles and Linux backends
  policy/                    permission profiles, rules, decisions, audit
  sandbox-linux/             concrete process/filesystem/network isolation
  hooks/                     30-event hook registry and outcome semantics
  instructions/              repository guidance and prompt sections
  context/                   token accounting, offload, prune, compaction
  memory/                    retrieval, extraction, consolidation, Dream
  tasks/                     todos and durable dependency graph
  background/                background process/agent/workflow lifecycle
  scheduler/                 durable and session Cron jobs
  agents/                    child-agent lifecycle and budgets
  teams/                     inbox, protocols, autonomy, shutdown
  worktrees/                 Git worktree isolation and recovery
  mcp/                       transports, OAuth, discovery, reverse channel
  runtime/                   explicit agent-loop and turn state machines
  telemetry/                 local traces, metrics, redaction, export
  tui-kit/                   renderer-neutral view models and input editor
  testkit/                   fake provider, tools, clock, PTY and fixtures

evals/                       deterministic and live agent scenarios
fixtures/                    safe sample repositories and MCP servers
scripts/                     bootstrap, doctor, architecture and release checks
docs/                        product and engineering source of truth
```

No package imports an app. `protocol` performs no I/O. Core runtime sees provider, tool, policy, storage, time, ID, and notification interfaces through dependency injection.

All model-initiated file, shell, and Git I/O executes in a separate sandboxed tool-worker process through capability-scoped RPC. The main runtime cannot implement a file tool with direct Node `fs` calls. Legal I/O owners are storage for its database/files, provider-dashscope for the model endpoint, the MCP/network broker for approved servers, controlled hook executors for hook I/O, sandbox workers for tool host I/O, and telemetry for local redacted observability.

## 7. Turn data flow

One comprehensive agent turn follows this order:

1. Validate and persist the user input command.
2. Run `UserPromptSubmit` hooks and stop on blocking output.
3. Drain due Cron events, background notifications, team inbox, and filesystem watchers.
4. Resolve layered configuration, repository instructions, skill catalog, memory, session state, todo/task state, and provider capabilities.
5. Build deterministic system-prompt sections and a token-budgeted context.
6. Persist the outbound model boundary, then stream through the DashScope adapter.
7. Normalize text, supported reasoning summary, usage, and function calls, including incremental arguments only where the transport capability permits, into typed items.
8. Assemble and schema-validate complete tool arguments.
9. Evaluate hard policy, hooks, permission profile, interactive approval, and sandbox capabilities in that order.
10. Plan safe ordered batches, execute foreground or background work, and stream sanitized output.
11. Persist the complete result before acknowledging success; run post hooks and inject paired tool results.
12. Continue the loop, compact, recover, wait, or end based on explicit state-machine transitions and budgets.
13. Run stop hooks with re-entry protection and persist the terminal outcome.

Cancellation propagates to provider requests, tool calls, child processes, child agents, team workflows, MCP calls, and UI projections through one abort tree.

## 8. Provider design

The live adapter is named `provider-dashscope`, not `provider-openai`. It defaults to:

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

DashScope Responses is the preferred transport because its output-item model maps well to Thread/Turn/Item. Chat Completions remains an adapter compatibility path and contract-test oracle. The provider must maintain an explicit capability table; it must not assume that every OpenAI parameter is supported.

| Capability | Responses | Chat Completions |
|---|---|---|
| text streaming | supported | supported |
| reasoning summary | supported when returned | unsupported; raw `reasoning_content` is not a summary |
| custom function calls | supported; completed item is sufficient | supported; assemble `delta.tool_calls` |
| incremental arguments | not assumed as a stable contract | supported by indexed fragments; vendor `tool_stream` optional |
| provider background mode | unsupported | not applicable |
| structured output | unsupported | unsupported |

The adapter executes tools only after a complete call, JSON parse, and schema validation. It normalizes safe reasoning summary, stream events, tool calls, usage, request IDs, provider codes, rate-limit information, errors, and finish reasons. Responses usage is read from the final completed response; Chat enables the final usage chunk. Retryability uses HTTP status plus provider code, never status alone.

Local durable history is authoritative. `previous_response_id` has a seven-day lifetime, does not inherit instructions, cannot combine with `conversation`, and cannot continue `store:false`; every constraint has a fallback test that reconstructs from local history.

Missing credentials fail before a live request. Redaction applies to process environment, headers, URL query strings, errors, debug output, traces, tests, and support bundles.

## 9. Permission and sandbox design

Permission policy and sandbox capability are related but distinct.

| Profile | Approval behavior | Required isolation |
|---|---|---|
| `plan` | No mutation approval is offered; mutating operations are unavailable | Read-only workspace and restricted process/network access |
| `ask` | Side effects require a one-time, session, or narrowly matched rule grant | Workspace-scoped sandbox; escalation is explicit and auditable |
| `auto-accept-edits` | Workspace file edits and patches auto-allow; shell, network, MCP side effects, and external paths still ask | Workspace-scoped sandbox |
| `yolo` | No prompts inside the managed ceiling | Default sandbox disabled; maximum authority allowed by managed policy, with persistent high-risk UI warning |

Permission and isolation are separate axes with defaults in `docs/product/defaults.md`. Hard managed denials cannot be overridden by hooks, repository content, or child agents. Approval is bound to the exact normalized action. Symlinks, path traversal, alternate encodings, shell indirection, Git hooks, package scripts, MCP calls, background work, and child agents cannot bypass the policy boundary.

The Linux backend should use bubblewrap/namespaces where supported and may add a container backend. A policy-only fallback must be clearly labeled degraded and cannot satisfy the sandbox acceptance gate.

## 10. Storage and recovery

SQLite WAL stores append-only events and transactional projections. All schemas are versioned and migrations are tested from every supported version. JSONL is an export, debugging, and deterministic replay format rather than the authoritative concurrent store.

Before a side effect begins, runtime persists intent and an idempotency identity. After it completes, runtime durably records result state before continuing. Recovery distinguishes not-started, known-complete, known-failed, and indeterminate actions. Indeterminate destructive actions require inspection or approval; they are never replayed blindly.

Task IDs use a durable high-water mark. Task updates, team inbox messages, worktree state, Cron definitions, and memory consolidation use transactional locks or compare-and-swap semantics to avoid time-of-check/time-of-use races.

## 11. TUI and headless clients

Ink is isolated behind `tui-kit`. The classic view appends immutable completed summaries to terminal scrollback; only the active stream, status, panels, and editor rerender. A separate virtualized transcript inspector renders full typed history for expand/collapse, search, copy, and tool detail. A spike must prove both views, long-transcript, streaming Markdown, diff, multiline input, Unicode, resize, paste, interrupt, and terminal-restoration behavior before the full UI is built.

The TUI exposes:

- streaming answer and reasoning summary;
- tool input, sanitized output, status, duration, and cancellation;
- exact approval action and permission scope;
- unified diff review and accept/reject flows;
- todo, task graph, agents, teams, inbox, background, Cron, worktree, MCP, hook, usage, and budget views;
- multiline editing, history, file references, completion, configurable keymap, and slash commands;
- thread create/list/resume/fork/rename/export/archive/delete;
- layered Ctrl-C behavior and guaranteed terminal restoration;
- visible current mode and a persistent warning in `yolo`.

The CLI provides the same runtime through interactive non-TUI and deterministic JSON/JSONL modes. Tests and automation never scrape rendered terminal text when typed events are available.

## 12. Feature scope

The capability matrix groups the full ShareAI timeline into:

1. agent runtime and comprehensive turn;
2. tools and execution orchestration;
3. permissions and hooks;
4. todo and durable task graph;
5. subagents, teams, protocols, and autonomous agents;
6. skills and deterministic prompt assembly;
7. context compression and long-term memory;
8. error recovery and budgets;
9. background work and Cron;
10. worktree isolation;
11. MCP and external extension;
12. sessions, TUI, observability, configuration, installation, and release hardening.

Timeline teaching code is not treated as production-complete. Where a page describes production behavior omitted by its teaching example, that behavior remains in scope. Public Claude Code documentation can clarify user-visible semantics; the repository never depends on competitor source.

## 13. Error handling

Errors are typed by origin, retryability, user action, side-effect certainty, and visibility. Runtime uses bounded exponential backoff with jitter only for retryable failures and honors server retry information. Authentication, balance, invalid request, policy denial, unsupported capability, and deterministic tool failures are not retried as transient failures.

Context overflow triggers reactive compaction. Output truncation uses bounded continuation without committing incomplete assistant history as final output. No-progress loops, repeated identical tool calls, diminishing continuation returns, turn/time/token/tool/expense limits, and blocking limits produce explicit terminal reasons.

## 14. Verification strategy

Verification is layered:

- schema and state-machine unit tests;
- property tests for event ordering, path normalization, permissions, task graphs, and Cron parsing;
- provider contract fixtures for fragmented streams, reasoning, function calls, usage, errors, and disconnects;
- integration tests for storage, process groups, Git, worktrees, hooks, teams, MCP, OAuth, and recovery;
- PTY frame and interaction tests plus real SSH smoke tests;
- malicious repository, ANSI/OSC injection, symlink escape, prompt injection, secret leakage, and approval-bypass security suites;
- failure injection for network, disk, process, provider, lock, migration, and crash boundaries;
- load tests for large repositories, transcript, diff, tool output, task graph, and concurrent teams;
- deterministic fake-model golden tasks and a credentialed real `qwen3.7-max` coding task.

Every matrix entry needs evidence for its normal path and applicable failure, safety, and recovery paths.

## 15. Non-goals and boundaries

- Multi-provider production support is not required; extensibility is a boundary, not speculative adapters.
- Pixel-perfect cloning of a competitor UI is not required; equivalent usable behavior is.
- Inspecting competitor source code is forbidden.
- Wrapping an existing coding agent is forbidden.
- Claiming compatibility with untested operating systems is forbidden.
- A cloud SaaS control plane is not required unless a frozen timeline capability explicitly needs a remote execution peer; implement the smallest real peer/transport that makes that behavior usable and testable.
- Telemetry is local and opt-in. No external analytics service is required.

## 16. Definition of done

The product is done only when:

- every required matrix row is `VERIFIED` with current evidence;
- all deterministic checks and the real DashScope E2E pass on the recorded Linux target;
- runtime, TUI, and headless interfaces complete the documented golden paths;
- crash recovery does not replay successful side effects;
- the sandbox and permission profiles pass their attack suite;
- a clean clone installs, builds, runs, resumes, and uninstalls as documented;
- architecture constraints pass mechanical checks;
- no required behavior is a placeholder, TODO, empty handler, hidden degraded fallback, or mock-only implementation;
- known limitations are explicit, non-critical, and consistent with this specification.
