/**
 * UI-04 (T + E) — the `!` DIRECT USER SHELL ACTION over a REAL PTY, driving the COMPILED bundle in
 * `run` (live-runtime) mode.
 *
 * This is the end-to-end proof that the `!` surface is real in the shipped `dist/tui.bundle.mjs`: a
 * `!<cmd>` typed into the editor runs through the REAL sandboxed pipeline (the same runtime the CLI
 * builds) with the USER as actor, prints its captured output in the transcript, and starts NO model
 * turn — so it needs no credential and never contacts the provider. The security/behaviour details
 * (managed-deny, redaction, no-model-turn, audit item) are proven against the real components in
 * `apps/cli/test/integration/user-shell.test.ts`; here we prove the shipped TUI actually invokes them.
 *
 * We spawn in a throwaway workspace so the sandbox and the `.qwen-harness` store are isolated, and we
 * gate the executing Enter on the editor's echoed buffer line (not a transient frame), the same
 * determinism technique the slash-command PTY test uses.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ENTER = '\r';

// Strip CSI escapes so the editor's echoed buffer line can be matched as plain text.
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const stripAnsi = (s) => s.replace(ANSI, '');
const bufferShows = (o, text) => stripAnsi(o).includes(`❯ ${text}`);

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const bundle = join(appDir, 'dist', 'tui.bundle.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let workspace;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'qh-shellaction-'));
});
afterAll(() => {
  // The OS reclaims the temp dir; the `.qwen-harness` store inside it is isolated to this test.
});

function spawnRun(cwd) {
  const state = { output: '' };
  const term = pty.spawn(process.execPath, [bundle, 'run'], {
    name: 'xterm-256color',
    cols: 160,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  term.onData((data) => {
    state.output += data;
  });
  state.term = term;
  state.exited = new Promise((resolve) => {
    term.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
  });
  state.waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(state.output)) return;
      await delay(25);
    }
    throw new Error(
      `timed out waiting for: ${label}\n--- output tail ---\n${state.output.slice(-2000)}`,
    );
  };
  return state;
}

describe('UI-04 — the ! direct shell action through the compiled TUI over a PTY', () => {
  it('runs a real command in the sandbox and prints its output, with no model turn', async () => {
    const app = spawnRun(workspace);

    await app.waitFor((o) => o.includes(HIDE_CURSOR), 20_000, 'initial render (cursor hidden)');
    await app.waitFor((o) => o.includes('❯'), 20_000, 'editor prompt');

    // Type the direct shell action. The hint confirms the editor recognises it as a `!` action.
    app.term.write('!echo qwen-shell-ok');
    await app.waitFor((o) => o.includes('no model turn'), 10_000, '! action hint shown');
    // Gate Enter on the echoed buffer so it fires only once the whole command is in the buffer.
    await app.waitFor(
      (o) => bufferShows(o, '!echo qwen-shell-ok'),
      10_000,
      'buffer echoes the ! command',
    );

    const beforeRun = app.output.length;
    app.term.write(ENTER);
    // The real sandboxed command ran: its stdout appears in the transcript, with the exit code.
    await app.waitFor(
      (o) => o.slice(beforeRun).includes('qwen-shell-ok'),
      20_000,
      '! command output printed in the transcript',
    );
    await app.waitFor((o) => o.slice(beforeRun).includes('exit 0'), 20_000, 'exit code 0 shown');
    // The command is echoed as a `$`-prefixed user-shell row, not a user MESSAGE.
    expect(app.output.slice(beforeRun)).toContain('$ echo qwen-shell-ok');

    // Exit cleanly with a real SIGINT; the terminal is restored.
    app.term.kill('SIGINT');
    const result = await Promise.race([
      app.exited,
      delay(15_000).then(() => {
        app.term.kill();
        throw new Error('process did not exit after SIGINT');
      }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(app.output).toContain(SHOW_CURSOR);
  });
});
