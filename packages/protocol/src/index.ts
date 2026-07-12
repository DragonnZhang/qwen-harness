/**
 * @qwen-harness/protocol
 *
 * Commands, events, items, schemas, versions. LAYER 0.
 *
 * This package performs NO filesystem, process, network, database, clock, random, or environment
 * I/O. That is not a guideline — `pnpm architecture` fails the build if this package imports a
 * host module, and `clock.ts` / `ids.ts` define time and identity as *interfaces* precisely so
 * that no ambient `Date.now()` or `Math.random()` can leak in. Determinism of the entire runtime
 * (RT-08) rests on this.
 */

export * from './ids.ts';
export * from './domain.ts';
export * from './events.ts';
export * from './errors.ts';
export * from './commands.ts';
export * from './clock.ts';
