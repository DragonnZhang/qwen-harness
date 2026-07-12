/**
 * @qwen-harness/testkit
 *
 * Deterministic fakes: clock, ID source, actors, event factories, fixture repositories.
 *
 * These exist so the runtime can be exercised with ZERO ambient nondeterminism (RT-08). Nothing
 * here bypasses production validation, policy, or storage — a fake provider still emits real
 * normalized events through the real schema, and a fake tool still goes through the real policy
 * pipeline. A fixture that dodges the production path would prove nothing (protocol §7).
 */

import {
  ManualClock,
  type Actor,
  type ActorId,
  type CorrelationId,
  type IdSource,
  type PermissionProfile,
  type ThreadId,
} from '@qwen-harness/protocol';

export { ManualClock };

/**
 * Monotonic, prefix-aware, gap-free ID source. Reproducible across runs, which is what makes a
 * golden event log diffable at all.
 */
export class SequentialIds implements IdSource {
  #counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(6, '0')}`;
  }

  reset(): void {
    this.#counters.clear();
  }
}

export const USER_ACTOR: Actor = { kind: 'user', id: 'act_user01' as ActorId };
export const MODEL_ACTOR: Actor = {
  kind: 'model',
  id: 'act_model1' as ActorId,
};
export const SYSTEM_ACTOR: Actor = {
  kind: 'system',
  id: 'act_system' as ActorId,
};

export interface TestContext {
  readonly clock: ManualClock;
  readonly ids: SequentialIds;
  readonly threadId: ThreadId;
  readonly correlationId: CorrelationId;
  readonly profile: PermissionProfile;
}

export function testContext(overrides: Partial<TestContext> = {}): TestContext {
  return {
    clock: new ManualClock(1_700_000_000_000),
    ids: new SequentialIds(),
    threadId: 'thr_000001' as ThreadId,
    correlationId: 'cor_000001' as CorrelationId,
    profile: 'ask',
    ...overrides,
  };
}

export * from './fixture-repo.ts';
export * from './canaries.ts';
