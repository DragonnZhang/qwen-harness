# ADR 0001: Specification seed decisions

Status: accepted
Date: 2026-07-12

## Context

The repository must allow a long-running coding agent to build a complete harness from a nearly empty codebase using one goal invocation. The goal is feature-complete behavior, not a teaching mock, and the implementing agent/model may change.

## Decisions

1. Use an event-driven TypeScript/Node pnpm monorepo.
2. Keep runtime headless and make TUI/CLI typed protocol clients.
3. Use Thread, Turn, Item, and Event as durable domain concepts.
4. Make the actual Linux cloud host the only initially claimed platform.
5. Implement one live provider, `provider-dashscope`, for `qwen3.7-max`; keep core provider-neutral.
6. Use Ink for the TUI behind an adapter and require a performance/PTY spike.
7. Use SQLite WAL as authoritative append-only event storage and JSONL for export/replay.
8. Implement `plan`, `ask`, `auto-accept-edits`, and `yolo` as explicit policy profiles with Linux isolation for the first three.
9. Treat the frozen capability matrix as the feature-parity source of truth.
10. Allow public competitor documentation but prohibit competitor source inspection or dependency.
11. Make the one-shot prompt executor-neutral and internally checkpointed.

## Consequences

- Initial setup is larger than a single package, but boundaries are testable and mechanically enforceable.
- A real Linux sandbox backend is a release gate, not an optional warning.
- Provider details cannot leak into runtime or UI types.
- The implementation may take many autonomous checkpoints even though the user supplies one goal.
- The initial repository contains specifications and control files, not a prebuilt implementation skeleton.
