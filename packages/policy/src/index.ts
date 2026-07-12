/**
 * @qwen-harness/policy
 *
 * The deny-by-default permission engine. LAYER 1, and PURE: no filesystem, no process, no network,
 * no clock, no RNG, no environment. `pnpm architecture` fails the build if that ever stops being
 * true.
 *
 * Purity is not an aesthetic. A permission decision that can read the world is a permission
 * decision that two callers can get differently — and the difference between "the sandbox
 * canonicalized this path" and "the policy engine canonicalized this path" is a TOCTOU window.
 * Policy receives an already-canonical `NormalizedAction`, proves it is canonical, and decides.
 * The host I/O that produces one lives in `sandbox-linux`.
 */

export * from './action.ts';
export * from './paths.ts';
export * from './matcher.ts';
export * from './rules.ts';
export * from './grants.ts';
export * from './managed.ts';
export * from './authority.ts';
export * from './engine.ts';
export * from './context.ts';
