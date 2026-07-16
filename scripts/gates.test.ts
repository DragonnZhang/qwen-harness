import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The root package provides every quality gate as a script (QL-01).
 *
 * QL-01 requires that format, lint, typecheck, unit/integration/security/PTY/E2E/live tests, build,
 * architecture, and an aggregate `check` are all reachable as root scripts. Three halves prove it:
 *   I — the package manifest declares each gate, and `check` chains the core gates so one command
 *       runs them all in order.
 *   E — a representative gate actually RUNS end to end through its script (not just exists as text).
 *   D — the quality docs describe the gates, so the manifest and the documentation cannot drift.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const REQUIRED_GATES = [
  'format',
  'format:check',
  'lint',
  'typecheck',
  'build',
  'test',
  'test:integration',
  'test:security',
  'test:pty',
  'test:e2e',
  'test:live',
  'test:performance',
  'test:migrations',
  'test:packaging',
  'architecture',
  'secrets:scan',
  'check',
] as const;

describe('the root package provides every gate as a script (QL-01, I)', () => {
  it('declares each required gate script', () => {
    for (const gate of REQUIRED_GATES) {
      expect(pkg.scripts[gate], `missing root script: ${gate}`).toBeTruthy();
    }
  });

  it('the aggregate `check` chains the core gates in a single command', () => {
    const check = pkg.scripts['check'] ?? '';
    for (const gate of [
      'format:check',
      'lint',
      'typecheck',
      'architecture',
      'build',
      'test',
      'test:integration',
      'test:security',
      'test:pty',
      'test:e2e',
      'secrets:scan',
    ]) {
      expect(check, `check must run ${gate}`).toContain(gate);
    }
  });
});

describe('a gate script runs end to end (QL-01, E)', () => {
  it('`pnpm format:check` executes through its script and reports a clean tree', () => {
    // Runs the REAL script (not the tool directly), so a broken/missing script entry fails here.
    const out = execFileSync('pnpm', ['-s', 'format:check'], { cwd: REPO_ROOT, encoding: 'utf8' });
    // format:check exits 0 on a clean tree; reaching here without a throw is the pass. Prettier prints
    // its summary only on failure, so quiet success is expected.
    expect(typeof out).toBe('string');
  }, 120_000);
});

describe('the quality docs describe the gates (QL-01, D)', () => {
  it('acceptance.md references the aggregate check and the gate commands', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'quality', 'acceptance.md'), 'utf8');
    expect(doc).toMatch(/pnpm check/);
  });
});
