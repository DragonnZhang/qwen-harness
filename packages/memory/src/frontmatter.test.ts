import { describe, expect, it } from 'vitest';

import {
  MEMORY_TYPES,
  MemoryFormatError,
  parseMemory,
  serializeMemory,
  type Memory,
  type MemoryType,
} from './frontmatter.ts';

/**
 * The memory document format (MM-01): validated YAML frontmatter over a Markdown body, with a typed
 * error that names the offending file.
 */
describe('memory frontmatter (MM-01)', () => {
  const sample = (type: MemoryType): Memory => ({
    name: 'prefers-pnpm',
    description: 'The user builds and tests with pnpm, never npm.',
    type,
    body: 'Always run `pnpm install` and `pnpm test`.\nNever commit an npm lockfile.',
  });

  it.each(MEMORY_TYPES)('round-trips a %s memory through serialize/parse', (type) => {
    const memory = sample(type);
    const text = serializeMemory(memory);
    const parsed = parseMemory(text, `${type}.md`);
    expect(parsed).toEqual(memory);
  });

  it('parses all four frozen types', () => {
    for (const type of MEMORY_TYPES) {
      const parsed = parseMemory(serializeMemory(sample(type)));
      expect(parsed.type).toBe(type);
    }
    expect([...MEMORY_TYPES]).toEqual(['user', 'feedback', 'project', 'reference']);
  });

  it('handles quoting of values with colons and hashes', () => {
    const memory: Memory = {
      name: 'url-note',
      description: 'Use https://example.com: it is the canonical host # of record',
      type: 'reference',
      body: 'body',
    };
    const parsed = parseMemory(serializeMemory(memory));
    expect(parsed.description).toBe(memory.description);
  });

  it('names the file when the closing fence is missing', () => {
    const bad = '---\nname: x\ndescription: y\ntype: user\n';
    expect(() => parseMemory(bad, 'broken.md')).toThrow(MemoryFormatError);
    try {
      parseMemory(bad, 'broken.md');
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryFormatError);
      expect((err as MemoryFormatError).file).toBe('broken.md');
      expect((err as Error).message).toContain('broken.md');
    }
  });

  it('names the file when a frontmatter value fails the schema', () => {
    const bad = '---\nname: Not A Slug\ndescription: d\ntype: user\n---\nbody';
    try {
      parseMemory(bad, 'nameerr.md');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryFormatError);
      expect((err as MemoryFormatError).file).toBe('nameerr.md');
    }
  });

  it('rejects an unknown memory type, naming the file', () => {
    const bad = '---\nname: x\ndescription: d\ntype: wisdom\n---\nbody';
    expect(() => parseMemory(bad, 'typeerr.md')).toThrow(/typeerr\.md/);
  });

  it('rejects an unknown frontmatter key (strict object)', () => {
    const bad = '---\nname: x\ndescription: d\ntype: user\npriority: high\n---\nbody';
    expect(() => parseMemory(bad, 'extra.md')).toThrow(MemoryFormatError);
  });

  it('rejects a duplicate frontmatter key', () => {
    const bad = '---\nname: x\nname: y\ndescription: d\ntype: user\n---\nbody';
    expect(() => parseMemory(bad, 'dup.md')).toThrow(/duplicate/);
  });

  it('rejects a document with no frontmatter fence', () => {
    expect(() => parseMemory('just a body', 'nofence.md')).toThrow(/missing YAML frontmatter/);
  });

  it('rejects a path-traversing name at the schema boundary', () => {
    const bad = '---\nname: "../escape"\ndescription: d\ntype: user\n---\nbody';
    expect(() => parseMemory(bad, 'evil.md')).toThrow(MemoryFormatError);
  });
});
