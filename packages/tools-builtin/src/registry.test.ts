import { HarnessError, type PermissionProfile } from '@qwen-harness/protocol';
import { ToolAnnotationsSchema, ToolRegistry } from '@qwen-harness/tools-core';
import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS, registerBuiltins } from './index.ts';

/**
 * TL-01 — the registry binds tools to their EXECUTION CONTRACT.
 *
 * This is a focused unit test of the real `ToolRegistry` driven by the real builtin definitions
 * (`registerBuiltins`/`BUILTIN_TOOLS`) — no mocks. It proves, at the unit level: registration makes
 * a tool retrievable by name; a retrieved tool still carries the full declared contract (name,
 * description, schemas, the concurrency/side-effect annotations, the timeout bound, and the
 * per-profile availability); a duplicate registration is rejected deterministically; an unknown
 * name is not found; and `plan` is never even OFFERED a mutating tool (PS-02).
 *
 * It lives in `tools-builtin` rather than `tools-core` on purpose: `tools-core` is a foundation
 * layer and cannot depend on `tools-builtin` (that edge would be a graph cycle), so the only place
 * a test can drive BOTH the real registry AND the real builtins is here.
 */

function freshRegistry(): ToolRegistry {
  return registerBuiltins(new ToolRegistry());
}

describe('ToolRegistry binds builtins to their contract (TL-01)', () => {
  it('registers every builtin and makes each retrievable by its declared name', () => {
    const registry = freshRegistry();

    expect(BUILTIN_TOOLS.length).toBeGreaterThan(0);
    for (const tool of BUILTIN_TOOLS) {
      // Identity, not just presence: `get(name)` returns the very object that was registered.
      expect(registry.get(tool.name)).toBe(tool);
    }

    // `names` is the sorted set of registered names — the model's tool list is derived from this.
    const expected = [...BUILTIN_TOOLS.map((t) => t.name)].sort();
    expect(registry.names).toEqual(expected);
    // Names are unique — no two builtins collide.
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('a retrieved tool carries its full execution contract (metadata, not a stub)', () => {
    const registry = freshRegistry();

    const read = registry.get('read_file');
    expect(read).toBeDefined();
    if (read === undefined) throw new Error('unreachable');

    // Identity + human description.
    expect(read.name).toBe('read_file');
    expect(read.description.length).toBeGreaterThan(0);

    // Schemas are real zod schemas that actually parse/reject — the model's I/O contract.
    expect(read.inputSchema.safeParse({ path: 'a.ts' }).success).toBe(true);
    expect(read.inputSchema.safeParse({ path: '/abs.ts' }).success).toBe(false);
    expect(read.outputSchema).toBeDefined();

    // Side-effect / concurrency annotations — the scheduler and policy act on THESE.
    expect(ToolAnnotationsSchema.safeParse(read.annotations).success).toBe(true);
    expect(read.annotations.readOnly).toBe(true);
    expect(read.annotations.destructive).toBe(false);

    // The timeout bound (a tool that overruns is cancelled, never left hanging).
    expect(typeof read.timeoutMs).toBe('number');
    expect(read.timeoutMs).toBeGreaterThan(0);

    // Per-profile availability — reads are offered everywhere, including `plan`.
    expect(read.availableIn).toContain('plan');

    // The argument-derived footprint: a read touches its path as a READ and is bounded.
    const fp = read.footprint({ path: 'src/x.ts', offsetLine: 0, limitLines: 10 });
    expect(fp.reads).toEqual(['src/x.ts']);
    expect(fp.writes).toEqual([]);
    expect(fp.unbounded).toBe(false);

    // A fully-specified, human-readable effect description (approval binds to this).
    expect(read.describe({ path: 'src/x.ts', offsetLine: 0, limitLines: 10 })).toContain(
      'src/x.ts',
    );
  });

  it('a mutating tool declares the destructive/unbounded metadata the scheduler needs', () => {
    const registry = freshRegistry();

    const write = registry.get('write_file');
    expect(write?.annotations.readOnly).toBe(false);
    expect(write?.annotations.destructive).toBe(true);

    // A shell command has an UNKNOWABLE footprint, so it declares itself unbounded — the scheduler
    // then never runs it beside anything else (TL-08).
    const shell = registry.get('run_shell');
    expect(shell?.footprint({ command: 'ls', argv: [], cwd: '.' }).unbounded).toBe(true);
    expect(shell?.annotations.openWorld).toBe(true);
  });

  it('rejects a duplicate registration deterministically, leaving the first binding intact', () => {
    const registry = freshRegistry();
    const original = registry.get('read_file');
    const dup = { ...original, description: 'an impostor' } as unknown as Parameters<
      ToolRegistry['register']
    >[0];

    let thrown: unknown;
    try {
      registry.register(dup);
    } catch (e) {
      thrown = e;
    }

    // It THROWS (does not silently overwrite), and it throws the structured harness error.
    expect(thrown).toBeInstanceOf(HarnessError);
    expect((thrown as HarnessError).category).toBe('tools.duplicate_name');

    // The original binding is untouched — the impostor never replaced it.
    expect(registry.get('read_file')).toBe(original);
  });

  it('does not find an unknown tool name', () => {
    const registry = freshRegistry();
    expect(registry.get('no_such_tool')).toBeUndefined();
    expect(registry.names).not.toContain('no_such_tool');
  });

  it('hides mutating tools from the plan profile but offers them under yolo (PS-02)', () => {
    const registry = freshRegistry();

    const planNames = registry.availableFor('plan').map((t) => t.name);
    // `plan` may read/search…
    expect(planNames).toContain('read_file');
    expect(planNames).toContain('search');
    // …but is never even OFFERED a mutation — absence from the list, not a late denial.
    expect(planNames).not.toContain('write_file');
    expect(planNames).not.toContain('edit_file');
    expect(planNames).not.toContain('run_shell');

    const yoloNames = registry.availableFor('yolo').map((t) => t.name);
    expect(yoloNames).toContain('write_file');
    expect(yoloNames).toContain('run_shell');

    // Sanity: every returned tool genuinely lists the profile it was returned for.
    const profile: PermissionProfile = 'plan';
    for (const tool of registry.availableFor(profile)) {
      expect(tool.availableIn).toContain(profile);
    }
  });
});
