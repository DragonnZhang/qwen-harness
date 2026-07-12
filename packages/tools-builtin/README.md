# @qwen-harness/tools-builtin

The built-in tool definitions, and the single execution pipeline.

## One tool, three views

Each tool is defined once and knows how to describe itself three ways:

- its **schema** — what the model may send;
- the `NormalizedAction` it becomes — what **policy** decides over;
- the `WorkerRequest` it becomes — what the **sandboxed worker** executes.

Keeping those in one place is the guarantee that they agree: *the thing policy judged is exactly
the thing the worker runs*. A tool whose policy view and execution view could drift is a tool whose
approval means nothing. No handler lives here — execution happens in `tool-worker`, inside the
sandbox.

Tools: `read_file`, `list_dir`, `search`, `write_file`, `edit_file`, `run_shell`, `git_status`,
`git_diff`. Mutating tools are absent from `plan` entirely (PS-02) — the model is never offered a
tool it may not use.

## The pipeline is the only path

`ToolPipeline.execute` runs the stages TL-07 mandates, and there is **no shortcut**:

```
schema  →  semantic  →  policy  →  (approval, obtained by the caller)  →  sandbox worker
```

Every tool call goes through here. A second, simpler path would be a second place to forget a
check. The pipeline decides and executes but never prompts: when policy says `ask`, it returns
`needs-approval` and the runtime — which owns the interactive channel — obtains the grant and calls
back. That split keeps the pipeline free of UI.

Paths handed to policy are canonicalized (`posix.resolve`), because policy rejects a non-canonical
action outright — a `.` or `..` segment is a bug or an attack, not something to prompt about.

## Proven end to end

The checkpoint-02 E2E (`evals/e2e/coding-loop.test.ts`) drives a scripted model through a real
coding loop — read a failing test, run it and see it fail, read the source, fix it with an edit,
run the test and see it pass, show the one-line diff — entirely through this pipeline and the real
bubblewrap sandbox. It also proves deny-by-default (`plan` refuses the edit before it reaches the
worker) and schema rejection (an absolute-path write is refused at the schema layer).
