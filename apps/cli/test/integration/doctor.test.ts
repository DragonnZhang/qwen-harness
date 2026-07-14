import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type CliDeps } from '../../src/index.ts';

/**
 * `doctor` explains every WINNING config value with its provenance (PS-07).
 *
 * Config provenance follows per-source precedence; `doctor` is where a user (or an agent) reads which
 * source won for each value. This drives the real `main(['doctor'])`: a value set in the project
 * config is reported with that value AND the scope it came from, and the environment/sandbox/config
 * sections are all present. (The provenance ENGINE and the deny-merge across scopes are unit/security
 * tested in `@qwen-harness/config` and `managed-ceiling.test.ts`; this is the doctor read surface.)
 */

describe('doctor explains config provenance (PS-07)', () => {
  let cwd: string;
  let out: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-doctor-'));
    out = [];
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const deps = (argv: string[]): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: (l) => out.push(l),
    stderr: () => {},
  });

  it('reports each winning config value with the scope it came from', async () => {
    // A project-scoped override for `model`; doctor must attribute it to that scope, not "builtin".
    mkdirSync(join(cwd, '.qwen-harness'), { recursive: true });
    writeFileSync(
      join(cwd, '.qwen-harness', 'config.json'),
      JSON.stringify({ model: 'my-custom-model' }),
    );

    await main(deps(['doctor']));
    const text = out.join('\n');

    // The standard sections are present.
    expect(text).toContain('platform:');
    expect(text).toContain('sandbox:');
    expect(text).toContain('config:');
    // The overridden value AND its provenance are shown — not just the value.
    expect(text).toMatch(/model = my-custom-model\s+\(from \w/);
    // A value NOT overridden is attributed to its source (the frozen default endpoint from builtin).
    expect(text).toMatch(/baseUrl = \S+\s+\(from /);
  });

  it('attributes an un-overridden value to builtin (default), not to a scope that never set it', async () => {
    // No config file at all: every value is a builtin default.
    await main(deps(['doctor']));
    expect(out.join('\n')).toMatch(/model = \S+\s+\(from builtin\)/);
  });
});
