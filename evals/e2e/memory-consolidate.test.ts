import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * MM-04 (E) — memory consolidation, end to end through the REAL CLI.
 *
 * Two memory files share the same `name` (a conflict) — the store reads the frontmatter name, not the
 * filename, so both load. `memory consolidate` runs the real consolidation engine (dedup + conflict
 * resolution, newer wins) and deletes the superseded file. This exercises the trigger the consolidation
 * engine previously lacked: the mechanical pass was implemented and unit-tested but never reachable
 * from a command. No model is involved (mechanical consolidation is deterministic).
 */

const frontmatter = (body: string): string =>
  `---\nname: code-style\ndescription: the code style for this repo\ntype: project\n---\n${body}\n`;

describe('memory consolidation end to end (MM-04)', () => {
  let cwd: string;
  let out: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-consolidate-'));
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

  it('resolves a same-name conflict, keeping the newer memory and deleting the loser', async () => {
    const memDir = join(cwd, '.qwen-harness', 'memory');
    mkdirSync(memDir, { recursive: true });
    const older = join(memDir, 'style-old.md');
    const newer = join(memDir, 'style-new.md');
    writeFileSync(older, frontmatter('use tabs'));
    writeFileSync(newer, frontmatter('use two spaces'));
    // Make `style-new` unambiguously newer so "newer wins" is deterministic.
    utimesSync(older, new Date(1_000), new Date(1_000));
    utimesSync(newer, new Date(2_000), new Date(2_000));

    // Consolidate: one conflict resolved, one superseded file removed.
    expect(await main(deps(['memory', 'consolidate']))).toBe(0);
    const report = out.join('\n');
    expect(report).toMatch(/1 conflict\(s\) resolved/);
    expect(report).toMatch(/1 file\(s\) removed/);

    // The newer memory survives on disk; the older one is gone.
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(older)).toBe(false);

    // And the store now lists exactly one `code-style` memory.
    out.length = 0;
    expect(await main(deps(['memory', 'list', '--json']))).toBe(0);
    const listed = JSON.parse(out.at(-1)!) as { memories: { name: string }[] };
    expect(listed.memories.filter((m) => m.name === 'code-style')).toHaveLength(1);
  });
});
