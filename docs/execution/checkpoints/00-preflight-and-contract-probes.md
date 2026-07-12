# Checkpoint 00 - Preflight and contract probes

Status: PASSED
Date: 2026-07-12
Live lane: `LIVE_AVAILABLE`

## 1. Target host (recorded)

This is the only platform the product claims.

| Property     | Value                                                           |
| ------------ | --------------------------------------------------------------- |
| Distribution | Ubuntu 26.10 (Stonking Stingray), `ID=ubuntu`, `ID_LIKE=debian` |
| Kernel       | Linux 7.0.0-22-generic SMP PREEMPT_DYNAMIC                      |
| Architecture | x86_64, 64-bit                                                  |
| Host         | `iZrj9ggw3hg6mll96kqw4mZ` (Alibaba Cloud ECS)                   |
| Shell        | `/usr/bin/zsh`                                                  |
| Terminal     | `TERM=tmux-256color`, `COLORTERM=truecolor`                     |
| CPU / Memory | 2 vCPU / 3494 MiB total, 2548 MiB available                     |
| Disk         | 49 G total, 21 G available on `/`                               |
| Filesystem   | ext2/ext3 family on `/dev/vda3`                                 |
| Privilege    | `uid=0(root)` — system packages installable                     |

Reproduce with `scripts/probe-host.sh`.

## 2. Toolchain (frozen)

| Tool            | Version                     | Note                                                   |
| --------------- | --------------------------- | ------------------------------------------------------ |
| Node.js         | v24.16.0                    | active LTS line; satisfies Ink `>=22`                  |
| pnpm            | 11.9.0                      | via corepack 0.24.0                                    |
| git             | 2.53.0                      |                                                        |
| C/C++ toolchain | `cc`, `g++`, `make` present | required: `node-pty` has no prebuild for this platform |

Frozen dependency versions are recorded in ADR 0002.

## 3. Sandbox backend probe

`bubblewrap` (`/usr/bin/bwrap`) is present and fully functional. Unprivileged user
namespaces are enabled (`/proc/sys/user/max_user_namespaces = 7530`,
`unprivileged_userns_clone = 1`).

Probed and **proven on this host**, not inferred:

| Control               | Probe                                           | Result                                                       |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Filesystem isolation  | `bwrap` without binding `/root` then `ls /root` | `No such file or directory` — host home not visible          |
| Read-only enforcement | write to a `--ro-bind` mount                    | `Read-only file system`                                      |
| Writable scratch      | `--tmpfs /tmp` write+read                       | succeeded, isolated                                          |
| Network denial        | `--unshare-all` then `curl https://example.com` | code `000` — no egress                                       |
| Network grant         | `--share-net` then same curl                    | `200` — grantable when policy allows                         |
| User-namespace remap  | `--unshare-user --uid 1000 --gid 1000`          | process observes `uid=1000`                                  |
| Node inside sandbox   | `node -e` under `bwrap`                         | `node-in-bwrap-ok v24.16.0` — the tool-worker can run inside |
| Resource limits       | `prlimit` present                               | available for rlimit caps                                    |

Decision: bubblewrap is the real Linux sandbox backend. See ADR 0003.

## 4. DashScope provider contract probe

Endpoint `https://dashscope.aliyuncs.com/compatible-mode/v1`, model `qwen3.7-max`,
credential read from `DASHSCOPE_API_KEY` (present; value never printed, logged, or committed).

### Responses transport (primary) — confirmed

63 SSE events captured. Observed event names:

```
response.created, response.in_progress, response.output_item.added,
response.output_item.done, response.content_part.added, response.content_part.done,
response.output_text.delta, response.output_text.done,
response.reasoning_summary_text.delta, response.reasoning_summary_text.done,
response.function_call_arguments.delta, response.function_call_arguments.done,
response.completed
```

- **Reasoning summary is returned** as `item.type="reasoning"` with `summary[].type="summary_text"`. This is a summary, and is renderable/persistable.
- **Function calls** arrive as `item.type="function_call"` carrying `call_id` (e.g. `call_…`) distinct from the item `id`, plus complete `arguments` JSON on `output_item.done`. Argument deltas _were_ observed, but per the frozen contract the adapter must not depend on them: the completed item is sufficient.
- **Usage** from `response.completed.response.usage`:
  `input_tokens`, `output_tokens`, `total_tokens`, `output_tokens_details.reasoning_tokens`,
  `input_tokens_details.cached_tokens`.
- `store: true` and `parallel_tool_calls: true` are server defaults; `background: false`.

Fixture: `fixtures/provider/dashscope/responses-stream-text-reasoning-tool.jsonl`

### Chat Completions transport (compatibility) — confirmed

- `delta.tool_calls` is **fragmented**: the `id` and `function.name` appear only on the first
  fragment; subsequent fragments carry `arguments` substrings and an empty `id`. They must be
  assembled by `index`.
- `delta.reasoning_content` is emitted (11 chunks). Per the frozen contract this is **raw
  reasoning, not a summary**: it is discarded and never relabeled or persisted as a summary.
- `finish_reason: "tool_calls"`.
- Usage arrives in a **final chunk with `choices: []`** when `stream_options.include_usage=true`,
  including `completion_tokens_details.reasoning_tokens`.

Fixture: `fixtures/provider/dashscope/chat-stream-text-reasoning-tool.jsonl`

### Error contract — confirmed

| Condition          | HTTP | Provider code                                              | Retryable |
| ------------------ | ---- | ---------------------------------------------------------- | --------- |
| unknown model      | 404  | `model_not_found`                                          | no        |
| bad credential     | 401  | `invalid_api_key`                                          | no        |
| `background: true` | 400  | `InvalidParameter` — _"Currently not support background."_ | no        |

The `background: true` rejection is **independent live confirmation** of the frozen
`background=false` capability bit; it is a real server-side rejection, not an assumption.
Request IDs are present both in the response body (`request_id`) and the `x-request-id` header,
and are preserved (redacted) in errors.

Fixture: `fixtures/provider/dashscope/errors.json`

All fixtures are scrubbed: `grep -rIE 'sk-[A-Za-z0-9]{16,}' fixtures/` returns nothing.

## 5. Ink / TUI spike

Ink 7.1.0 + React 19.2.7, run under a **real PTY** (`node-pty` 1.1.0), against the payloads
required by `docs/quality/acceptance.md`:

- 10,000 completed transcript rows through `<Static>` (immutable scrollback);
- a 50,000-character incremental live stream (782 discrete frame updates);
- multiline CJK, emoji, combining characters, and unterminated Markdown in row content;
- a mid-stream resize from 80x24 to 160x50.

| Metric                   | Threshold                           | Measured (compiled)                             | Result |
| ------------------------ | ----------------------------------- | ----------------------------------------------- | ------ |
| p50 active-frame work    | —                                   | 0.11 ms                                         |        |
| p95 active-frame work    | < 50 ms                             | **0.49 ms**                                     | PASS   |
| Peak RSS                 | < 512 MiB                           | **481 MiB**                                     | PASS   |
| Static render (10K rows) | —                                   | 3.06 ms                                         |        |
| Resize 80x24 -> 160x50   | honored                             | Ink observed `cols=160, rows=50`                | PASS   |
| Terminal restoration     | cursor restored, no alt-screen leak | 1 hide / 3 show, 0 alt-screen sequences, exit 0 | PASS   |

**Finding worth recording:** the same spike run through the `tsx` on-the-fly transpiler measured
**520 MiB RSS — over the 512 MiB gate**. Running the identical bundled JavaScript measured
481 MiB. The transpiler, not Ink, was the cost. Consequence: the TUI must ship and be
performance-gated as **compiled output**, never executed through an in-process transpiler.
This is captured as a constraint in ADR 0004 and is enforced by the build.

Headroom note: the fixture holds all 10,000 rows in React state simultaneously, which is
strictly worse than the product design (classic view replays the latest 200 display items and
the inspector virtualizes). The measured 481 MiB is therefore a pessimistic bound.

## 6. Gate

| Requirement                      | Result                                                    |
| -------------------------------- | --------------------------------------------------------- |
| Host is Linux                    | PASS — Ubuntu 26.10 x86_64                                |
| Toolchain proven                 | PASS — Node 24.16.0, pnpm 11.9.0, C++ toolchain           |
| Sandbox candidate proven on host | PASS — bubblewrap, all six control classes                |
| Storage candidate proven         | PASS — better-sqlite3 12.11.1, WAL enabled, SQLite 3.x    |
| TUI dependency proven            | PASS — Ink 7 under PTY, within latency and RSS thresholds |
| Provider contract proven         | PASS — Responses + Chat + errors, fixtures captured       |
| Credential present               | PASS — live lane is `LIVE_AVAILABLE`                      |

Checkpoint 0 passes. Product implementation may begin at checkpoint 01.
