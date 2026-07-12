# qwen-harness

`qwen-harness` is a specification-first seed repository for building a standalone coding-agent runtime and terminal UI. The finished product will use `qwen3.7-max` through Alibaba Cloud Model Studio (DashScope), implement every capability described by the frozen ShareAI s01-s20 timeline, and add the product, safety, recovery, observability, and TUI work needed for those capabilities to be genuinely usable.

This initial commit intentionally contains no harness implementation. It contains the source-of-truth specification and a one-shot goal prompt for an autonomous coding agent to design, implement, test, repair, and document the product.

## Start the autonomous implementation

On the target Linux server:

```sh
git clone https://github.com/DragonnZhang/qwen-harness.git
cd qwen-harness
```

Avoid placing a real key in shell history. An interactive shell can load it without echoing:

```sh
read -rsp 'DashScope API key: ' DASHSCOPE_API_KEY && printf '\n'
export DASHSCOPE_API_KEY
```

Then, in any coding agent that supports persistent goals and `@file` references, run:

```text
/goal implement @task.md
```

The implementation prompt is executor-neutral. Codex, Qwen Code, GLM-backed agents, or another capable long-running coding agent may execute it. The finished harness must not wrap or depend on any of them.

## Read first

1. [`task.md`](task.md) - autonomous implementation objective, constraints, checkpoints, and definition of done.
2. [`AGENTS.md`](AGENTS.md) - compact repository navigation and non-negotiable engineering rules.
3. [`docs/product/capability-matrix.md`](docs/product/capability-matrix.md) - exhaustive feature and acceptance source of truth.
4. [`docs/architecture/design.md`](docs/architecture/design.md) - approved architecture and data flow.
5. [`docs/execution/implementation-protocol.md`](docs/execution/implementation-protocol.md) - persistent checkpoint protocol.
6. [`docs/quality/acceptance.md`](docs/quality/acceptance.md) and [`docs/security/threat-model.md`](docs/security/threat-model.md) - release gates.
7. [`docs/product/defaults.md`](docs/product/defaults.md) - frozen defaults and compatibility semantics.

## Frozen product decisions

- Product runtime: TypeScript and Node.js in a pnpm monorepo.
- Target: the Linux cloud host on which the autonomous implementation runs; the exact distribution and architecture are captured during checkpoint 0.
- Real model backend: DashScope `qwen3.7-max`, with a provider-neutral internal protocol.
- Default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`.
- Credential source: `DASHSCOPE_API_KEY` only. Secrets must never enter prompts, logs, traces, fixtures, snapshots, commits, or crash reports.
- UI: Ink-based TUI over SSH/PTY plus a headless JSON CLI.
- Permission profiles: `plan`, `ask`, `auto-accept-edits`, and `yolo`.
- Scope: every ShareAI timeline capability, production hardening described in the frozen matrix, and the necessary TUI/product surface.
- Competitive research: public documentation is allowed; competitor source code is forbidden.

## Source material

- [ShareAI Harness Tutorial timeline](https://learn.shareai.run/en/timeline/)
- [Claude Code documentation](https://code.claude.com/docs/en/overview) for public behavioral reference only
- [OpenAI Harness Engineering](https://openai.com/index/harness-engineering/) for repository and verification design principles
- [DashScope model list](https://help.aliyun.com/zh/model-studio/text-generation-model) and [Responses API compatibility](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)

The detailed, frozen source map is in [`docs/references/sources.md`](docs/references/sources.md). External pages may change; the committed capability matrix controls implementation and acceptance.

## Security notice

Do not place API keys in configuration JSON. Configuration stores the environment-variable name, never its value. Any credential previously pasted into a chat or log should be rotated before running the live end-to-end suite.

## Current status

Specification seed complete. Product implementation has not started.

The seed may be authored or inspected from another operating system, but the implementation goal and release claims must run on the recorded Linux target. Do not start `/goal` on a non-Linux host and then claim its platform gates passed.

No open-source license is granted by this private seed. Choose a license explicitly before making the implementation public.
