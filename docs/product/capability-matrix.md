# Capability matrix

Status: frozen implementation scope
Snapshot date: 2026-07-12

This file exhaustively freezes the 2026-07-12 feature-parity scope. External links are explanatory and create no additional or future requirements. The initial status `REQUIRED` means the capability is specified but not yet implemented. During implementation, replace it only with `IN_PROGRESS`, `BLOCKED`, or `VERIFIED`, and add links or commands under an evidence subsection. A feature is never `VERIFIED` because a type, route, button, mock, or happy-path unit test exists.

## Evidence standard

Each capability needs the applicable evidence classes:

- **U** - focused unit/schema/state-machine tests.
- **P** - property, fuzz, boundary, or concurrency tests.
- **I** - integration test using real local dependencies and processes.
- **F** - injected failure/recovery test.
- **S** - security/adversarial test.
- **T** - PTY/TUI interaction or frame test.
- **E** - deterministic end-to-end golden task.
- **L** - credentialed live DashScope test.
- **D** - user-facing documentation and runnable example.

Every row implicitly requires documentation and type-safe errors. `Evidence` freezes the minimum additional classes. The implementation agent cannot add a new N/A during completion; an applicability change requires an ADR proving the original user-visible behavior is still fully satisfied.

## A. Agent runtime and comprehensive turn

Sources: [s01](https://learn.shareai.run/en/s01/), [s20](https://learn.shareai.run/en/s20/), and [Claude Code agent loop](https://code.claude.com/docs/en/how-claude-code-works).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| RT-01 | Durable message history drives a repeated model -> tool -> result -> model loop until an explicit terminal transition. | U,I,E,L | VERIFIED |
| RT-02 | One model output may contain multiple function calls; every call and result remains ordered, paired by identity, and recoverable. | U,P,I,F | VERIFIED |
| RT-03 | An explicit state machine represents preparing, streaming, approval, execution, background wait, compaction, recovery, steering, cancellation, completion, failure, blocking, and budget exhaustion. | U,P,I,F | VERIFIED |
| RT-04 | Turn count, model/tool/token/time/cost/retry/blocking limits and no-progress detection produce typed termination reasons. | U,P,F,E | IN_PROGRESS |
| RT-05 | The comprehensive order is input hooks -> queued notifications -> context assembly -> model -> recovery -> permission/hooks -> tool scheduling -> post hooks -> results -> stop hooks. | U,I,E | IN_PROGRESS |
| RT-06 | Cancellation propagates through one abort tree to model streams, tools, process groups, background work, MCP, subagents, teams, and UI. | I,F,T,E | REQUIRED |
| RT-07 | Runtime supports steering input during a turn without corrupting current tool/result pairing, plus interrupt and resume. | U,I,T,E | REQUIRED |
| RT-08 | Runtime is headless and deterministic under injected provider, tool, clock, ID, storage, policy, and notification interfaces. | U,I,E | VERIFIED |
| RT-09 | Thread -> Turn -> Item/Event schemas are versioned; unknown future events survive export/import without silent loss. | U,P,I | VERIFIED |

## B. DashScope provider and normalized model protocol

Sources: [DashScope model list](https://help.aliyun.com/zh/model-studio/text-generation-model), [Responses compatibility](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses), [Chat Completions compatibility](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions), and [deep thinking](https://help.aliyun.com/zh/model-studio/deep-thinking).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| PV-01 | `provider-core` exposes normalized requests, items, stream events, capabilities, usage, errors, cancellation, and retry metadata without vendor wire types. | U,I | VERIFIED |
| PV-02 | `provider-dashscope` defaults to `qwen3.7-max`, the configured compatible endpoint, `DASHSCOPE_API_KEY`, one-million-token declared context, and configurable reasoning effort. | U,I,L | IN_PROGRESS |
| PV-03 | Responses is primary and Chat is compatibility transport. Both normalize common runtime semantics while preserving the transport capability differences frozen in `task.md`. | U,I,L | VERIFIED |
| PV-04 | Responses reasoning summaries may render/persist; Chat raw `reasoning_content` is discarded or reduced to status and never relabeled as summary/private reasoning. | U,I,F,L | IN_PROGRESS |
| PV-05 | Responses works from complete function-call items without assuming argument deltas. Chat assembles `delta.tool_calls` by index/ID. Execute only after complete JSON and local schema validation. | U,P,I,F,L | VERIFIED |
| PV-06 | Function outputs preserve exact call IDs and ordering. Disconnect recovery never replays a known-complete side-effecting tool. | U,I,F,L | VERIFIED |
| PV-07 | Capability table freezes `background=false` and `structuredOutput=false`; only newer official docs plus fixture and ADR may upgrade them. Other unsupported parameters fail visibly. | U,I,D | VERIFIED |
| PV-08 | `previous_response_id` is optional, seven-day, re-sends instructions, excludes `conversation`, requires stored response, and falls back to local-history rebuild on failure. | U,I,F,L | REQUIRED |
| PV-09 | Responses maps final completed usage; Chat enables/reads the final empty-choices usage chunk. Unknowns stay null; reasoning tokens are output/billable. | U,I,L | VERIFIED |
| PV-10 | HTTP+provider code distinguishes retryable Throttling/RateQuota/BurstRate, hint-gated AllocationQuota, and permanent purchase/arrears/auth/request/model/unknown-429 errors, preserving request ID. | U,P,I,F,L | IN_PROGRESS |
| PV-11 | Retry uses frozen attempt/elapsed limits, exponential full jitter, and server hints only for retryable classes; partial visible streams never concatenate a blind retry. | U,P,F,L | VERIFIED |
| PV-13 | Legacy thinking mapping is exact: explicit effort wins; Responses false->none/true->medium; Chat supports none=false and medium=true only, rejecting other granularity; Python `extra_body` is not emitted unchanged. | U,I,L | VERIFIED |
| PV-12 | Credential discovery fails early for live commands and redacts headers, environment, URLs, messages, traces, fixtures, snapshots, and support bundles. | U,S,I,L | VERIFIED |

## C. Tools and execution orchestration

Sources: [s02](https://learn.shareai.run/en/s02/), [s13](https://learn.shareai.run/en/s13/), and [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| TL-01 | A registry binds stable name, description, input/output schema, annotations, permissions, concurrency metadata, timeout, cancellation, and handler. | U,I | VERIFIED |
| TL-02 | Built-ins cover directory listing/glob, text search, paged file read, write, edit, structured apply-patch, shell, Git status/diff, user interaction, and output retrieval. | U,I,S,E | IN_PROGRESS |
| TL-03 | File tools detect binary/encoding/size conditions, paginate large content, preserve line endings, and reject traversal, absolute-path escape, and symlink escape after canonicalization. | U,P,I,S | IN_PROGRESS |
| TL-04 | Edits and patches detect stale source, return per-file outcomes and diffs, preserve user changes, and never overwrite a concurrently changed file silently. | U,P,I,F,E | IN_PROGRESS |
| TL-05 | Shell supports cwd, environment allowlisting, stdout/stderr separation, partial streaming, timeout, cancellation, non-zero status, process-group cleanup, and optional PTY. | U,I,F,S,T | IN_PROGRESS |
| TL-06 | Git tooling is read-safe by default, reports dirty state precisely, and never discards, resets, force-pushes, or rewrites history without exact approval. | U,I,S,E | REQUIRED |
| TL-07 | Tool arguments pass schema validation -> semantic validation -> hard policy -> pre hooks -> permission -> sandbox -> execution. No alternate path bypasses this pipeline. | U,P,I,S | IN_PROGRESS |
| TL-08 | Multiple calls are partitioned in original order into safe parallel batches and serial side-effect batches based on actual arguments and resource conflicts. | U,P,I,F | IN_PROGRESS |
| TL-09 | Fully assembled safe calls may start while the model continues streaming, while persistence and ordering prevent early-execution duplication. | U,I,F,L | REQUIRED |
| TL-10 | Oversized output is sanitized, durably offloaded, and represented by a bounded preview plus a retrievable reference. | U,I,S,E | REQUIRED |
| TL-11 | ANSI, OSC, terminal title, clipboard, hyperlink, and control-sequence content from tools is untrusted and cannot forge TUI chrome or approvals. | U,P,S,T | IN_PROGRESS |
| TL-12 | Tool results use a stable success/error shape with machine-readable categories, user-safe text, model-safe text, provenance, duration, truncation, and audit identity. | U,I | VERIFIED |
| TL-13 | Permissioned WebFetch and WebSearch validate schemes/domains/redirects/content types, limit downloads, respect network policy, sanitize untrusted content, and have a real configured provider or provider-native path plus local fixtures. | U,P,I,S,E,L | IN_PROGRESS |
| TL-14 | Every model, repository, tool, hook, MCP, web, Markdown-link, and provider string crosses one `UntrustedText` sanitizer before TUI/log/export; only typed trusted-chrome values can affect terminal controls. | U,P,I,S,T | IN_PROGRESS |

## D. Permission profiles, policy, and hooks

Sources: [s03](https://learn.shareai.run/en/s03/), [s04](https://learn.shareai.run/en/s04/), [permission modes](https://code.claude.com/docs/en/permission-modes), [permissions](https://code.claude.com/docs/en/permissions), and [hooks](https://code.claude.com/docs/en/hooks).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| PS-01 | Profiles are `plan`, `ask`, `auto-accept-edits`, and `yolo`, with documented compatibility aliases where useful. Current profile is visible in every client. | U,I,T,E | IN_PROGRESS |
| PS-02 | `plan` exposes read/search/analysis only and enforces read-only isolation; unavailable mutations cannot be smuggled through shell, hooks, MCP, agents, or scripts. | U,P,I,S,E | VERIFIED |
| PS-03 | `ask` prompts for normalized side effects and supports exact once, session, or narrowly matched grants with expiry and revocation. | U,P,I,S,T | VERIFIED |
| PS-04 | `auto-accept-edits` auto-allows dedicated workspace file tools only; shell, executable/package/Git-hook edits, protected paths, network, MCP side effects, external paths, privilege, and destructive Git still ask. | U,P,I,S,T | VERIFIED |
| PS-05 | `yolo` removes prompts and default isolation, grants the maximum authority allowed by managed policy, records the choice, and shows a persistent unspoofable danger indicator. Managed deny and credential/redaction invariants remain. | U,I,S,T | VERIFIED |
| PS-06 | Decisions support allow/deny/ask/passthrough, hard deny dominates every scope, and content safety rules cannot be elevated by repository config or hooks. | U,P,I,S | VERIFIED |
| PS-07 | Managed policy is an immutable safety ceiling. Inside it, config provenance follows the exact per-source rules in `docs/product/defaults.md`; deny merges across scopes and doctor explains every winning value. | U,P,I,S,D | IN_PROGRESS |
| PS-08 | Children and session work inherit no more than their parent; durable/background/Cron work uses the intersection of its captured creation-time ceiling and current managed policy. | U,P,I,S,E | IN_PROGRESS |
| PS-09 | Permission requests from children bubble to the owning interactive thread with actor, full exact action, risk, scope options, and correlation ID. | U,I,S,T,E | REQUIRED |
| PS-10 | Repeated denials and prompt fatigue are handled without silently upgrading authority; automated classification may reduce prompts only inside hard policy. | U,P,I,S | REQUIRED |
| PS-11 | Protected paths have explicit classifications and behavior in every profile; repository rules, shell indirection, symlinks, hooks, or child agents cannot downgrade them. | U,P,I,S,T | IN_PROGRESS |
| SB-01 | Linux isolation has a real backend using bubblewrap/namespaces or an equally strong documented backend; degraded policy-only mode is explicit and fails the release gate. | U,I,S,E | VERIFIED |
| SB-02 | Sandbox controls canonical filesystem paths, process tree, environment, network, devices, IPC, resource/output limits, and cleanup. | P,I,F,S | IN_PROGRESS |
| SB-03 | Sandbox capability detection and diagnostics run at startup and through `doctor`; an unavailable required backend fails safe. | U,I,E,D | VERIFIED |
| SB-04 | Every model-initiated file, shell, and Git handler runs in a separate sandbox-created worker over capability-scoped RPC; attacks prove main-process Node I/O cannot bypass mounts/network/process limits. | U,P,I,F,S | VERIFIED |
| HK-01 | Implement these 30 hook events: PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, Stop, StopFailure, Setup, UserPromptSubmit, Notification, PermissionRequest, PermissionDenied, SubagentStart, SubagentStop, PreCompact, PostCompact, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, UserPromptExpansion, MessageDisplay, and PostToolBatch. | U,I,E | IN_PROGRESS |
| HK-02 | Hook handlers support command, HTTP, prompt/model, agent, and MCP forms where applicable, plus matcher/condition filters, timeouts, cancellation, ordering, and async notification. | U,I,F,S | IN_PROGRESS |
| HK-03 | Hook output may block, message, add context, update permitted input, request/preserve permission behavior, annotate MCP output, prevent continuation, or provide a typed stop reason. | U,P,I,S | VERIFIED |
| HK-04 | Hook allow cannot override policy deny/ask; modified input is fully revalidated; untrusted hook output is sanitized and attributed. | U,P,I,S | VERIFIED |
| HK-05 | Stop hooks have re-entry protection, failures are visible, and post-tool hooks can stop continuation without corrupting the completed tool result. | U,I,F,E | IN_PROGRESS |

## E. Todo, durable task graph, and plans

Sources: [s05](https://learn.shareai.run/en/s05/), [s12](https://learn.shareai.run/en/s12/), and [task-tool migration](https://code.claude.com/docs/en/agent-sdk/todo-tracking#migrate-to-task-tools).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| WK-01 | A turn-local todo checklist supports pending/in-progress/completed, `activeForm`, ordering, visibility in TUI, and preservation through compaction. | U,I,T,E | IN_PROGRESS |
| WK-02 | Legacy `TodoWrite` semantics remain usable while the preferred durable task API is Create/Get/Update/List; the two systems are not conflated. | U,I,E,D | IN_PROGRESS |
| WK-03 | Durable tasks store high-water ID, subject, description, active form, owner, status, blocks, blockedBy, metadata, timestamps, and audit provenance independently. | U,P,I | VERIFIED |
| WK-04 | Task state transitions, claim, release, complete, delete, and owner-loss recovery are validated by a state machine. | U,P,I,F | VERIFIED |
| WK-05 | A task cannot begin until all dependencies complete; completing upstream reports newly unblocked work. Cycles and missing references are rejected. | U,P,I,E | VERIFIED |
| WK-06 | Atomic claiming prevents two agents from owning one task; task-file and list-level locking reread inside the lock to prevent TOCTOU races. | P,I,F,E | VERIFIED |
| WK-07 | Deleted IDs are never reused; concurrent list/watch/update behavior survives crashes and compaction. | U,P,I,F | VERIFIED |
| WK-08 | TaskCreated and TaskCompleted hooks, filesystem/event watchers, assignment messages, plan approval, and TUI task graph all consume the same task events. | I,T,E | REQUIRED |
| WK-09 | Plans can be proposed, reviewed, rejected with feedback, revised, approved, and converted to task graphs without granting implementation authority prematurely. | U,I,T,E | REQUIRED |

## F. Subagents, teams, protocols, and autonomy

Sources: [s06](https://learn.shareai.run/en/s06/), [s15](https://learn.shareai.run/en/s15/), [s16](https://learn.shareai.run/en/s16/), [s17](https://learn.shareai.run/en/s17/), [subagents](https://code.claude.com/docs/en/sub-agents), and [agent teams](https://code.claude.com/docs/en/agent-teams).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| AG-01 | One-shot subagents have independent history, explicit prompt/context/tool/model/budget/permission identity, shared or isolated workspace policy, and return a bounded conclusion. | U,I,E,L | IN_PROGRESS |
| AG-02 | Support fresh-context, fork/cache-friendly, synchronous, foreground, asynchronous, and background subagent modes with explicit semantics. | U,I,F,E | IN_PROGRESS |
| AG-03 | Parent cancellation propagates; recursion and child count/depth/budget are bounded; children cannot create unbounded teams. | U,P,I,F,S | IN_PROGRESS |
| AG-04 | A subagent can be resumed by identity and retains its own compacted history, while ordinary completion returns only an attributed summary to the parent. | U,I,F,E | REQUIRED |
| AG-05 | Long-lived teams contain a lead, independent teammate loops, shared task list, durable team config, and concurrent inboxes. | U,P,I,F,E,L | IN_PROGRESS |
| AG-06 | Inbox writes and reads are atomic, ordered, idempotent, and wake sleeping agents; lead injects normal messages only after protocol handling. | U,P,I,F | IN_PROGRESS |
| AG-07 | Protocol messages cover normal message, idle, permission request/response, plan approval request/response, shutdown request/approved/rejected, task assignment, team permission update, mode-set, sandbox permission request/response, and termination. | U,I,E | IN_PROGRESS |
| AG-08 | Requests carry correlation IDs and typed finite-state machines; response type and sender/recipient must match an outstanding request. | U,P,I,S | VERIFIED |
| AG-09 | Plan approval keeps the teammate read-only until accepted; rejection feedback requires revision and resubmission. | U,I,T,E | REQUIRED |
| AG-10 | Graceful shutdown supports request, accept/reject with reason, cleanup, task release, process cancellation, and terminal event. | U,I,F,E | VERIFIED |
| AG-11 | Autonomous teammates cycle WORK -> IDLE -> WORK, prioritize shutdown, check inbox and task events, and atomically claim pending unowned unblocked tasks. | U,P,I,F,E | IN_PROGRESS |
| AG-12 | Teammate failure, timeout, or lost heartbeat releases/requeues owned work according to policy and reports to lead without duplicate execution. | U,P,I,F,E | IN_PROGRESS |
| AG-13 | Team definition/inbox/task graph/logical identity are durable, but lost OS processes are never shown running. Resume follows the incarnation, expired-request, task-lease, inbox, and explicit respawn semantics in `docs/product/defaults.md`. | U,P,I,F,E | VERIFIED |
| AG-14 | TUI supports team creation, member status, direct messaging, task ownership, plan approval, permission bubbling, peek/reply, attach/detach, and shutdown. | T,E | REQUIRED |

## G. Skills, instructions, and system prompt

Sources: [s07](https://learn.shareai.run/en/s07/), [s10](https://learn.shareai.run/en/s10/), [skills](https://code.claude.com/docs/en/skills), and [system-prompt modification](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| IN-01 | Skills use two-level loading: discover validated metadata/catalog first and load full `SKILL.md` only when invoked or selected. | U,I,E | REQUIRED |
| IN-02 | Skill resolution uses a registry and canonical scope, never arbitrary model-provided paths; referenced scripts/assets/references remain inside the validated skill root. | U,P,I,S | VERIFIED |
| IN-03 | Sources and precedence cover managed, user, project, additional directory, legacy commands, bundled, plugin, MCP, dynamic, and conditional skills. | U,P,I,D | REQUIRED |
| IN-04 | Frontmatter supports name, description, usage condition, allowed tools, context mode, model hint, hooks, paths, user invocation, and argument substitution with strict validation. | U,I,S,E | REQUIRED |
| IN-05 | Inline and forked skills have explicit context, tool, budget, permission, and result semantics; catalog and loaded-content token budgets are enforced. | U,P,I,E | REQUIRED |
| IN-06 | Repository instructions resolve global/ancestor/root/nested/path-scoped guidance with provenance and deterministic precedence; loading emits InstructionsLoaded. | U,P,I,E | IN_PROGRESS |
| IN-07 | System prompt is composed from independently tested sections enabled by real runtime state, not one mutable string. | U,I | VERIFIED |
| IN-08 | Stable identity/tool/workspace sections and dynamic memory/session/MCP/context sections have deterministic cache keys and explicit invalidation. | U,P,I,F | IN_PROGRESS |
| IN-09 | Support minimal, default, proactive, coordinator, and agent-defined prompt modes with the activation, prompt delta, tool availability, policy inheritance, cache behavior, and observable tasks frozen in `docs/product/defaults.md`. | U,I,E,D | REQUIRED |
| IN-10 | Instruction text is sent on every provider request when the transport does not inherit it; cache optimization cannot change behavior. | U,I,F,L | IN_PROGRESS |

## H. Context compression and long-term memory

Sources: [s08](https://learn.shareai.run/en/s08/), [s09](https://learn.shareai.run/en/s09/), [context window](https://code.claude.com/docs/en/context-window), and [memory](https://code.claude.com/docs/en/memory).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| CX-01 | Context budgets use provider capability and measured serialized size/token estimates, reserve response/tool headroom, and expose current utilization. | U,P,I,T | IN_PROGRESS |
| CX-02 | Cheap reduction runs first: offload large results, prune only safe middle content, and replace old tool results while retaining call/result pairing and durable references. | U,P,I,F | VERIFIED |
| CX-03 | Threshold compaction writes the full transcript boundary, creates a structured summary, and preserves user goal, constraints, plan, todos/tasks, active files, decisions, errors, and unfinished obligations. | U,I,F,E,L | VERIFIED |
| CX-04 | Proactive compaction and reactive overflow compaction are distinct, bounded, observable paths with pre/post hooks and retry circuit breakers. | U,P,I,F,L | VERIFIED |
| CX-05 | Compaction restores goal/state plus root/unscoped instructions and auto memory; nested/path rules return only after matching access. Reattach recent skills at 5K each/25K total and preserve file/worktree/agent/team/tool/permission state without inventing completion. | U,I,F,E | REQUIRED |
| CX-06 | `/compact [focus]`, `/context`, and `/clear` have explicit effects; context thrashing and diminishing returns stop safely. | U,I,T,E | IN_PROGRESS |
| MM-01 | Long-term memory is Markdown with validated YAML metadata. Startup loads the first 200 lines or 25 KiB of `MEMORY.md`; topic files load on demand, and `/memory` exposes audited provenance/editing. Types include user, feedback, project, and reference. | U,I,S,T,D | IN_PROGRESS |
| MM-02 | Retrieval uses name/description side-selection with deterministic keyword fallback, provenance, per-file/session budgets, and failure isolation. | U,P,I,F,E | IN_PROGRESS |
| MM-03 | After a naturally completed non-cancelled turn, deterministic eligibility may run extraction; a valid empty result is a no-op. Stored memories are deduplicated and never contain secrets, raw private reasoning, transient noise, or unsupported claims. | U,P,I,S,L | IN_PROGRESS |
| MM-04 | Consolidation/Dream deduplicates, resolves conflicts with provenance, retires stale content, rebuilds index, and uses the exact eligibility, lock lease, frequency, wall-time, and token gates in defaults. | U,P,I,F,E | IN_PROGRESS |
| MM-05 | Distinguish cross-session project/user memory, machine-local auto memory shared by worktrees of one canonical repo, team-shared memory, and session memory that survives compaction only. | U,I,E,D | IN_PROGRESS |
| MM-06 | Concurrent memory writers use locks/transactions; lock timeout and crash recovery preserve valid previous state. | P,I,F | VERIFIED |

## I. Error recovery and budgets

Source: [s11](https://learn.shareai.run/en/s11/) and [Claude Code error reference](https://code.claude.com/docs/en/errors).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| ER-01 | Incomplete max-output responses are not committed as final history; bounded continuation persists intermediate evidence and detects diminishing returns. | U,I,F,L | REQUIRED |
| ER-02 | Context overflow triggers bounded reactive compact and retry from a durable model boundary. | U,I,F,L | REQUIRED |
| ER-03 | Transient network/rate/server errors retry before visible side effects; after visible output or tool execution, recovery avoids blind replay and asks/continues safely. | U,P,I,F,L | VERIFIED |
| ER-04 | Image/media validation, stream abort, tool abort, hook block, token-budget continuation, overload, and unsupported capabilities have distinct typed paths. | U,I,F | REQUIRED |
| ER-05 | Retry, continuation, compaction, fallback, and blocking limits are configurable, visible, and produce explicit final reasons. | U,P,I,T | REQUIRED |
| ER-06 | The runtime detects repeated identical calls, oscillation, no file/test progress, runaway child creation, and cost/time denial-of-service. | U,P,I,F,S | IN_PROGRESS |
| ER-07 | Recovery never drops partial evidence, leaks secrets, leaves orphan processes, corrupts terminal mode, or marks an indeterminate side effect complete. | I,F,S,T,E | VERIFIED |

## J. Background tasks and Cron

Sources: [s13](https://learn.shareai.run/en/s13/), [s14](https://learn.shareai.run/en/s14/), [background commands](https://code.claude.com/docs/en/interactive-mode#background-bash-commands), and [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| BG-01 | Foreground/background is an explicit model/user parameter with a conservative heuristic fallback, not an opaque duration guess. | U,I,E | VERIFIED |
| BG-02 | Background work returns a unique task ID immediately and exposes status, owner, permission context, incremental output, output reference, stop, await, and completion notification. | U,P,I,F,T | IN_PROGRESS |
| BG-03 | Support local shell, local agent, authenticated remote agent, in-process teammate, local workflow, MCP monitor, and Dream/consolidation through one lifecycle; remote behavior uses the frozen reference-peer contract. | U,I,F,S,E | IN_PROGRESS |
| BG-04 | Completion notification is a new attributed event, never reuse of the original model tool-call ID; duplicate notifications are idempotent. | U,P,I,F | VERIFIED |
| BG-05 | Output limits, four-way foreground concurrency, priority/FIFO fairness, typed input, 30-second watchdog, five-minute blocked transition, cancellation, and cleanup follow defaults. | U,P,I,F,S | IN_PROGRESS |
| BG-06 | `/tasks` and TUI panels can list, inspect, tail, foreground/background, stop, and attribute background work without blocking the main input loop. | T,E | REQUIRED |
| BG-07 | Definition, local process, daemon, and remote-peer lifetimes are distinct events. Restart tests prove which categories stop, become lost, reconnect, or resume; no process is reported alive without a heartbeat. | I,F,E,D | IN_PROGRESS |
| CR-01 | Cron parser supports standard five-field wildcard, step, range, list, and DOM/DOW OR semantics with local timezone and precise validation errors. | U,P,I | VERIFIED |
| CR-02 | Scheduler is independent from runtime, uses a date-aware minute marker, queues due work, and injects it only at safe turn boundaries. | U,P,I,F | VERIFIED |
| CR-03 | Recurring and one-shot jobs support create/list/delete, owner/thread, creation-time authority ceiling, workload tag, maximum 50 jobs, seven-day recurring expiry, and the deterministic jitter defaults in `docs/product/defaults.md`. | U,P,I,E | VERIFIED |
| CR-04 | Durable definitions survive restart with locks and watchers; session-only definitions do not. The UI distinguishes these states. | U,P,I,F,T | REQUIRED |
| CR-05 | A single invalid/failing job never kills the scheduler. Busy, coalescing, downtime, missed one-shot, recurring resume, local-timezone, and no-catch-up behavior matches `docs/product/defaults.md`. | U,P,I,F | VERIFIED |
| CR-06 | Session scheduler, local daemon/supervisor, and authenticated remote routine peer are separate backends with explicit availability; remote peer passes the frozen protocol/fixture and unattended claims require a live supervisor. | I,F,S,E,D | IN_PROGRESS |
| CR-07 | At fire time, a job intersects its creation-time authority ceiling with current managed policy. Work uses normal sandbox/budget/hook/audit/cancellation; without an approval channel, ask becomes `awaiting_approval` and never auto-allows. | U,I,S,E | VERIFIED |

## K. Git worktree isolation

Sources: [s18](https://learn.shareai.run/en/s18/) and [Claude Code worktrees](https://code.claude.com/docs/en/worktrees).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| GT-01 | Create an isolated worktree and branch from a validated base with collision-safe name/slug and no path traversal. | U,P,I,S | VERIFIED |
| GT-02 | Enter/exit worktree for a session and cwd override for agents/teammates are distinct; every tool resolves against its assigned worktree. | U,I,E | IN_PROGRESS |
| GT-03 | Persist original cwd/branch/head, worktree path/branch/base, owner/session, and recovery state. | U,I,F | IN_PROGRESS |
| GT-04 | Keep and remove are explicit. Removal refuses dirty/unpushed work by default; discard requires exact approval and produces an audit event. | U,I,S,T | IN_PROGRESS |
| GT-05 | Task-worktree binding is optional metadata and never silently changes task state; agent task ownership and workspace ownership remain independently recoverable. | U,P,I,F | IN_PROGRESS |
| GT-06 | Create/remove/keep hooks, config inclusion, concurrent worktrees, cleanup after failure, and non-Git error behavior are tested. | U,P,I,F,E | IN_PROGRESS |

## L. MCP and external extension

Sources: [s19](https://learn.shareai.run/en/s19/) and [Claude Code MCP](https://code.claude.com/docs/en/mcp).

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| MC-01 | MCP client connects, initializes, discovers, invokes, refreshes, and disconnects servers using standards-conformant JSON-RPC. | U,I,F,E,L | VERIFIED |
| MC-02 | Support stdio, Streamable HTTP, SSE, WebSocket, and in-process transports. `ide-sse` is this product's documented SSE connection profile/handshake, not an undocumented proprietary protocol. | U,I,F,D | REQUIRED |
| MC-03 | Names are normalized as `mcp__server__tool`; collisions, invalid characters, untrusted descriptions, schema abuse, and built-in precedence are handled deterministically. | U,P,I,S | VERIFIED |
| MC-04 | Tool annotations declare read-only/destructive/open-world behavior and feed the same policy, hook, sandbox, audit, timeout, output, and cancellation pipeline. | U,P,I,S,E | VERIFIED |
| MC-05 | Managed-exclusive policy is the ceiling; otherwise MCP precedence is connector < plugin < user < approved project < local, with provenance and explicit project trust. | U,P,I,S,D | REQUIRED |
| MC-06 | Lifecycle supports bounded parallel connect, classified errors, health, dynamic `list_changed`, timeout, and graded process termination. HTTP/SSE reconnect; stdio restarts only when explicitly configured. | U,P,I,F | VERIFIED |
| MC-07 | OAuth 2.0 + PKCE includes discovery, state/nonce, refresh/revocation/expiry/exchange and the Linux token-store hierarchy in defaults; plaintext SQLite or colocated master keys are forbidden. | U,P,I,F,S,E | IN_PROGRESS |
| MC-08 | Server-to-agent notifications, elicitation, resources, prompts, reverse permission requests, and wake-up channels are attributed and policy checked. | U,I,F,S,E | REQUIRED |
| MC-09 | Children inherit only approved MCP capabilities. Deferred schema refresh preserves the stable cache prefix; upfront-loaded schema content changes invalidate only their affected boundary, without leaking unavailable schemas. | U,P,I,S | REQUIRED |
| MC-10 | Large output offload, tool search/lazy schema loading, monitor tasks, doctor UI, and per-server logs make MCP usable at scale. | U,I,T,E | REQUIRED |

## M. Sessions, persistence, and replay

Source: [Claude Code sessions](https://code.claude.com/docs/en/sessions) plus the reliability requirements needed by all timeline stages.

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| SS-01 | Threads and turns persist incrementally in a versioned SQLite WAL event store with transactional projections and migrations. | U,P,I,F | VERIFIED |
| SS-02 | Create/list/continue/resume by picker/name/ID, rename, fork/branch, export, archive, delete, and clear-context are available in TUI/CLI with canonical-repo/global search and name rules from defaults. | U,I,T,E | IN_PROGRESS |
| SS-03 | Fork creates new identity and history lineage without changing the original; export is a stable public schema independent from internal tables. | U,P,I,E,D | IN_PROGRESS |
| SS-04 | Crash at every model/tool/approval/storage boundary recovers to a coherent state and never repeats a known-complete side effect. | P,I,F,E | VERIFIED |
| SS-05 | Intent, start, output, and result identities make side effects idempotent or explicitly indeterminate; destructive indeterminate work requires inspection. | U,P,I,F,S | VERIFIED |
| SS-06 | JSONL trace/export and deterministic replay can rebuild projections, preserve unknown events, compare runtime decisions, and scrub secrets. | U,P,I,S,E | IN_PROGRESS |
| SS-07 | Retention, pruning, vacuum, backup, restore, migration rollback, file permissions, and concurrent-process locking are documented and tested. | U,P,I,F,S,D | IN_PROGRESS |
| SS-08 | A per-user daemon owns the single writer lease. Additional clients attach through its Unix socket or explicitly fork; independent writers cannot interleave a thread, and cwd/worktree changes preserve canonical ownership. | U,P,I,F,E | IN_PROGRESS |

## N. TUI, interactive CLI, and headless automation

Sources: [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode), [fullscreen](https://code.claude.com/docs/en/fullscreen), [keybindings](https://code.claude.com/docs/en/keybindings), [status line](https://code.claude.com/docs/en/statusline), and [agent view](https://code.claude.com/docs/en/agent-view). These are behavioral references only, not cloning requirements.

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| UI-01 | Ink renderer consumes typed projections; completed transcript is static and active stream/status/editor update without rerendering unbounded history. | U,T,E | VERIFIED |
| UI-02 | Render Markdown, code, reasoning summary, citations/links, tool input/output, errors, progress, usage, and unified diffs with untrusted output visually separated from trusted chrome. | U,S,T,E | IN_PROGRESS |
| UI-03 | Multiline editor supports history, Ctrl-R search, paste/bracketed paste, Unicode/CJK/emoji/combining characters, word motion, selection, undo/redo, configurable submit, and optional Vim bindings. | U,P,T,E | IN_PROGRESS |
| UI-04 | `/` completes slash commands/skills and `@` completes files safely. `!` is a direct user shell action: no model prompt, but managed deny, configured isolation, audit, redaction, sanitized output, history, and no automatic model turn apply. | U,S,T,E | REQUIRED |
| UI-05 | Permission dialog shows actor, exact normalized action, diff/command/network target, risk, once/session/rule choices, deny, and current sandbox; tabs cannot hide relevant parameters. | U,S,T,E | REQUIRED |
| UI-06 | Mode/model/reasoning effort/thinking/status/budget/context controls are visible and validated; `yolo` warning is persistent and cannot be overwritten by tool output. | U,S,T,E | REQUIRED |
| UI-07 | Ctrl-C interrupts active work; idle first clears and second exits. Esc interrupts work or closes a dialog; double Esc clears a draft into history or opens rewind. Steering applies at a documented safe boundary. | U,I,F,T,E | REQUIRED |
| UI-08 | Background, task graph, agent/team, Cron, worktree, MCP, hook, memory, and session views support list, inspect, filter, open, and every domain action specified by its matrix rows. | U,T,E | REQUIRED |
| UI-09 | Transcript viewer supports expand/collapse, search, copy/export, external pager/editor, and tool detail without binding consumers to internal event storage. | U,T,E | IN_PROGRESS |
| UI-10 | Session picker and commands support create, resume, continue, branch/fork, rename, export, archive, delete, clear, compact, and context inspection. | U,T,E | VERIFIED |
| UI-11 | Classic scrollback renderer is production-ready; an optional fullscreen renderer may be added only after equivalent selection, resize, mouse/scroll, auto-follow, and restoration tests pass. | U,P,T,E | REQUIRED |
| UI-12 | Status line can show cwd/worktree, Git, model, mode, context, usage/cost, duration, rate/backoff, background count, team state, and cache without leaking secrets. | U,S,T | REQUIRED |
| UI-13 | Resize from narrow to large terminals, suspend/resume, SSH disconnect, signal exit, uncaught error, child PTY, and normal exit always restore cursor, raw mode, echo, and screen state. | P,I,F,T | REQUIRED |
| UI-14 | Performance spike passes the payloads and p95 latency/RSS thresholds in `docs/quality/acceptance.md`, including 10K rows, 50K live characters, unfinished Markdown, 2K-line diff, and resize. | P,T | REQUIRED |
| UI-15 | Headless CLI supports interactive plain text, one-shot prompt, stdin, structured JSON/JSONL events, quiet/no-color, exit codes, resume, approvals through a typed channel, and deterministic automation. | U,I,E | IN_PROGRESS |
| UI-16 | Required commands and aliases are `/help`, `/doctor`, `/config`, `/permissions`, `/model`, `/mode`, `/prompt-mode`, `/plan`, `/context`, `/compact`, `/memory`, `/skills`, `/hooks`, `/mcp`, `/tasks`, `/agents`, `/team`, `/background`, `/cron`, `/loop`, `/worktree`, `/sessions`, `/resume`, `/branch`, `/rewind`, `/recap`, `/btw`, `/tui`, `/status`, `/export`, `/clear`, and `/quit`. | U,T,E,D | REQUIRED |
| UI-17 | `/btw` answers a side question without tools or main-task-history pollution and reports its separate provider usage. | U,T,E,L | REQUIRED |
| UI-18 | Create a session-local checkpoint before every model-initiated file change. `/rewind` can restore conversation, code, or both after stale-file checks; shell/network/MCP/external side effects are explicitly non-rewindable. | U,P,I,F,S,T,E | REQUIRED |

## O. Observability, security, quality, packaging, and release

These capabilities are required to make every timeline feature usable rather than merely present.

| ID | Required behavior | Minimum evidence | Status |
|---|---|---|---|
| OB-01 | Local structured trace records redacted model parameters, items, tools, policy, approvals, hooks, timings, retries, compaction, cancellation, usage, and acceptance evidence. | U,I,S,E | IN_PROGRESS |
| OB-02 | Logs, metrics, trace, and current state are readable by humans and implementing agents through CLI/JSON; verbosity and retention are configurable and telemetry is opt-in. | U,I,S,D | IN_PROGRESS |
| OB-03 | Doctor reports environment, config provenance, provider capabilities, credential presence without value, sandbox, terminal, Git, MCP, storage, migrations, and known degradation. | U,I,S,T,D | IN_PROGRESS |
| SC-01 | Adversarial suite covers malicious repository instructions, secret exfiltration, path/symlink escape, shell indirection, package/Git hooks, MCP abuse, ANSI/OSC spoofing, approval confusion, and resource exhaustion. | P,I,S,E | REQUIRED |
| SC-02 | Repository content is untrusted context and cannot elevate tools, policy, network, secret access, hooks, skills, or managed configuration. | U,P,I,S | VERIFIED |
| SC-03 | Audit records actor, normalized action, policy inputs, decision, grant scope, sandbox, result identity, and redacted errors for every side effect. | U,P,I,S | REQUIRED |
| QL-01 | Root scripts provide format, lint, typecheck, unit, integration, security, PTY, E2E, live, build, architecture, and aggregate check gates. | I,E,D | IN_PROGRESS |
| QL-02 | CI runs deterministic gates from a clean clone with locked dependencies, no network where avoidable, test sharding, artifacts, and failure diagnostics. | I,F,D | REQUIRED |
| QL-03 | Dependency direction, cycles, forbidden host I/O, package exports, schema compatibility, file-size/complexity guardrails, and docs links are mechanically checked. | U,I | IN_PROGRESS |
| QL-04 | Tests include unit, property, contract, integration, failure injection, security, PTY, performance, deterministic evals, and credentialed live E2E without flaky pass-through. | P,I,F,S,T,E,L | REQUIRED |
| PK-01 | Clean Linux host bootstrap installs pinned Node active LTS/pnpm and required sandbox/terminal dependencies or reports exact unavailable prerequisites. | I,F,D | VERIFIED |
| PK-02 | Build produces a versioned CLI package with lockfile, integrity, install/uninstall, config migration, upgrade/rollback, and shell completion. | I,F,E,D | VERIFIED |
| PK-03 | Managed policy is an immutable deny-first ceiling; ordinary and MCP values use the exact per-key precedence in defaults, with schema migration, conflict tests, and source explanation. | U,P,I,S,D | IN_PROGRESS |
| PK-04 | Release artifacts, changelog, migration notes, support bundle, SBOM/dependency audit, and reproducible verification are generated without secrets. | I,S,D | VERIFIED |

## Final cross-capability golden paths

The following scenarios are mandatory in addition to row-level evidence:

1. **Coding loop:** open an unfamiliar fixture repository, plan, build a task graph, edit multiple files, run failing tests, diagnose, fix, show exact diff, and complete with no unrelated changes.
2. **Recovery:** disconnect during streaming, kill runtime during journal write and during a child process, resume, and prove no completed side effect ran twice.
3. **Permissions:** run the same repository goal in all four profiles, including malicious instructions attempting to read credentials, escape a symlink, enable network, and forge an approval screen.
4. **Long context:** generate large tool output and transcript, trigger offload and compaction, then prove goal, constraints, tasks, active files, team identity, and permissions remain correct.
5. **Team execution:** lead creates dependent tasks, launches isolated teammates/worktrees, handles permission and plan approvals, resolves concurrent claiming, receives background results, and shuts down cleanly.
6. **Scheduling:** background test and one-shot/recurring Cron survive supported restarts, notify the correct thread, and obey permission, sandbox, and budget.
7. **MCP:** connect local stdio and HTTP reference servers, complete OAuth against a fixture issuer, receive dynamic tools and reverse notification, and reject a malicious tool/server.
8. **TUI:** complete a real task over SSH/PTY with multiline Unicode input, resize, diff approval, background panels, interrupt, session resume, and terminal restoration.
9. **Live model:** `qwen3.7-max` streams text and reasoning summary, calls multiple tools, survives a retryable fault, reports usage, edits a safe fixture, and passes its tests.
10. **Fresh install:** a clean clone on the recorded Linux target bootstraps, checks, builds, starts, completes a deterministic task, exports the session, and uninstalls without residue outside documented state.

The implementation goal may complete only when every row above is `VERIFIED`, each golden path passes, and evidence is reproducible from the committed repository.
