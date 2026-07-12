# @qwen-harness/tools-core

Tool contracts, registry, and concurrency planning. **Pure** — layer 1, no host I/O.

## The structural point

This package holds tool **definitions** — name, schemas, annotations, timeout, footprint — and
never **handlers**. Handlers live in `tool-worker` and execute only inside the sandbox.

That split is the architecture, not a style preference. It is *why* a main-process `fs` call cannot
implement a model tool: there is nowhere in the runtime to put one, because the handler type does
not exist on that side of the boundary. The rule is enforced by the type system rather than by a
review checklist.

## Batching is derived from arguments, not from tool names

One model output can contain many calls. Running them all in parallel races; running them all
serially is needlessly slow. `planBatches` partitions calls **in original order** based on the
**actual resource footprint of the actual arguments**:

- two `write_file` calls to *different* paths do not conflict as resources;
- a `read_file` of a path a sibling call is writing very much does — in both orders;
- an **unbounded** call (an arbitrary shell command) conflicts with *everything*, because we cannot
  reason about what it will touch, so it never shares a batch. Conservative on purpose.

Every mutation is serialized even when its declared footprint looks disjoint: a mutation's real
footprint can exceed what it declares (a write triggers a file watcher; a shell command has
arbitrary effects), and the cost of being wrong is a corrupted workspace.

Original order is preserved across batches, so a call never observes a state the model did not
intend it to observe. `read a, write a, read a` produces three batches, not two.

## The validation pipeline

`validateCall` owns the first two stages of the chain TL-07 mandates:

```
schema -> semantic -> hard policy -> pre hooks -> permission -> sandbox -> execution
```

Semantic validation runs only *after* the shape is known good, so it can trust its input. There is
deliberately no function anywhere that "just runs a tool" — every path goes through the whole chain.

## `plan` sees no mutating tool at all

`ToolRegistry.availableFor(profile)` filters by `availableIn`. In `plan`, a mutating tool is not
merely denied at approval time — it is **absent from the model's tool list entirely** (PS-02). A
tool the model was never offered cannot be smuggled through shell indirection, a hook, an MCP call,
or a subagent, because the model has no name to call.
