/**
 * @qwen-harness/provider-core
 *
 * The normalized, provider-neutral model contract. LAYER 1 (pure).
 *
 * Nothing in here knows which vendor is on the other end of the socket. A vendor wire type may
 * never appear in this package, and may never escape the adapter that produced it — that is
 * boundary 6 in task.md, and `pnpm architecture` enforces the purity half of it (no host module,
 * no `Date.now()`, no `Math.random()`, no `process.env`).
 */

export * from './capabilities.ts';
export * from './events.ts';
export * from './model.ts';
export * from './provider.ts';
export * from './retry.ts';
export * from './usage.ts';
