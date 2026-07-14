/**
 * UI-04 (T + E) — `@`-FILE COMPLETION over a REAL PTY, driving the COMPILED bundle.
 *
 * The slash-command PTY test proves the menu machinery renders over a real terminal; this proves the
 * OTHER completion surface — `@` file mentions — is real in the shipped `dist/tui.bundle.mjs`, using
 * the DEFAULT lister (no injection), which lists `process.cwd()`. We spawn the bundle in a throwaway
 * workspace with a known layout, so the completions are deterministic real filesystem reads:
 *
 *   1. RENDERS — typing `@` opens a menu listing the workspace entries (a dir sorts first);
 *   2. FILTERS — completing to `@be` narrows the menu to the matching file;
 *   3. COMPLETES — Tab splices the highlighted path into the buffer (`@beta.txt`), and does NOT submit;
 *   4. CONFINEMENT is not re-tested here (it is a filesystem-free unit property in
 *      `test/unit/file-complete.test.ts`); this file proves the real, un-injected path works end to end.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const TAB = String.fromCharCode(9);

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const bundle = join(appDir, 'dist', 'tui.bundle.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let workspace;
beforeAll(() => {
  // A deterministic layout: one dir (`gamma`) and two files; `beta.txt` is the unique `be…` match.
  workspace = mkdtempSync(join(tmpdir(), 'qh-atcomplete-'));
  mkdirSync(join(workspace, 'gamma'));
  writeFileSync(join(workspace, 'alpha.txt'), 'a');
  writeFileSync(join(workspace, 'beta.txt'), 'b');
});
afterAll(() => {
  // Best-effort cleanup; the OS temp dir is reclaimed regardless.
});

function spawnBundle(cwd) {
  const state = { output: '' };
  const term = pty.spawn(process.execPath, [bundle, '--scripted-turn'], {
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

describe('UI-04 — @-file completion through the compiled TUI over a PTY', () => {
  it('renders workspace entries, filters, and Tab-completes a real path', async () => {
    const app = spawnBundle(workspace);

    await app.waitFor((o) => o.includes(HIDE_CURSOR), 15_000, 'initial render (cursor hidden)');
    await app.waitFor((o) => o.includes('❯'), 15_000, 'editor prompt');

    // 1. RENDERS — `@` opens the menu listing the real workspace entries.
    app.term.write('@');
    await app.waitFor((o) => o.includes('gamma'), 10_000, '@ menu lists the gamma dir');
    await app.waitFor((o) => o.includes('alpha.txt'), 10_000, '@ menu lists alpha.txt');
    await app.waitFor((o) => o.includes('beta.txt'), 10_000, '@ menu lists beta.txt');

    // 2. FILTERS — completing to `@be` narrows to the one matching file.
    const beforeFilter = app.output.length;
    app.term.write('be');
    await app.waitFor(
      (o) => o.slice(beforeFilter).includes('beta.txt'),
      10_000,
      'beta.txt still shown after filtering',
    );
    await delay(300);
    const filtered = app.output.slice(beforeFilter);
    expect(filtered).not.toContain('alpha.txt'); // filtered out
    expect(filtered).not.toContain('gamma'); // filtered out

    // 3. COMPLETES — Tab splices the path into the buffer; the editor line now shows `@beta.txt`.
    const beforeTab = app.output.length;
    app.term.write(TAB);
    await app.waitFor(
      (o) => o.slice(beforeTab).includes('@beta.txt'),
      10_000,
      'Tab completed the buffer to @beta.txt',
    );

    // Exit cleanly via a real SIGINT; the terminal is restored (cursor shown).
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
