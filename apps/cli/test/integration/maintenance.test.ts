import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The `maintenance` CLI surface for the session store (SS-07, integration).
 *
 * Drives the REAL command against a real `.qwen-harness/sessions.sqlite`: an online backup writes a
 * file, vacuum and prune succeed, and malformed invocations fail loudly rather than doing something
 * surprising.
 */

describe('maintenance CLI command (SS-07)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-maint-cli-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  async function run(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      argv,
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    };
    return { code: await main(deps), out, err };
  }

  it('writes an online backup to the given path', async () => {
    const dest = join(cwd, 'snapshot.sqlite');
    const r = await run(['maintenance', 'backup', dest]);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(existsSync(dest)).toBe(true);
  });

  it('runs vacuum and a retention prune, reporting what happened', async () => {
    expect((await run(['maintenance', 'vacuum'])).code).toBe(0);
    const prune = await run(['maintenance', 'prune', '--older-than-days', '30']);
    expect(prune.code).toBe(0);
    expect(prune.out.join('\n')).toMatch(/pruned \d+ session/);
  });

  it('rejects malformed invocations rather than guessing', async () => {
    expect((await run(['maintenance'])).code).toBe(1); // no subcommand
    expect((await run(['maintenance', 'backup'])).code).toBe(1); // no destination
    expect((await run(['maintenance', 'prune', '--older-than-days', '-5'])).code).toBe(1);
  });
});
