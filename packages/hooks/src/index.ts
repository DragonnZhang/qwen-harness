/**
 * @qwen-harness/hooks
 *
 * The hook ENGINE plus the typed event/outcome model (HK-01..HK-05). A hook can observe or STEER
 * the runtime — block an action, inject context, propose an input change, request a stricter
 * permission, annotate MCP output, or stop continuation — but it can NEVER elevate authority.
 *
 * Two invariants are the whole point, and both are enforced by the engine, not by hook authors:
 *
 *   1. NO ELEVATION. A hook is handed the current policy decision and may only return one that is
 *      equal or MORE restrictive. `allow`/`passthrough` from a hook is recorded and ignored. A
 *      managed hard deny dominates every hook outcome (threat model, invariant #1).
 *   2. STOP RE-ENTRY PROTECTION. A Stop already in progress refuses a re-entrant Stop, and a Stop
 *      hook that asks to Stop again is recorded as refused rather than looping. Post-tool hooks may
 *      stop continuation without corrupting the durable tool result.
 *
 * `hooks` is a declared I/O owner for `node:child_process` ONLY (the command executor). HTTP hooks
 * route through the injected `NetworkBroker` (the `network` package); model/agent hooks route
 * through injected runners. All hook OUTPUT is untrusted and crosses protocol's `sanitize()`.
 */

export * from './events.ts';
export * from './outcome.ts';
export * from './registry.ts';
export * from './ports.ts';
export * from './executor.ts';
export * from './clock.ts';
export * from './result.ts';
export * from './engine.ts';
