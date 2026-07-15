import fc from 'fast-check';
import { NO_MANAGED_RESTRICTIONS, type Authority } from '@qwen-harness/policy';
import { describe, expect, it } from 'vitest';

import type { SkillDescriptor } from './descriptor.ts';
import { assertPlanNeverBroadens, planSkillExecution } from './execution.ts';
import { validateSkillFrontmatter } from './frontmatter.ts';

/**
 * Property test for skill execution planning (IN-05 `P`).
 *
 * A skill is untrusted text; its `allowed-tools` may only NARROW the caller's tools, never add one,
 * and a forked skill's authority may never be broader than its parent's. Over arbitrary declared
 * tools, held tools, context modes, and parent authorities, the plan must satisfy the real backstop
 * `assertPlanNeverBroadens` and keep its effective tools a subset of the parent's held tools.
 */

const POOL = ['read_file', 'write_file', 'grep', 'run_shell', 'list_dir'];

function skill(fm: Record<string, unknown>): SkillDescriptor {
  const frontmatter = validateSkillFrontmatter(
    { name: 's', description: 'd', ...fm },
    'test:SKILL.md',
  );
  return {
    name: frontmatter.name,
    source: 'project',
    frontmatter,
    origin: { kind: 'memory', body: 'body' },
    provider: null,
  };
}

const authorityArb: fc.Arbitrary<Authority> = fc.record({
  profile: fc.constantFrom('plan', 'ask', 'auto-accept-edits', 'yolo'),
  isolation: fc.constantFrom('read-only', 'workspace-write', 'disabled'),
  networkAllowed: fc.boolean(),
  workspaceRoots: fc.constant(['/repo']),
  rules: fc.constant([]),
  grants: fc.constant([]),
  maxChildDepth: fc.integer({ min: 1, max: 3 }), // >=1 so a fork is possible, never depth-exhausted
});

describe('planSkillExecution never broadens authority (IN-05 P)', () => {
  it('effective tools are always a subset of the parent, and the backstop always holds', () => {
    fc.assert(
      fc.property(
        fc.subarray(POOL),
        fc.option(fc.subarray(POOL), { nil: undefined }),
        fc.constantFrom('inline', 'forked'),
        authorityArb,
        (parentTools, allowed, context, authority) => {
          const plan = planSkillExecution({
            descriptor: skill({ ...(allowed ? { 'allowed-tools': allowed } : {}), context }),
            parentTools,
            parentAuthority: authority,
            managed: NO_MANAGED_RESTRICTIONS,
            budgetTokens: 5_000,
          });

          // Effective tools never exceed what the parent held.
          const held = new Set(parentTools);
          for (const tool of plan.tools) expect(held.has(tool)).toBe(true);

          // A declared tool the parent does NOT hold is denied, never granted.
          if (allowed) {
            for (const tool of allowed) if (!held.has(tool)) expect(plan.denied).toContain(tool);
          }

          // The real backstop — the same one production asserts — holds for every input.
          expect(() => assertPlanNeverBroadens(plan, parentTools, authority)).not.toThrow();
        },
      ),
      { numRuns: 2000 },
    );
  });
});
