# Frozen product defaults

Snapshot date: 2026-07-12

Defaults make acceptance deterministic. Every value is configurable within managed safety ceilings, and `doctor` reports the effective value and provenance. Changing a default before implementation requires an ADR and corresponding test updates; changing it merely to pass a failing test is forbidden.

## Permission and isolation are separate axes

Canonical public permission profiles:

| Profile | Prompt behavior | Default isolation |
|---|---|---|
| `plan` | mutations unavailable | read-only workspace, network denied |
| `ask` | exact side effects prompt | workspace-write sandbox, network denied until granted |
| `auto-accept-edits` | dedicated workspace file tools auto-allow; all shell and other side effects ask | workspace-write sandbox |
| `yolo` | no interactive prompts | isolation disabled |

Compatibility aliases: `default` and `manual` map to `ask`; `acceptEdits` maps to `auto-accept-edits`; `bypassPermissions` maps to `yolo`. This product intentionally keeps shell commands such as `mkdir`, `mv`, and `cp` in the ask path; equivalent dedicated typed file tools may auto-allow. `auto` classifier and `dontAsk` are policy-rule strategies, not additional public top-level modes.

`yolo` means maximum authority allowed by the immutable managed-policy ceiling. Managed hard deny, credential isolation/redaction, audit integrity, resource budgets, cancellation, and terminal sanitization remain active. The user may configure isolation independently, but a profile can never request more authority than managed policy allows.

Protected-path defaults include:

- repository `.git/**` writes, except operations exposed by a dedicated validated Git tool;
- `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `.npmrc`, `.pypirc`, `.netrc`, Git credential files, and configured secret patterns;
- `~/.ssh/**`, `~/.aws/**`, `~/.config/gcloud/**`, `~/.kube/**`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`, and equivalent XDG credential stores;
- `/etc/**`, `/proc/**`, `/sys/**`, `/dev/**`, `/boot/**`, `/root/**`, container/daemon sockets, cloud metadata endpoints, and administrator-managed additions.

Normalize by expanding home, requiring absolute canonical roots, Unicode NFC, resolving every existing parent, using `openat2`-style beneath/no-magic-link constraints where available, opening with no-follow semantics, and rechecking device/inode after open. Safe profiles deny pre-existing hardlinked regular files by default unless an exact brokered grant proves approved provenance. `plan` denies protected access; `ask` and `auto-accept-edits` require an exact grant; `yolo` may access only what managed policy does not deny. Dedicated Git status/diff reads expose a safe projection rather than arbitrary `.git` file access.

## Configuration precedence

Managed policy is an immutable upper safety bound and cannot be relaxed by any lower source.

Within that bound, ordinary product values resolve:

```text
explicit CLI/session override
> approved per-key environment override
> local project settings
> shared project settings
> user settings
> built-in defaults
```

Environment variables participate only for documented keys. Security decisions merge deny-first across all scopes rather than using last-write-wins.

MCP configuration resolves managed-exclusive policy first. When not exclusive, later entries override earlier entries in this order:

```text
connector < plugin < user < approved project < local
```

An overriding source cannot weaken managed restrictions or silently trust a project server.

## Runtime budgets

| Budget | Default |
|---|---:|
| turns per user goal | 200 |
| model calls per turn | 100 |
| tool calls per turn | 1,000 |
| wall time per turn | 8 hours |
| active child agents | 4 |
| total child agents per turn | 16 |
| child depth | 2 |
| active teammates | 8 |
| safe read-tool concurrency | 8 |
| foreground conflicting mutations | 1 per resource |
| retry attempts before visible output | 10, bounded by 5 minutes |
| retry backoff | 500 ms base, 30 s cap, full jitter, honor server hint |

No budget is silently increased. A user may raise it within managed limits and receives a visible usage warning.

## Context and skill defaults

- Reserve 15% of provider context for response and tool overhead.
- Start proactive compaction at 85% of the usable input budget; reactive compaction handles provider overflow.
- Reattach at most 5,000 tokens per recently used skill and 25,000 tokens total after compaction.
- Root/unscoped instructions and auto memory reattach after compaction.
- Nested and path-scoped instructions reattach only after a matching file/path is accessed again.
- Deferred tool schemas remain out of the stable prompt prefix. Upfront schema-set changes invalidate only the affected cache boundary.

Prompt modes:

| Mode | Observable behavior |
|---|---|
| `minimal` | identity, protocol, tool schemas, current policy, and safety only; no proactive workflow guidance |
| `default` | normal coding workflow: inspect, plan when needed, edit, verify, summarize |
| `proactive` | may create tasks, use background work, and continue obvious next steps inside current authority |
| `coordinator` | lead performs planning, delegation, review, merge, and verification; direct mutation tools are unavailable to the lead |
| `agent-defined` | validated user/project prompt sections; inherits the same hard policy and only explicitly granted tools |

Modes activate through config or `/prompt-mode`, emit ConfigChange, have deterministic prompt deltas/cache keys, and never change permission or isolation implicitly.

## Memory defaults

- Load the first 200 lines or 25 KiB of `MEMORY.md`, whichever comes first.
- Load topic files only on demand.
- Retrieve at most five memory files and 50 KiB total per turn by default.
- Auto memory is machine-local and shared by worktrees of the same canonical repository.
- `/memory` shows provenance and permits audited edits.
- Extract only after a naturally completed, non-cancelled turn with a stable user/project lesson. A valid empty extraction is a no-op.
- YAML memory types, side-selection, team-shared memory, and Dream consolidation are product extensions frozen from the Timeline requirements.

Dream becomes eligible after five successfully completed sessions or seven days since the last consolidation, with at least ten candidate memories or 32 KiB of candidate content. Run at most once per 24 hours per canonical repository. Use a five-minute renewable lock lease, ten-minute wall limit, one model call, at most 64K input tokens and 8K output tokens, and no write if the result fails schema/provenance checks. Crash or lease loss preserves the prior index atomically.

## Tool and output defaults

| Limit | Default |
|---|---:|
| model-facing inline tool preview | 64 KiB, bounded head and tail |
| TUI inline output before pager/offload | 1 MiB |
| background-output warning | 10 MiB |
| background-output hard stop | 5 GiB |
| MCP warning threshold | 10,000 tokens |
| MCP model-facing inline result | 25,000 tokens |
| MCP single-result durable limit before external offload | 500,000 characters |

Control characters are sanitized before model, TUI, logs, or export. Full output is stored only when policy permits and is addressed by a redacted durable reference.

## Cron defaults

- Standard five-field expression, minimum one minute, local timezone, DOM/DOW OR.
- Maximum 50 jobs per owner.
- Recurring jobs expire after seven days unless renewed.
- Default deterministic jitter is up to `min(10% of interval, 15 minutes)`, matching the frozen Timeline behavior. A documented compatibility option may use `min(half interval, 30 minutes)`.
- A due job while a turn is busy is coalesced once for that scheduled instant and runs at the next safe boundary.
- Session jobs never catch up after process downtime.
- Durable recurring jobs resume at the next future instant; missed instants are recorded, not replayed.
- A missed durable one-shot is marked `missed` and requires explicit rerun.
- A job captures an immutable authority ceiling at creation and intersects it with current managed policy at fire time.
- Without an interactive approval channel, an ask-required action becomes `awaiting_approval`; it never auto-approves. Preapproved narrow rules may allow unattended execution.

## Team recovery defaults

Team definition, inbox, task graph, and logical member identity are durable. Operating-system processes are not.

After runtime loss:

- previous process incarnations become `lost`, never `running`;
- outstanding protocol requests expire with typed failure;
- owned tasks become reclaimable after their lease;
- inbox messages remain durable;
- explicit team resume spawns a new incarnation under the same logical member ID and records the lineage;
- messages to an old incarnation are rejected or routed only through a recorded logical-member mapping.

## Remote agent and routine peer

Remote execution is a real second process, not an in-memory fake. `apps/remote-worker` implements the reference peer.

- Transport: TLS WebSocket for bidirectional commands/events; HTTPS health and capability discovery may accompany it.
- Authentication: a short-lived, audience-bound one-time worker token delivered through an approved secret channel. Production may add mTLS. Tokens are never sent to the model or delegated task context.
- Handshake: protocol version, worker identity/incarnation, supported capabilities, platform, sandbox profiles, model/tool availability, maximum budgets, and last acknowledged sequence.
- Envelope: version, message ID, correlation/causation IDs, thread/turn/task IDs, monotonic sequence, deadline, authority-ceiling digest, message type, and typed payload.
- Required messages: hello/capabilities, lease offer/accept/reject, input, event batch/ack, approval request/response, cancel/ack, heartbeat, result, failure, and resume-from-sequence.
- Heartbeat: every 15 seconds; mark disconnected after 45 seconds. Work becomes `unknown` until resume or lease expiry, never immediately replayed.
- Reconnect: bounded backoff and resume from the last acknowledged sequence. Message IDs and side-effect IDs are idempotent.
- Authority: remote work receives the intersection of the creation-time ceiling and current managed policy. The remote worker enforces its own sandbox and may request narrower approval; it cannot broaden authority.
- Cancellation: correlated cancel propagates to remote model/tool/process tree and returns a terminal acknowledgement or explicit unknown state.

Acceptance uses two isolated processes or containers over loopback TLS, then a configurable network-address smoke. The fixture proves authentication rejection, capability mismatch, heartbeat loss, reconnect/resume, duplicate envelope, cancellation, indeterminate side effect, and clean completion. A local object implementing the interface does not satisfy remote evidence.

## Session ownership defaults

- Session names are unique within a canonical repository; ID always disambiguates.
- Picker defaults to the current canonical repository and all its worktrees; a global flag searches all projects.
- One runtime daemon holds the writer lease for a thread. Additional clients attach through the daemon or explicitly fork; two independent SQLite writers may not interleave turns.
- A thread retains canonical project/worktree identity across cwd changes; every cwd change is validated and evented.

## MCP transport and cache defaults

- `ide-sse` is ordinary MCP SSE wire transport plus this product's IDE connection profile; it does not emulate a proprietary competitor protocol. An IDE adapter registers over the local daemon socket with `{profileVersion, serverId, sseUrl, postUrl, workspaceRoot, clientName, capabilityHints, credentialHandle, expiresAt}`. The daemon authenticates the local peer with socket credentials, validates canonical workspace and HTTPS/loopback URLs, resolves the opaque credential handle through secret-store, and then performs standard MCP initialize over SSE. Typed failures include invalid-profile, unauthorized-peer, expired-profile, workspace-mismatch, unsafe-url, connection, auth, protocol, and server errors. A separate-process fixture covers registration, expiry, auth rejection, reconnect, dynamic tools, and cleanup.
- HTTP and SSE reconnect with bounded backoff. Stdio does not restart automatically unless the server config explicitly opts in.
- Deferred/lazy tool schemas preserve the stable prompt prefix across `list_changed`; upfront-loaded schema sets invalidate the affected cache boundary only when content changes.

## OAuth token storage

Use Linux Secret Service/libsecret when available. On a headless host without it, use an encrypted credential file with mode 0600 and a master key supplied by an approved secret provider; never store the master key beside ciphertext. If neither secure option exists, keep tokens in memory for the session and refuse persistent OAuth credentials. Refresh tokens, access tokens, authorization codes, and client secrets use the same redaction and child-environment restrictions as the model key.

## TUI behavior defaults

- Classic view appends immutable completed summaries to terminal scrollback.
- A separate transcript inspector renders a virtualized typed projection for expand/collapse/search/copy and complete tool detail.
- Resume replays the latest 200 display items in classic view; older history remains accessible through inspector/search.
- Ctrl-C during work interrupts; while idle, first Ctrl-C clears input and second exits.
- Esc during work interrupts and in dialogs closes the dialog. Double Esc with a draft clears it into history; with an empty draft opens rewind.
- `!command` is a direct user action: no model approval prompt, but managed deny, configured isolation, audit, redaction, and output sanitization still apply. Output is stored as a user-shell item and does not automatically trigger a model turn.
- Before each model-initiated file change, create a session-local code checkpoint. Rewind can restore conversation, code, or both when files are unchanged since the checkpoint. It never claims to undo shell, network, MCP, or other external side effects.

## Background notification and input watchdog

Notification priority is FIFO within these levels: (1) approval/elicitation, shutdown, and security failure; (2) task failure/completion, agent/team state, and lost remote work; (3) ordinary background completion and Cron fire; (4) progress and periodic status. After ten consecutive higher-priority deliveries, deliver one waiting lower-priority item to prevent starvation.

Background tools cannot read the controlling terminal directly. A typed input request immediately changes the job to `awaiting_input` and emits priority-1 notification. If a process attempts undeclared interactive TTY input or remains in detected input-wait state for 30 seconds, the watchdog suspends it and requests input. After five minutes without an available approval/input channel, mark it `blocked` while preserving process/output according to policy; never guess input or auto-approve. Default foreground tool concurrency is four subject to resource-conflict serialization.
