import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IO_OWNERS, LAYERS, PACKAGE_DEPS, PURE_PACKAGES } from './graph.ts';

/**
 * The architecture is mechanically checked (QL-03).
 *
 * QL-03 claims dependency direction, cycles, forbidden host I/O, package exports, schema
 * compatibility, file-size/complexity guardrails, and docs links are all MECHANICALLY checked. Two
 * halves prove it:
 *
 *   U — the CONTRACT the gate enforces (`scripts/graph.ts`) is itself well-formed: the declared
 *       dependency graph is acyclic and layer-respecting, and the purity/IO declarations are
 *       consistent. A gate is only as trustworthy as the contract behind it.
 *   I — the gate actually RUNS over the real repository, exits clean, and its output names every one
 *       of the checked boundaries — so the claim is verified against the real checker, not asserted.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('the dependency contract is well-formed (QL-03, U)', () => {
  // package -> its layer index, in declared layer order (layer 0 is the most foundational).
  const layerOf = new Map<string, number>();
  Object.values(LAYERS).forEach((packages, index) => {
    for (const pkg of packages) layerOf.set(pkg, index);
  });

  it('every declared dependency is itself a known package', () => {
    for (const [pkg, deps] of Object.entries(PACKAGE_DEPS)) {
      for (const dep of deps) {
        expect(PACKAGE_DEPS[dep as keyof typeof PACKAGE_DEPS], `${pkg} -> ${dep}`).toBeDefined();
      }
    }
  });

  it('dependencies never point UP a layer (direction is enforceable)', () => {
    for (const [pkg, deps] of Object.entries(PACKAGE_DEPS)) {
      const here = layerOf.get(pkg);
      if (here === undefined) continue;
      for (const dep of deps) {
        const there = layerOf.get(dep);
        if (there === undefined) continue;
        expect(
          there,
          `${pkg} (layer ${here}) depends on ${dep} (layer ${there})`,
        ).toBeLessThanOrEqual(here);
      }
    }
  });

  it('the declared dependency graph is acyclic', () => {
    const state = new Map<string, 'open' | 'done'>();
    const stack: string[] = [];
    const visit = (node: string): void => {
      if (state.get(node) === 'done') return;
      if (state.get(node) === 'open') {
        throw new Error(`dependency cycle: ${[...stack, node].join(' -> ')}`);
      }
      state.set(node, 'open');
      stack.push(node);
      for (const dep of PACKAGE_DEPS[node as keyof typeof PACKAGE_DEPS] ?? []) visit(dep);
      stack.pop();
      state.set(node, 'done');
    };
    expect(() => {
      for (const pkg of Object.keys(PACKAGE_DEPS)) visit(pkg);
    }).not.toThrow();
  });

  it('a pure package is never also declared a host-I/O owner', () => {
    for (const pure of PURE_PACKAGES) {
      expect(IO_OWNERS[pure], `${pure} is declared pure but also owns host I/O`).toBeUndefined();
    }
  });
});

describe('the architecture gate runs mechanically over the real repo (QL-03, I)', () => {
  it('the checker passes and reports every checked boundary', () => {
    const tsx = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    let stdout: string;
    let exitCode = 0;
    try {
      stdout = execFileSync(tsx, ['scripts/architecture.ts'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      // execFileSync throws on a non-zero exit; keep the output so a real violation is legible.
      const e = err as { status?: number; stdout?: string };
      exitCode = e.status ?? 1;
      stdout = e.stdout ?? '';
    }

    expect(exitCode, `architecture gate failed:\n${stdout}`).toBe(0);
    expect(stdout).toContain('PASS');

    // Each boundary QL-03 names must appear in the checker's own output — the row is verified against
    // the real checker, not merely believed.
    for (const boundary of [
      'Dependency direction',
      'No cycles',
      'Host I/O only in declared IO_OWNERS',
      'README.md and a src/index.ts', // package exports / entry points
      'File-size/complexity guardrail',
      'Docs links resolve',
    ]) {
      expect(stdout, `gate must check: ${boundary}`).toContain(boundary);
    }
  }, 120_000);

  it('schema compatibility is mechanically checked by a dedicated migrations suite', () => {
    // The "schema compatibility" boundary is enforced by the `migrations` vitest project, not the
    // architecture script — assert that mechanical check is wired into the gate config.
    const config = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("name: 'migrations'");
    expect(existsSync(join(REPO_ROOT, 'packages', 'storage', 'test', 'migrations'))).toBe(true);
  });
});
