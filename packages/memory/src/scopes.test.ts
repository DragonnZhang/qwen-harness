import { describe, expect, it } from 'vitest';

import {
  canonicalRepoKey,
  isPersistentScope,
  MEMORY_SCOPES,
  MemoryScopeError,
  resolveMemoryDir,
} from './scopes.ts';

/** The scope model (MM-05): five distinct scopes, XDG-respecting, auto keyed by canonical repo. */
describe('memory scopes (MM-05)', () => {
  const base = {
    projectRoot: '/repo',
    homeDir: '/home/dev',
    env: {} as Record<string, string | undefined>,
  };

  it('lists the five frozen scopes', () => {
    expect([...MEMORY_SCOPES]).toEqual(['project', 'team', 'user', 'auto', 'session']);
  });

  it('session memory has no directory (survives compaction only)', () => {
    expect(resolveMemoryDir('session', base)).toBeNull();
    expect(isPersistentScope('session')).toBe(false);
  });

  it('project and team memory live in distinct in-repo trees', () => {
    expect(resolveMemoryDir('project', base)).toBe('/repo/.qwen-harness/memory');
    expect(resolveMemoryDir('team', base)).toBe('/repo/.qwen-harness/team-memory');
  });

  it('user memory respects XDG_DATA_HOME, falling back to ~/.local/share', () => {
    expect(resolveMemoryDir('user', base)).toBe('/home/dev/.local/share/qwen-harness/memory');
    expect(resolveMemoryDir('user', { ...base, env: { XDG_DATA_HOME: '/xdg/data' } })).toBe(
      '/xdg/data/qwen-harness/memory',
    );
  });

  it('ignores a relative XDG value (as config does)', () => {
    expect(resolveMemoryDir('user', { ...base, env: { XDG_DATA_HOME: 'relative/path' } })).toBe(
      '/home/dev/.local/share/qwen-harness/memory',
    );
  });

  it('auto memory is machine-local under XDG_STATE_HOME and keyed by canonical repo', () => {
    const dir = resolveMemoryDir('auto', {
      ...base,
      canonicalRepoRoot: '/canonical/repo',
      env: { XDG_STATE_HOME: '/xdg/state' },
    });
    expect(dir).toBe(`/xdg/state/qwen-harness/auto/${canonicalRepoKey('/canonical/repo')}`);
  });

  it('all worktrees of one canonical repo share ONE auto store', () => {
    // Two different worktree projectRoots, same canonicalRepoRoot -> same auto dir.
    const worktreeA = resolveMemoryDir('auto', {
      ...base,
      projectRoot: '/repo/worktrees/feature-a',
      canonicalRepoRoot: '/repo',
    });
    const worktreeB = resolveMemoryDir('auto', {
      ...base,
      projectRoot: '/repo/worktrees/feature-b',
      canonicalRepoRoot: '/repo',
    });
    expect(worktreeA).toBe(worktreeB);
  });

  it('different canonical repos get different auto stores', () => {
    expect(canonicalRepoKey('/repo/one')).not.toBe(canonicalRepoKey('/repo/two'));
  });

  it('throws a typed error when a durable scope lacks its required input', () => {
    expect(() => resolveMemoryDir('project', { homeDir: '/home/dev' })).toThrow(MemoryScopeError);
    expect(() => resolveMemoryDir('user', { projectRoot: '/repo' })).toThrow(MemoryScopeError);
    expect(() => resolveMemoryDir('auto', { homeDir: '/home/dev' })).toThrow(MemoryScopeError);
  });
});
