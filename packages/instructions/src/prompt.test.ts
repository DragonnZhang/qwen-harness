import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildStandardSections,
  composeSystemPrompt,
  sectionCacheKey,
  STABLE_SECTION_IDS,
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

/**
 * A per-section prompt cache keyed by the REAL `sectionCacheKey`. This is the consumer the cache
 * keys exist for: a downstream prompt cache serves a section's rendered content only while its key
 * is unchanged, and must rebuild the moment the key moves. Driving the real key function here is
 * what makes the invalidation assertions non-vacuous — a key that failed to move on an injected
 * state change would serve the STALE content and fail these tests.
 */
class SectionPromptCache {
  readonly #entries = new Map<string, { key: string; content: string }>();
  #rebuilds = 0;

  /** How many times a section had to be (re)built rather than served from cache. */
  get rebuilds(): number {
    return this.#rebuilds;
  }

  /** Serve the cached content iff the section's current key matches; otherwise rebuild and store. */
  render(section: PromptSection): string {
    const key = sectionCacheKey(section);
    const hit = this.#entries.get(section.id);
    if (hit !== undefined && hit.key === key) return hit.content;
    this.#rebuilds += 1;
    this.#entries.set(section.id, { key, content: section.content });
    return section.content;
  }
}

function memorySection(state: SystemPromptState): PromptSection {
  const section = buildStandardSections(state).find((s) => s.id === 'memory');
  if (section === undefined) throw new Error('memory section missing');
  return section;
}

describe('cache invalidation and failure recovery (IN-08, F)', () => {
  it('an injected state change invalidates ONLY that section; the stale entry is never served', () => {
    const cache = new SectionPromptCache();
    const base = buildStandardSections(baseState());
    // Turn 1: prime the cache with every section (one build each).
    for (const section of base) cache.render(section);
    expect(cache.rebuilds).toBe(base.length);
    const baseContent = new Map(base.map((s) => [s.id, s.content]));

    // Inject a change to the memory backing state ONLY — its digest flips.
    const changedState: SystemPromptState = {
      ...baseState(),
      memory: { digest: 'mem-CHANGED', files: 2 },
    };
    const changed = buildStandardSections(changedState);

    const before = cache.rebuilds;
    const served: Record<string, string> = {};
    for (const section of changed) served[section.id] = cache.render(section);

    // Exactly ONE rebuild — the memory section. Every other section was a cache HIT.
    expect(cache.rebuilds - before).toBe(1);
    // The served memory content reflects the NEW state, never the stale 'mem-a' digest. If
    // invalidation had failed (the key not incorporating the digest), the cache would have served
    // the stale entry and this pair of assertions would fail.
    expect(served['memory']).toContain('mem-CHANGED');
    expect(served['memory']).not.toContain('mem-a');
    // The cacheable stable prefix sections were served byte-identically from cache.
    for (const id of STABLE_SECTION_IDS) expect(served[id]).toBe(baseContent.get(id));
  });

  it('does not serve a stale cache entry after the underlying state is corrected', () => {
    const cache = new SectionPromptCache();
    // Prime the cache with a BAD memory digest — the injected failure: the memory store returned the
    // wrong value and it was cached.
    const badState: SystemPromptState = {
      ...baseState(),
      memory: { digest: 'BAD-digest', files: 0 },
    };
    for (const section of buildStandardSections(badState)) cache.render(section);
    expect(cache.render(memorySection(badState))).toContain('BAD-digest');

    // Recovery: the memory store is corrected. The section's key moves, so the cache MISSES the bad
    // entry and rebuilds the corrected content — the stale 'BAD-digest' is never served again.
    const fixedState: SystemPromptState = {
      ...baseState(),
      memory: { digest: 'good-digest', files: 3 },
    };
    const served = cache.render(memorySection(fixedState));
    expect(served).toContain('good-digest');
    expect(served).not.toContain('BAD-digest');
  });

  it('refuses to compose a corrupt section (typed error) and still composes the ones that succeeded', () => {
    const good = buildStandardSections(baseState());
    // Inject a failed section build: an id that violates the schema (>64 chars). It is a valid
    // PromptSection *type*, so only the runtime guard in `composeSystemPrompt` can reject it — which
    // proves the composer validates its inputs rather than trusting them.
    const corrupt: PromptSection = {
      id: 'x'.repeat(80),
      kind: 'dynamic',
      content: 'poison',
      cacheKeyInputs: {},
    };

    // Fail-closed: the composer surfaces a typed ZodError rather than emitting a prompt that contains
    // the corrupt section. A corrupt input never becomes a served prompt.
    expect(() => composeSystemPrompt([...good, corrupt])).toThrow(z.ZodError);

    // Degrade + recover: dropping the failed section composes cleanly from the sections that
    // succeeded, and the poison content never reaches the output.
    const recovered = composeSystemPrompt(good);
    expect(recovered.text).not.toContain('poison');
    expect(Object.keys(recovered.cacheKeys)).toHaveLength(good.length);
  });
});
