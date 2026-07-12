# Source map and research policy

Snapshot date: 2026-07-12

This repository exhaustively freezes externally described behavior into `docs/product/capability-matrix.md` as of 2026-07-12. External pages may change or disappear; they are explanatory references, not live dependencies, and they generate no future requirements or permission to change scope.

Frozen matrix SHA-256: `2c31f3b5681d94efa48a5398e74451dd6576648ddccb942eaafc814ebb16fe20`. The hash covers the initial seed matrix before implementation begins updating row status/evidence; future changes remain auditable through Git history.

## Source priority

When implementing or resolving ambiguity:

1. `task.md` and explicit hard constraints.
2. `docs/product/capability-matrix.md` user-visible behavior and evidence.
3. `docs/architecture/design.md`, security, quality, and execution documents.
4. Official DashScope documentation when validating the frozen provider wire assumptions; changes require an ADR and must not be inferred from a successful ignored parameter.
5. Public product documentation only to explain a frozen row, never to add new scope automatically.
6. A documented ADR using the smallest behavior that satisfies the frozen requirement.

If a current external page conflicts with the frozen matrix, do not silently change scope. Preserve the frozen product requirement, record the discrepancy, and implement compatibility or an explicit ADR where both cannot coexist.

## Research prohibition

Public documentation is allowed. Do not clone, browse, search, install, decompile, inspect source maps, or otherwise examine source code for Claude Code, Codex, or another competing coding harness. Do not use an installed competitor binary as an oracle for undocumented internals. Generic open-source libraries selected as product dependencies may be reviewed normally.

## Product background

- [Internal DingTalk background document](https://alidocs.dingtalk.com/i/nodes/lyQod3RxJKe9QjOMionmEx4QWkb4Mw9r)
  - Frozen takeaway: use one comprehensive PRD and a persistent `/goal`; after launch, the model autonomously designs, implements, tests, repairs, and documents the harness without human steering.
  - The initial implementation is produced by an outer coding agent; the finished harness is standalone and does not self-bootstrap during construction.
  - Verification, architecture, and explicit feature definitions are the primary success criteria.
  - This repository contains all required background; implementation must not depend on access to the private document.

## ShareAI Harness Tutorial - required capability baseline

- [Timeline index](https://learn.shareai.run/en/timeline/)
- [s01 - The Agent Loop](https://learn.shareai.run/en/s01/)
- [s02 - Tool Use](https://learn.shareai.run/en/s02/)
- [s03 - Permission](https://learn.shareai.run/en/s03/)
- [s04 - Hooks](https://learn.shareai.run/en/s04/)
- [s05 - TodoWrite](https://learn.shareai.run/en/s05/)
- [s06 - Subagent](https://learn.shareai.run/en/s06/)
- [s07 - Skills](https://learn.shareai.run/en/s07/)
- [s08 - Context Compact](https://learn.shareai.run/en/s08/)
- [s09 - Memory](https://learn.shareai.run/en/s09/)
- [s10 - System Prompt](https://learn.shareai.run/en/s10/)
- [s11 - Error Recovery](https://learn.shareai.run/en/s11/)
- [s12 - Task System](https://learn.shareai.run/en/s12/)
- [s13 - Background Tasks](https://learn.shareai.run/en/s13/)
- [s14 - Cron Scheduler](https://learn.shareai.run/en/s14/)
- [s15 - Agent Teams](https://learn.shareai.run/en/s15/)
- [s16 - Team Protocols](https://learn.shareai.run/en/s16/)
- [s17 - Autonomous Agents](https://learn.shareai.run/en/s17/)
- [s18 - Worktree Isolation](https://learn.shareai.run/en/s18/)
- [s19 - MCP Tools](https://learn.shareai.run/en/s19/)
- [s20 - Comprehensive Agent Turn](https://learn.shareai.run/en/s20/)

The teaching examples are not production acceptance. The matrix already incorporates the production behaviors selected from these pages, including behavior omitted by compact teaching code. The implementation agent must not reread the live pages as an unbounded requirement generator. LOC and tool counts are not quality metrics.

## Claude Code public behavioral references

These pages clarify user-visible semantics only:

### Core loop, tools, and errors

- [Overview](https://code.claude.com/docs/en/overview)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Agent SDK loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Errors](https://code.claude.com/docs/en/errors)

### Permissions and hooks

- [Permission modes](https://code.claude.com/docs/en/permission-modes)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- [Hooks reference](https://code.claude.com/docs/en/hooks)

### Context, memory, skills, and prompt

- [Skills](https://code.claude.com/docs/en/skills)
- [Context window](https://code.claude.com/docs/en/context-window)
- [Memory](https://code.claude.com/docs/en/memory)
- [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Prompt caching](https://code.claude.com/docs/en/prompt-caching)

### Work orchestration

- [Todo tracking and task migration](https://code.claude.com/docs/en/agent-sdk/todo-tracking)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Background commands](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)
- [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)
- [Worktrees](https://code.claude.com/docs/en/worktrees)
- [MCP](https://code.claude.com/docs/en/mcp)

### Sessions and terminal interface

- [Sessions](https://code.claude.com/docs/en/sessions)
- [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
- [Fullscreen](https://code.claude.com/docs/en/fullscreen)
- [Keybindings](https://code.claude.com/docs/en/keybindings)
- [Status line](https://code.claude.com/docs/en/statusline)
- [Commands](https://code.claude.com/docs/en/commands)
- [Agent view](https://code.claude.com/docs/en/agent-view)

Current official documentation sometimes differs from the ShareAI teaching snapshot. The committed matrix intentionally includes current additions such as 30 hook events, current task tools, session controls, and TUI requirements while retaining Timeline-only capabilities such as the richer memory/Dream design.

## OpenAI harness and repository engineering

- [Harness Engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [Codex sandboxing](https://developers.openai.com/codex/sandboxing)
- [Agent approvals and security](https://developers.openai.com/codex/agent-approvals-security)

Adopted principles:

- humans specify goals, constraints, and acceptance while agents execute and verify;
- repository knowledge is structured, versioned, and progressively disclosed;
- `AGENTS.md` is a compact map rather than an encyclopedia;
- architecture and quality rules are mechanically enforced;
- runtime state, logs, metrics, traces, UI, and tests are readable by the implementing agent;
- failures should improve tools, abstractions, context, or feedback rather than trigger blind retries;
- isolated worktrees and checkpointed evidence keep long-running work recoverable.

The finished product does not use Codex SDK or App Server. Thread/Turn/Item is an adopted domain pattern, not a dependency.

## DashScope official provider documentation

- [Text generation model list](https://help.aliyun.com/zh/model-studio/text-generation-model)
- [Qwen through OpenAI-compatible Responses API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)
- [Qwen through OpenAI-compatible Chat Completions](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [Deep thinking](https://help.aliyun.com/zh/model-studio/deep-thinking)
- [Error codes](https://help.aliyun.com/en/model-studio/error-code)

Frozen provider decisions:

- adapter name `provider-dashscope`;
- default model `qwen3.7-max`;
- default base URL `https://dashscope.aliyuncs.com/compatible-mode/v1`, configurable for workspace/regional endpoints;
- credential environment variable `DASHSCOPE_API_KEY`;
- Responses is the preferred transport; Chat Completions is maintained as a compatibility path;
- reasoning is normalized as summaries; raw chain-of-thought is not a product contract;
- provider capability negotiation is explicit because compatibility is not feature-identical;
- local event storage remains authoritative even when remote response continuation is used.

## TUI dependency references

- [Ink repository and documentation](https://github.com/vadimdemedes/ink)
- [Ink 7.1.0 release](https://github.com/vadimdemedes/ink/releases/tag/v7.1.0)
- [Ink testing library](https://github.com/vadimdemedes/ink-testing-library)

Ink is selected because it is Node-native and mature. The implementation pins exact versions after the checkpoint-0 host spike. Markdown, diff, advanced input, transcript performance, and real PTY behavior remain product responsibilities and release gates rather than assumptions about the renderer.
