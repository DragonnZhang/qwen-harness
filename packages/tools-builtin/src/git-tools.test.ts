import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS } from './tools.ts';

/**
 * Git tooling is read-safe by construction (TL-06, U).
 *
 * The built-in git surface is exactly `git_status` and `git_diff` — both resolve to a `git-read`
 * action and declare no writes. There is deliberately NO built-in tool that commits, resets,
 * force-pushes, or rewrites history, so the tooling can never discard work; a destructive git
 * operation is only reachable through `run_shell`, which is itself gated by policy/approval (TL-05).
 */

const ctx = { workspaceRoot: '/repo' } as never;

const gitTools = BUILTIN_TOOLS.filter((t) => t.name.startsWith('git_'));

describe('git tooling is read-safe (TL-06)', () => {
  it('the built-in git surface is exactly the two read-only tools', () => {
    expect(gitTools.map((t) => t.name).sort()).toEqual(['git_diff', 'git_status']);
  });

  for (const tool of gitTools) {
    it(`${tool.name} resolves to a git-read action and writes nothing`, () => {
      const input = tool.inputSchema.parse({ path: '.' }) as never;
      const action = tool.toAction(input, ctx);
      expect(action.kind).toBe('git-read');
      expect(tool.footprint(input).writes).toEqual([]);
    });
  }

  it('no built-in git tool declares a write footprint — nothing here mutates a repository', () => {
    for (const tool of gitTools) {
      const input = tool.inputSchema.parse({ path: '.' }) as never;
      expect(tool.footprint(input).writes, `${tool.name} must not write`).toEqual([]);
    }
  });
});
