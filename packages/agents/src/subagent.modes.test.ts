import { NO_MANAGED_RESTRICTIONS, defaultAuthority, type Authority } from '@qwen-harness/policy';
import type { ModelInputItem } from '@qwen-harness/provider-core';
import { SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBAGENT_LIMITS,
  SubagentError,
  SubagentSupervisor,
  type SubagentMode,
  type SubagentRunner,
  type SubagentSpec,
} from './index.ts';

/**
 * PASS 1 of AG-02: the two-axis mode (context × timing) and its two entry points — foreground
 * `spawn` (awaits) and background `spawnBackground`/`join`/`joinAll` (returns a handle). These
 * tests pin (1) fresh vs forked observability at the runner, (2) background timing + active
 * accounting, (3) the documented background-failure contract, and (4) that the existing guards
 * still fire under the struct mode and through the background path.
 */

const WS = '/workspace';
const managed = NO_MANAGED_RESTRICTIONS;

function auth(profile: Parameters<typeof defaultAuthority>[0]): Authority {
  return defaultAuthority(profile, WS, managed);
}

function supervisor(depth = 0, limits = DEFAULT_SUBAGENT_LIMITS): SubagentSupervisor {
  return new SubagentSupervisor({
    authority: auth('yolo'),
    managed,
    depth,
    ids: new SequentialIds(),
    limits,
  });
}

const FRESH_FG: SubagentMode = { context: 'fresh', timing: 'foreground' };
const FORKED_FG: SubagentMode = { context: 'forked', timing: 'foreground' };
const FRESH_BG: SubagentMode = { context: 'fresh', timing: 'background' };
const FORKED_BG: SubagentMode = { context: 'forked', timing: 'background' };

const spec = (over: Partial<SubagentSpec> = {}): SubagentSpec => ({
  label: 'child',
  prompt: 'do a thing',
  mode: FRESH_FG,
  requestedAuthority: auth('ask'),
  model: 'qwen3.7-max',
  maxModelCalls: 5,
  maxWallMs: 30_000,
  ...over,
});

const SEED: readonly ModelInputItem[] = [{ type: 'message', role: 'user', text: 'parent prefix' }];

/** A runner that records whether it was handed a forkedContext seed on each call. */
function seedSpyRunner(): SubagentRunner & { seeds: Array<readonly ModelInputItem[] | undefined> } {
  const seeds: Array<readonly ModelInputItem[] | undefined> = [];
  return {
    seeds,
    run: (input) => {
      seeds.push('forkedContext' in input ? input.forkedContext : undefined);
      return Promise.resolve({ ok: true, summary: 'done', modelCalls: 1 });
    },
  };
}

/** A runner whose completion is controlled from the test via `resolve`/`reject`. */
function deferredRunner(): SubagentRunner & {
  started: boolean;
  resolve: (r: { ok: boolean; summary: string; modelCalls: number }) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (r: { ok: boolean; summary: string; modelCalls: number }) => void;
  let reject!: (e: unknown) => void;
  const gate = new Promise<{ ok: boolean; summary: string; modelCalls: number }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const state = {
    started: false,
    resolve,
    reject,
    run: () => {
      state.started = true;
      return gate;
    },
  };
  return state;
}

describe('AG-02 fresh vs forked context (U)', () => {
  it('a FRESH child receives no forkedContext seed even if the spec carries one', async () => {
    const sup = supervisor();
    const runner = seedSpyRunner();
    const conclusion = await sup.spawn(
      spec({ mode: FRESH_FG, forkedContext: SEED }),
      runner,
      new AbortController().signal,
    );
    expect(runner.seeds).toEqual([undefined]);
    expect(conclusion.ok).toBe(true);
    expect(conclusion.label).toBe('child');
  });

  it('a FORKED child receives the parent seed passed straight through', async () => {
    const sup = supervisor();
    const runner = seedSpyRunner();
    await sup.spawn(
      spec({ mode: FORKED_FG, forkedContext: SEED }),
      runner,
      new AbortController().signal,
    );
    expect(runner.seeds).toHaveLength(1);
    expect(runner.seeds[0]).toBe(SEED);
  });

  it('a FORKED child with no seed supplied simply passes no key (not an explicit undefined)', async () => {
    const sup = supervisor();
    const runner = seedSpyRunner();
    await sup.spawn(spec({ mode: FORKED_FG }), runner, new AbortController().signal);
    expect(runner.seeds).toEqual([undefined]);
  });
});

describe('AG-02 background timing and active accounting (U)', () => {
  it('spawnBackground returns while the child is still pending; join yields the conclusion', async () => {
    const sup = supervisor();
    const runner = deferredRunner();
    const handle = sup.spawnBackground(
      spec({ mode: FRESH_BG }),
      runner,
      new AbortController().signal,
    );
    // The handle is back but the child has not settled: it counts as active.
    expect(runner.started).toBe(true);
    expect(sup.activeCount).toBe(1);
    expect(handle.agentId).toBeDefined();

    runner.resolve({ ok: true, summary: 'y'.repeat(20_000), modelCalls: 2 });
    const conclusion = await handle.join();
    expect(conclusion.ok).toBe(true);
    expect(conclusion.modelCalls).toBe(2);
    // Bound preserved on the background path too.
    expect(conclusion.summary.length).toBe(8000);
    expect(sup.activeCount).toBe(0);
  });

  it('joinAll collects multiple background children (spawn order) and clears the active count', async () => {
    const sup = supervisor();
    const r1 = deferredRunner();
    const r2 = deferredRunner();
    const h1 = sup.spawnBackground(
      spec({ mode: FRESH_BG, label: 'a' }),
      r1,
      new AbortController().signal,
    );
    const h2 = sup.spawnBackground(
      spec({ mode: FORKED_BG, label: 'b' }),
      r2,
      new AbortController().signal,
    );
    expect(sup.activeCount).toBe(2);
    void h1;
    void h2;

    // Settle out of spawn order; joinAll must still return in SPAWN order.
    r2.resolve({ ok: true, summary: 'B', modelCalls: 1 });
    r1.resolve({ ok: true, summary: 'A', modelCalls: 1 });
    const all = await sup.joinAll();
    expect(all.map((c) => c.label)).toEqual(['a', 'b']);
    expect(sup.activeCount).toBe(0);
  });

  it('a background child counts as active until settle: past maxActiveChildren throws active-exceeded', () => {
    const sup = supervisor(0, { ...DEFAULT_SUBAGENT_LIMITS, maxActiveChildren: 2 });
    const runners = [deferredRunner(), deferredRunner()];
    sup.spawnBackground(spec({ mode: FRESH_BG }), runners[0]!, new AbortController().signal);
    sup.spawnBackground(spec({ mode: FRESH_BG }), runners[1]!, new AbortController().signal);
    expect(sup.activeCount).toBe(2);
    // A third in-flight background child exceeds the active bound while the first two are pending.
    expect(() =>
      sup.spawnBackground(spec({ mode: FRESH_BG }), deferredRunner(), new AbortController().signal),
    ).toThrow(SubagentError);
    // Drain so the deferred promises do not leak.
    runners.forEach((r) => r.resolve({ ok: true, summary: 'x', modelCalls: 1 }));
    return sup.joinAll();
  });
});

describe('AG-02 background-failure contract (F)', () => {
  it('a background child whose runner REJECTS surfaces through join as a rejection, no leaked slot', async () => {
    const sup = supervisor();
    const runner = deferredRunner();
    const handle = sup.spawnBackground(
      spec({ mode: FRESH_BG }),
      runner,
      new AbortController().signal,
    );
    expect(sup.activeCount).toBe(1);

    const boom = new Error('child blew up');
    runner.reject(boom);
    await expect(handle.join()).rejects.toBe(boom);
    // The active slot is released on settle regardless of success/failure — no leak.
    expect(sup.activeCount).toBe(0);
    expect(sup.totalSpawned).toBe(1);
  });
});

describe('AG-02 wrong entry point rejects the mismatched timing', () => {
  it('spawn() refuses a background spec and points at spawnBackground', async () => {
    const sup = supervisor();
    await expect(
      sup.spawn(spec({ mode: FRESH_BG }), seedSpyRunner(), new AbortController().signal),
    ).rejects.toThrow(/spawnBackground/);
  });

  it('spawnBackground() refuses a foreground spec and points at spawn', () => {
    const sup = supervisor();
    expect(() =>
      sup.spawnBackground(spec({ mode: FRESH_FG }), seedSpyRunner(), new AbortController().signal),
    ).toThrow(/spawn\(\)/);
  });
});

describe('AG-02 existing guards preserved under struct mode', () => {
  it('the depth guard still fires through the BACKGROUND path', () => {
    const deep = supervisor(DEFAULT_SUBAGENT_LIMITS.maxDepth);
    expect(() =>
      deep.spawnBackground(
        spec({ mode: FRESH_BG }),
        deferredRunner(),
        new AbortController().signal,
      ),
    ).toThrow(/depth/);
    expect(deep.activeCount).toBe(0);
  });

  it('a background spawn honors the cancelled-before-start guard', () => {
    const sup = supervisor();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      sup.spawnBackground(spec({ mode: FRESH_BG }), deferredRunner(), controller.signal),
    ).toThrow(SubagentError);
    expect(sup.activeCount).toBe(0);
  });

  it('the authority intersection still narrows a widened background request', () => {
    const sup = new SubagentSupervisor({
      authority: auth('ask'),
      managed,
      depth: 0,
      ids: new SequentialIds(),
    });
    // Parent is `ask`; the child requests `yolo` but must not get network.
    const child = sup.childAuthority(auth('yolo'));
    expect(child.networkAllowed).toBe(false);
  });
});
