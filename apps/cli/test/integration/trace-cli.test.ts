import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type CliDeps } from '../../src/index.ts';

/**
 * OB-02 — the local trace is READABLE via the CLI, for humans (`trace`) and implementing agents
 * (`trace --json`). The opt-in/retention CONTROLS are unit-tested (`test/unit/telemetry.test.ts`);
 * this covers the READ path: the `trace` command finds the JSONL trace, prints it human-readably and
 * as one-JSON-record-per-line, warns (never swallows) a corrupt line, and — when telemetry was never
 * enabled — tells the user exactly how to turn it on rather than failing.
 */

const RECORDS = [
  {
    ts: 1_700_000_000_000,
    level: 'info',
    category: 'model.request',
    message: 'model request',
    fields: { model: 'qwen3.7-max', requestId: 'req_abc' },
  },
  {
    ts: 1_700_000_000_500,
    level: 'debug',
    category: 'tool.execute',
    message: 'ran read_file',
    fields: { ok: true, durationMs: 5 },
  },
];

describe('trace CLI read (OB-02)', () => {
  let cwd: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-trace-'));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function deps(argv: string[]): CliDeps {
    return {
      argv,
      env: process.env,
      cwd,
      now: () => 1_700_000_100_000,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    };
  }

  function writeTrace(lines: string[]): void {
    const dir = join(cwd, '.qwen-harness', 'trace');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trace-2026-07-13.jsonl'), lines.join('\n') + '\n');
  }

  it('prints the trace human-readably (timestamp, level, category, message, fields)', async () => {
    writeTrace(RECORDS.map((r) => JSON.stringify(r)));
    const code = await main(deps(['trace']));
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('model.request');
    expect(text).toContain('model request');
    expect(text).toContain('tool.execute');
    expect(text).toContain('model=qwen3.7-max');
  });

  it('prints one JSON record per line under --json (agent-readable)', async () => {
    writeTrace(RECORDS.map((r) => JSON.stringify(r)));
    const code = await main(deps(['trace', '--json']));
    expect(code).toBe(0);
    const parsed = out.map((l) => JSON.parse(l) as (typeof RECORDS)[number]);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((r) => r.message)).toEqual(['model request', 'ran read_file']);
    expect(parsed[0]?.fields.requestId).toBe('req_abc');
  });

  it('warns about a corrupt line but still prints the valid records', async () => {
    writeTrace([JSON.stringify(RECORDS[0]), 'this is not json', JSON.stringify(RECORDS[1])]);
    const code = await main(deps(['trace']));
    expect(code).toBe(0);
    expect(err.join('\n')).toMatch(/unparseable/i);
    expect(out.join('\n')).toContain('ran read_file');
  });

  it('when telemetry was never enabled, explains how to opt in instead of failing', async () => {
    const code = await main(deps(['trace']));
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/telemetry\.enabled/);
  });
});
