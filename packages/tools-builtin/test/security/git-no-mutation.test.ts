import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS } from '../../src/tools.ts';

/**
 * The built-in git surface cannot discard, reset, force-push, or rewrite history (TL-06, S).
 *
 * The adversarial guarantee is by ABSENCE: a model — however it is prompted — has no built-in tool
 * that mutates a repository. The only git tools are read-only `git_status`/`git_diff`; there is no
 * `git_commit`/`git_reset`/`git_push`/`git_clean`, so history cannot be rewritten and work cannot be
 * discarded through the tool surface. (A destructive `git` via `run_shell` is a separate, policy/
 * approval-gated path — TL-05.)
 */

const ctx = { workspaceRoot: '/repo' } as never;

describe('the built-in git surface exposes no destructive operation (TL-06, S)', () => {
  it('there is no tool that could discard, reset, force-push, or rewrite history', () => {
    const names = new Set(BUILTIN_TOOLS.map((t) => t.name));
    for (const forbidden of [
      'git_commit',
      'git_reset',
      'git_push',
      'git_rebase',
      'git_checkout',
      'git_clean',
      'git_restore',
      'git_merge',
      'git_stash',
    ]) {
      expect(names.has(forbidden), `no destructive git tool must exist: ${forbidden}`).toBe(false);
    }
    // The entire git surface is exactly the two read-only tools.
    expect([...names].filter((n) => n.startsWith('git_')).sort()).toEqual([
      'git_diff',
      'git_status',
    ]);
  });

  it('every git tool resolves to a git-READ action — never a write', () => {
    for (const tool of BUILTIN_TOOLS.filter((t) => t.name.startsWith('git_'))) {
      const action = tool.toAction(tool.inputSchema.parse({ path: '.' }) as never, ctx);
      expect(action.kind, `${tool.name} must be read-only`).toBe('git-read');
    }
  });
});
