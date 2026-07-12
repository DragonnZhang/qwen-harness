/**
 * @qwen-harness/tools-core
 *
 * Tool contracts, registry, and concurrency planning. PURE — layer 1.
 *
 * The important structural fact: this package holds tool DEFINITIONS (name, schemas, annotations,
 * timeout, footprint) but never HANDLERS. Handlers live in the sandboxed tool-worker. That is why
 * a main-process `fs` call cannot implement a model tool — there is nowhere in the runtime to put
 * one, because the handler type does not exist on this side of the boundary.
 */

export * from './contract.ts';
export * from './registry.ts';
export * from './scheduler.ts';
