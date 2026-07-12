/**
 * @qwen-harness/tools-builtin
 *
 * The built-in tool DEFINITIONS. Each tool knows three things about itself: its input/output
 * schema (what the model may send), the `NormalizedAction` it becomes (what policy decides over),
 * and the `WorkerRequest` it becomes (what the sandboxed worker executes).
 *
 * Keeping those three in one place is the guarantee that the thing policy judged is exactly the
 * thing the worker runs — a tool whose policy view and execution view could drift is a tool whose
 * approval means nothing. No handler lives here; execution happens in `tool-worker`, in the sandbox.
 */

export * from './tools.ts';
export * from './pipeline.ts';
