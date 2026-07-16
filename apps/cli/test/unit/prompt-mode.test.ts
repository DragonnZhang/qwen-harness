import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROMPT_MODE_TABLE } from '@qwen-harness/instructions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composePrompt, loadGuidance, type PromptInputs } from '../../src/instructions.ts';

/**
 * The prompt-mode section is wired into the composed system prompt (IN-09, U).
 *
 * A non-`default` mode contributes exactly its frozen prompt delta, and it lands in the STABLE cache
 * prefix (a mode changes only when a user changes it). `default` — and an omitted mode — add nothing,
 * so the wiring is strictly additive and the prior prompt is unchanged.
 */

describe('composePrompt applies the prompt mode (IN-09, U)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-mode-u-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = (): Omit<PromptInputs, 'mode'> => ({
    agentName: 'qwen-harness',
    model: 'qwen3.7-max',
    profile: 'ask',
    workspaceRoot: dir,
    repo: dir,
    toolNames: ['read_file', 'grep'],
    threadId: 'thr_1',
    turn: 1,
    memory: null,
    mcp: null,
    context: { utilizationPercent: 0, compactions: 0 },
  });

  it('coordinator adds its frozen delta to the stable prefix', () => {
    const guidance = loadGuidance({ workspaceRoot: dir, homeDir: dir });
    const out = composePrompt(guidance, { ...base(), mode: 'coordinator' });
    const delta = PROMPT_MODE_TABLE.coordinator.promptDelta;
    expect(out.composed.text).toContain(delta);
    // The mode section is STABLE — it belongs to the cacheable prefix, not the per-turn tail.
    expect(out.composed.stablePrefix).toContain(delta);
  });

  it('default and an omitted mode add no mode section', () => {
    const guidance = loadGuidance({ workspaceRoot: dir, homeDir: dir });
    const coordinatorDelta = PROMPT_MODE_TABLE.coordinator.promptDelta;
    for (const inputs of [base(), { ...base(), mode: 'default' as const }]) {
      const out = composePrompt(guidance, inputs);
      expect(out.composed.text).not.toContain(coordinatorDelta);
      expect(out.composed.text).not.toContain('Mode: coordinator');
    }
  });
});
