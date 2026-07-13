import { describe, expect, it } from 'vitest';

import { SequentialIds } from '@qwen-harness/testkit';

import {
  authorityForProfile,
  authorityOf,
  parseTaskSpecs,
  teammateAuthority,
} from '../../src/index.ts';

/**
 * The row-level, in-process companion to the golden-path-5 e2e (`evals/e2e/team.test.ts`, which
 * proves the REAL cross-process orchestration, isolated worktrees, and concurrent claiming).
 *
 * Here we pin the deterministic invariants that do not need child processes: the untrusted `--tasks`
 * boundary, and — the core team invariant — that a teammate's authority is the intersection of its
 * request, the lead's ceiling, and managed policy, and can therefore only ever NARROW, never widen.
 */

const CWD = '/tmp/qh-team-authority';
const WT = '/tmp/qh-team-authority/.wt/mem_a';

describe('team: authority intersection (a teammate can never exceed the lead)', () => {
  it('clamps a wider requested profile down to the lead ceiling', () => {
    const lead = authorityForProfile('ask');
    const ceiling = authorityOf(lead, CWD);

    // A teammate asking for `yolo` under a lead holding `ask` is clamped to `ask` — never widened.
    const granted = teammateAuthority(ceiling, lead.managedPolicy, new SequentialIds(), 'yolo', WT);
    expect(granted.profile).toBe('ask');
    expect(granted.isolation).not.toBe('disabled'); // yolo's disabled isolation did not leak in
  });

  it('allows a NARROWER requested profile (a teammate may request less)', () => {
    const lead = authorityForProfile('auto-accept-edits');
    const ceiling = authorityOf(lead, CWD);

    const granted = teammateAuthority(ceiling, lead.managedPolicy, new SequentialIds(), 'plan', WT);
    expect(granted.profile).toBe('plan');
  });

  it('a teammate under a managed `plan` ceiling is clamped to plan even asking for yolo', () => {
    // Simulate the managed ceiling the e2e uses: maxProfile plan. `authorityForProfile` resolves
    // through the real config path; here we assert the intersection honours a plan lead ceiling.
    const lead = authorityForProfile('plan');
    const ceiling = authorityOf(lead, CWD);
    const granted = teammateAuthority(ceiling, lead.managedPolicy, new SequentialIds(), 'yolo', WT);
    expect(granted.profile).toBe('plan');
  });
});

describe('team: --tasks validation (untrusted boundary)', () => {
  it('parses a dependent task graph', () => {
    const tasks = parseTaskSpecs('[{"subject":"build"},{"subject":"ship","blockedBy":[1]}]');
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.blockedBy).toEqual([1]);
  });

  it('rejects malformed input rather than trusting it', () => {
    expect(() => parseTaskSpecs('[{"subject":""}]')).toThrow();
    expect(() => parseTaskSpecs('{"subject":"x"}')).toThrow();
    expect(() => parseTaskSpecs('not json')).toThrow();
  });
});
