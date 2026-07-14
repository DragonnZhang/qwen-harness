/**
 * UI-04 (U + S) — the slash-command REGISTRY: exact lookup, prefix completion, and the security
 * property that injected text after `/` can never resolve to (and therefore never execute) a command.
 *
 * These assertions exercise the pure registry directly. The compiled-bundle proof that the menu
 * RENDERS, FILTERS, and EXECUTES over a real PTY lives in `test/pty/slash-commands.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { PermissionProfile, SafeText } from '@qwen-harness/protocol';

import {
  commandQuery,
  isCommandLine,
  listCommands,
  lookupCommand,
  matchCommands,
  type CommandContext,
} from '../../src/commands.ts';

/** A recording context so a command's REAL effect (which callback it drives) is observable. */
function recordingContext(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  cycleMode: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  notices: string[][];
} {
  const cycleMode = vi.fn();
  const exit = vi.fn();
  const notices: string[][] = [];
  const ctx: CommandContext = {
    mode: 'ask' as PermissionProfile,
    model: 'qwen3.7-max' as SafeText,
    cwd: '/work' as SafeText,
    activity: 'idle',
    cycleMode,
    exit,
    notice: (lines) => notices.push([...lines]),
    ...overrides,
  };
  return { ctx, cycleMode, exit, notices };
}

/**
 * True if the string contains any C0 control byte (or DEL). Computed from code points so no raw
 * control byte — and no `no-control-regex` lint suppression — is needed anywhere in this source.
 */
function hasControlByte(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

describe('slash-command registry (UI-04)', () => {
  it('lists a complete, sanitized, unique set of commands', () => {
    const commands = listCommands();
    expect(commands.length).toBeGreaterThanOrEqual(5);

    const names = commands.map((c) => c.name);
    // Names are unique.
    expect(new Set(names).size).toBe(names.length);
    for (const command of commands) {
      // Names are inert chrome: lowercase letters/dashes only, no slash, no control bytes, no spaces.
      expect(command.name).toMatch(/^[a-z][a-z-]*$/);
      // Every command has a real, human description, free of control bytes.
      expect(command.description.length).toBeGreaterThan(0);
      expect(hasControlByte(command.name)).toBe(false);
      expect(hasControlByte(command.description)).toBe(false);
    }
    // The documented core set is present.
    expect(names).toEqual(expect.arrayContaining(['help', 'mode', 'model', 'status', 'quit']));
  });

  it('resolves an EXACT command name (the lookup used to execute)', () => {
    const mode = lookupCommand('mode');
    expect(mode?.name).toBe('mode');
    expect(lookupCommand('help')?.name).toBe('help');
  });

  it('SECURITY: injected/arbitrary text after `/` resolves to nothing and cannot execute', () => {
    // None of these are registered — lookup must return undefined so there is nothing to run.
    for (const injected of [
      'notacommand',
      'help; rm -rf /',
      '../etc/passwd',
      'HELP',
      'mod',
      'model ',
      '',
    ]) {
      expect(lookupCommand(injected)).toBeUndefined();
    }
    // The menu also offers nothing to select for a non-command token: no object, no execution path.
    expect(matchCommands('notacommand')).toEqual([]);
    expect(matchCommands('zzz')).toEqual([]);
  });

  it('prefix-filters the completion menu for a partial like `/mo`', () => {
    const q = commandQuery('/mo');
    expect(q).toBe('mo');
    const matched = matchCommands(q).map((c) => c.name);
    // Both `mode` and `model` begin with `mo`; nothing else does.
    expect(matched).toEqual(expect.arrayContaining(['mode', 'model']));
    expect(matched).not.toContain('help');
    // `mode` is itself a prefix of `model`, so it still matches both (in registry order).
    expect(
      matchCommands('mode')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['mode', 'model']);
    // ...while a token no other name extends narrows to exactly one.
    expect(matchCommands('model').map((c) => c.name)).toEqual(['model']);
    expect(matchCommands('stat').map((c) => c.name)).toEqual(['status']);
    // Just `/` lists everything.
    expect(matchCommands(commandQuery('/'))).toEqual(listCommands());
  });

  it('classifies command lines and extracts the token before the first space', () => {
    expect(isCommandLine('/help')).toBe(true);
    expect(isCommandLine('/')).toBe(true);
    expect(isCommandLine('hello')).toBe(false);
    // A multi-line buffer is not a command line (a `/` mid-paste is ordinary text).
    expect(isCommandLine('/help\nmore')).toBe(false);
    expect(commandQuery('/help me please')).toBe('help');
    expect(commandQuery('not a command')).toBe('');
  });

  it('runs REAL effects: /mode cycles, /quit exits, /help and /status print real state', () => {
    const help = lookupCommand('help');
    const mode = lookupCommand('mode');
    const model = lookupCommand('model');
    const status = lookupCommand('status');
    const quit = lookupCommand('quit');
    expect([help, mode, model, status, quit].every((c) => c !== undefined)).toBe(true);

    // /mode drives the SAME cycleMode callback Shift+Tab uses — not a stub.
    const m = recordingContext();
    mode?.run(m.ctx);
    expect(m.cycleMode).toHaveBeenCalledTimes(1);
    expect(m.exit).not.toHaveBeenCalled();

    // /quit drives the real exit callback.
    const q = recordingContext();
    quit?.run(q.ctx);
    expect(q.exit).toHaveBeenCalledTimes(1);

    // /help lists every registered command in its notice panel.
    const h = recordingContext();
    help?.run(h.ctx);
    const helpText = h.notices.flat().join('\n');
    for (const command of listCommands()) expect(helpText).toContain(`/${command.name}`);

    // /model and /status surface the REAL model/mode/cwd from the context.
    const md = recordingContext({ model: 'qwen-plus' as SafeText });
    model?.run(md.ctx);
    expect(md.notices.flat().join('\n')).toContain('qwen-plus');

    const st = recordingContext({ mode: 'yolo' as PermissionProfile, cwd: '/srv/app' as SafeText });
    status?.run(st.ctx);
    const statusText = st.notices.flat().join('\n');
    expect(statusText).toContain('yolo');
    expect(statusText).toContain('/srv/app');
  });
});
