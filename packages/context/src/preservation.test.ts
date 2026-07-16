import { describe, expect, it } from 'vitest';

import { PRESERVED_FIELDS, PreservedContextSchema } from './compaction.ts';

/**
 * Compaction preserves goal/state and never invents completion (CX-05, U+F).
 *
 * The preservation CONTRACT is the schema a compaction summary must satisfy: a required, non-empty
 * goal plus every state list. Two things follow — a summary that forgets the goal is rejected rather
 * than accepted (fail-closed), and there is no `completed`/`done` field the summarizer could fabricate
 * to make a half-finished turn look finished. The 5K-per-skill / 25K-total reattach budget is the
 * skills package's `DEFAULT_SKILL_BUDGETS` (proven in `packages/skills/src/registry.test.ts`); the
 * real-engine preservation of goal/constraints/tasks/files is `apps/cli/test/integration/compaction.test.ts`.
 */

describe('the compaction preservation contract (CX-05, U)', () => {
  it('accepts a summary that carries the goal and every state list', () => {
    const preserved = {
      goal: 'fix the failing parser test',
      constraints: ['no new dependencies'],
      plan: ['reproduce', 'fix', 'verify'],
      tasks: ['t1 in progress'],
      activeFiles: ['src/parser.ts'],
      decisions: ['use the existing tokenizer'],
      errors: ['TypeError at line 42'],
      obligations: ['run the full test suite before finishing'],
    };
    expect(PreservedContextSchema.safeParse(preserved).success).toBe(true);
  });

  it('preserves goal/state and offers NO field to invent completion', () => {
    // The frozen field set is exactly goal + state — nothing a summarizer could set to fake "done".
    expect([...PRESERVED_FIELDS]).toEqual([
      'goal',
      'constraints',
      'plan',
      'tasks',
      'activeFiles',
      'decisions',
      'errors',
      'obligations',
    ]);
    for (const invented of ['completed', 'done', 'finished', 'success']) {
      expect(PRESERVED_FIELDS as readonly string[]).not.toContain(invented);
    }
  });
});

describe('a summary that drops the goal is rejected — fail-closed (CX-05, F)', () => {
  it('an empty or missing goal is refused: compaction cannot forget why the turn exists', () => {
    const base = {
      constraints: [],
      plan: [],
      tasks: [],
      activeFiles: [],
      decisions: [],
      errors: [],
      obligations: [],
    };
    expect(PreservedContextSchema.safeParse({ ...base, goal: '' }).success).toBe(false);
    expect(PreservedContextSchema.safeParse(base).success).toBe(false);
    // A missing state list is also refused — the shape must be total, not partially dropped.
    expect(
      PreservedContextSchema.safeParse({ goal: 'x', constraints: [], plan: [], tasks: [] }).success,
    ).toBe(false);
  });
});
