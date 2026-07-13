# @qwen-harness/agents

Subagent delegation with bounded authority (section F). A subagent is a child turn with its own
history, prompt, tools, model, budget, and permission identity.

## The invariants that make delegation safe

- **A child never gets more authority than its parent.** Its authority is the intersection of what
  the parent requested, the parent's own ceiling, and current managed policy (AG-03). Even if the
  parent requests `yolo` for a child, an `ask` parent yields an `ask`-bounded child — verified by
  tests. A defense-in-depth check refuses to run any child whose computed authority is not
  provably at most the parent's.
- **Depth and count are bounded** (defaults: depth 2, 16 children/turn, 4 active). A child at max
  depth cannot spawn grandchildren; `childSupervisor` increments depth so the bound propagates down
  the tree, so a child cannot create an unbounded team.
- **Parent cancellation propagates** through one abort signal — a child whose parent was cancelled
  before it started never runs.
- **Completion returns a bounded, attributed conclusion** — the summary is capped, never the
  child's whole transcript (AG-01/AG-04).

The turn runner is injected, so this package does not depend on the concrete runtime — a subagent
runs whatever `SubagentRunner` the app provides (in practice, a bounded `TurnEngine` turn).
