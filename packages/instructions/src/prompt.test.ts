import { describe, expect, it } from 'vitest';

import {
  buildStandardSections,
  composeSystemPrompt,
  sectionCacheKey,
  type PromptSection,
  type SystemPromptState,
} from './prompt.ts';

function baseState(): SystemPromptState {
  return {
    identity: { agentName: 'qwen-harness', model: 'qwen3.7-max', profile: 'ask' },
    tools: [{ name: 'read' }, { name: 'edit' }],
    workspace: { cwd: '/repo', repo: '/repo' },
    memory: { digest: 'mem-a', files: 2 },
    session: { threadId: 'thr_000001', turn: 3 },
    mcp: { servers: ['fs'], schemaDigest: 'mcp-a' },
    context: { utilizationPercent: 42, compactions: 0 },
  };
}

describe('composeSystemPrompt', () => {
  it('is deterministic and puts stable sections before dynamic ones', () => {
    const sections = buildStandardSections(baseState());
    const first = composeSystemPrompt(sections);
    const second = composeSystemPrompt(sections);
    expect(first.text).toBe(second.text);
    expect(first.cacheKeys).toEqual(second.cacheKeys);

    const kinds = first.sections.map((s) => s.kind);
    // Every stable section precedes every dynamic one.
    expect(kinds.lastIndexOf('stable')).toBeLessThan(kinds.indexOf('dynamic'));
    // The stable prefix really is a prefix of the full text.
    expect(first.text.startsWith(first.stablePrefix)).toBe(true);
  });

  it('is independent of the order sections are supplied in', () => {
    const sections = buildStandardSections(baseState());
    const shuffled = [...sections].reverse();
    expect(composeSystemPrompt(shuffled).text).toBe(composeSystemPrompt(sections).text);
  });
});

describe('cache boundary (IN-08)', () => {
  it('changing a dynamic input invalidates ONLY that section and leaves the stable prefix intact', () => {
    const before = composeSystemPrompt(buildStandardSections(baseState()));

    // Change one dynamic input: the memory digest.
    const changed = baseState();
    const afterState: SystemPromptState = {
      ...changed,
      memory: { digest: 'mem-B-different', files: 2 },
    };
    const after = composeSystemPrompt(buildStandardSections(afterState));

    // The memory section's key changed...
    expect(after.cacheKeys['memory']).not.toBe(before.cacheKeys['memory']);
    // ...and NO other section's key changed.
    for (const id of Object.keys(before.cacheKeys)) {
      if (id === 'memory') continue;
      expect(after.cacheKeys[id]).toBe(before.cacheKeys[id]);
    }
    // The cacheable stable prefix is byte-identical.
    expect(after.stablePrefix).toBe(before.stablePrefix);
  });

  it('changing a stable input invalidates its stable section and moves the prefix', () => {
    const before = composeSystemPrompt(buildStandardSections(baseState()));
    const afterState: SystemPromptState = {
      ...baseState(),
      identity: { agentName: 'qwen-harness', model: 'qwen3.7-max', profile: 'yolo' },
    };
    const after = composeSystemPrompt(buildStandardSections(afterState));
    expect(after.cacheKeys['identity']).not.toBe(before.cacheKeys['identity']);
    expect(after.stablePrefix).not.toBe(before.stablePrefix);
    // Dynamic sections are untouched.
    expect(after.cacheKeys['session']).toBe(before.cacheKeys['session']);
  });
});

describe('sectionCacheKey', () => {
  it('is stable across input key order', () => {
    const a: PromptSection = {
      id: 'x',
      kind: 'dynamic',
      content: 'hello',
      cacheKeyInputs: { a: 1, b: 'two' },
    };
    const b: PromptSection = { ...a, cacheKeyInputs: { b: 'two', a: 1 } };
    expect(sectionCacheKey(a)).toBe(sectionCacheKey(b));
  });
});
