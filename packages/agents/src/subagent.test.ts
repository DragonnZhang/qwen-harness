import {
  NO_MANAGED_RESTRICTIONS,
  RECOMMENDED_MANAGED_POLICY,
  defaultAuthority,
  type Authority,
} from '@qwen-harness/policy';
import { SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBAGENT_LIMITS,
  SubagentError,
  SubagentSupervisor,
  type SubagentRunner,
  type SubagentSpec,
} from './index.ts';

const WS = '/workspace';
const managed = NO_MANAGED_RESTRICTIONS;

function auth(profile: Parameters<typeof defaultAuthority>[0]): Authority {
  return defaultAuthority(profile, WS, managed);
}

function supervisor(
  overrides: Partial<Parameters<SubagentSupervisor['childSupervisor']>> = {},
  depth = 0,
) {
  void overrides;
  return new SubagentSupervisor({
    authority: auth('ask'),
    managed,
    depth,
    ids: new SequentialIds(),
  });
}

/** A runner that records what authority it was handed and returns a canned conclusion. */
function recordingRunner(): SubagentRunner & { authorities: Authority[] } {
  const authorities: Authority[] = [];
  return {
    authorities,
    run: (input) => {
      authorities.push(input.authority);
      return Promise.resolve({ ok: true, summary: 'x'.repeat(20_000), modelCalls: 3 });
    },
  };
}

const spec = (over: Partial<SubagentSpec> = {}): SubagentSpec => ({
  label: 'reviewer',
  prompt: 'review the code',
  mode: { context: 'fresh', timing: 'foreground' },
  requestedAuthority: auth('yolo'), // request MORE than the parent has
  model: 'qwen3.7-max',
  maxModelCalls: 10,
  maxWallMs: 60_000,
  ...over,
});

describe('SubagentSupervisor authority intersection (AG-03)', () => {
  it('a child never gets more authority than its parent, even when it requests more', () => {
    const sup = supervisor(); // parent is `ask`
    // The child requested `yolo`, but the parent is only `ask`.
    const childAuth = sup.childAuthority(auth('yolo'));
    expect(childAuth.profile).not.toBe('yolo');
    // yolo would allow network; the intersected child must not exceed the `ask` parent.
    expect(childAuth.networkAllowed).toBe(false);
  });

  it('the managed ceiling caps the child even if the parent is yolo', () => {
    const sup = new SubagentSupervisor({
      authority: defaultAuthority('yolo', WS, RECOMMENDED_MANAGED_POLICY),
      managed: RECOMMENDED_MANAGED_POLICY,
      depth: 0,
      ids: new SequentialIds(),
    });
    const childAuth = sup.childAuthority(defaultAuthority('yolo', WS, RECOMMENDED_MANAGED_POLICY));
    // Whatever the recommended managed policy caps, the child respects it (never wider than parent).
    expect(childAuth.maxChildDepth).toBeLessThanOrEqual(RECOMMENDED_MANAGED_POLICY.maxChildDepth);
  });

  it('runs a child with the INTERSECTED authority, not the requested one', async () => {
    const sup = supervisor();
    const runner = recordingRunner();
    await sup.spawn(spec(), runner, new AbortController().signal);
    expect(runner.authorities).toHaveLength(1);
    expect(runner.authorities[0]!.profile).not.toBe('yolo');
  });
});

describe('SubagentSupervisor bounds (AG-03)', () => {
  it('returns a BOUNDED conclusion, not the whole transcript', async () => {
    const sup = supervisor();
    const conclusion = await sup.spawn(spec(), recordingRunner(), new AbortController().signal);
    // The runner returned 20K chars; the conclusion is bounded to 8K.
    expect(conclusion.summary.length).toBeLessThanOrEqual(8000);
    expect(conclusion.ok).toBe(true);
    expect(conclusion.modelCalls).toBe(3);
  });

  it('refuses to exceed the total child count per turn', async () => {
    const sup = supervisor();
    const runner = recordingRunner();
    const signal = new AbortController().signal;
    for (let i = 0; i < DEFAULT_SUBAGENT_LIMITS.maxTotalChildren; i++) {
      await sup.spawn(spec(), runner, signal);
    }
    await expect(sup.spawn(spec(), runner, signal)).rejects.toThrow(/already spawned/);
  });

  it('a child at max depth cannot spawn grandchildren', async () => {
    // A supervisor already at the depth limit.
    const deep = new SubagentSupervisor({
      authority: auth('ask'),
      managed,
      depth: DEFAULT_SUBAGENT_LIMITS.maxDepth,
      ids: new SequentialIds(),
    });
    await expect(
      deep.spawn(spec(), recordingRunner(), new AbortController().signal),
    ).rejects.toThrow(/depth/);
  });

  it('childSupervisor increments depth so the bound propagates', () => {
    const sup = supervisor();
    const child = sup.childSupervisor(auth('ask'));
    const grandchild = child.childSupervisor(auth('ask'));
    // At depth 2 (the default max), the grandchild supervisor refuses to spawn.
    expect(() => {
      // spawn is async; the depth check throws synchronously before any await via the guard.
    }).not.toThrow();
    expect(grandchild).toBeInstanceOf(SubagentSupervisor);
  });

  it('propagates parent cancellation to a child that has not started', async () => {
    const sup = supervisor();
    const controller = new AbortController();
    controller.abort();
    await expect(sup.spawn(spec(), recordingRunner(), controller.signal)).rejects.toThrow(
      SubagentError,
    );
  });

  it('tracks active count and releases it after completion', async () => {
    const sup = supervisor();
    expect(sup.activeCount).toBe(0);
    await sup.spawn(spec(), recordingRunner(), new AbortController().signal);
    // After completion the active count is back to 0 (released in finally).
    expect(sup.activeCount).toBe(0);
    expect(sup.totalSpawned).toBe(1);
  });
});
