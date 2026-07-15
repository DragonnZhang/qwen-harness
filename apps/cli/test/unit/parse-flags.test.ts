import { describe, expect, it } from 'vitest';

import { parseFlags } from '../../src/main.ts';

/**
 * Headless flag parsing (UI-15).
 *
 * The deterministic-automation contract starts here: a machine caller's argv must parse the SAME way
 * every time, and the boolean/value distinction is load-bearing. A boolean flag that greedily swallowed
 * the next token is exactly how `run --json "fix the bug"` once lost its prompt — so the parser must
 * keep `--json`/`--quiet`/`--no-color` from consuming a following positional, while a value flag like
 * `--profile` still takes its argument.
 */

describe('parseFlags — the headless argv contract (UI-15)', () => {
  it('a boolean flag never swallows the following positional', () => {
    // The regression that motivated the boolean set: the prompt must survive after `--json`.
    const { flags, positional } = parseFlags(['--json', 'fix the bug']);
    expect(flags['json']).toBe('true');
    expect(positional).toEqual(['fix the bug']);
  });

  it('every documented boolean flag is boolean, and the prompt after them is intact', () => {
    const { flags, positional } = parseFlags(['--quiet', '--no-color', '--json', 'do it']);
    expect(flags['quiet']).toBe('true');
    expect(flags['no-color']).toBe('true');
    expect(flags['json']).toBe('true');
    expect(positional).toEqual(['do it']);
  });

  it('a value flag consumes exactly the next token', () => {
    const { flags, positional } = parseFlags(['--profile', 'yolo', 'run a shell']);
    expect(flags['profile']).toBe('yolo');
    expect(positional).toEqual(['run a shell']);
  });

  it('the `--key=value` form is unambiguous and does not consume a following token', () => {
    const { flags, positional } = parseFlags(['--model=qwen3.7-max', 'summarize']);
    expect(flags['model']).toBe('qwen3.7-max');
    expect(positional).toEqual(['summarize']);
  });

  it('a value flag with no argument (end of argv, or followed by another flag) becomes a bare true', () => {
    expect(parseFlags(['--model']).flags['model']).toBe('true');
    const { flags } = parseFlags(['--model', '--json']);
    expect(flags['model']).toBe('true');
    expect(flags['json']).toBe('true');
  });

  it('positionals are collected in order and coexist with flags', () => {
    const { flags, positional } = parseFlags(['run', '--profile', 'ask', 'two', 'words']);
    expect(flags['profile']).toBe('ask');
    expect(positional).toEqual(['run', 'two', 'words']);
  });
});
