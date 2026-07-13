/**
 * The UI-13 terminal-restoration gate — REAL PTY, COMPILED bundle (ADR 0004).
 *
 * This spawns the shipped `dist/tui.bundle.mjs` (never a transpiler) under a genuine pseudo-terminal
 * via node-pty, then exercises the restoration contract end to end:
 *
 *   1. it renders (bytes appear on the pty);
 *   2. a mid-session resize 80x24 -> 120x40 is honored (the app redraws);
 *   3. SIGINT tears it down cleanly: the process exits 0, the cursor is shown again
 *      (ESC[?25h), and the alternate screen is never leaked (no ESC[?1049h).
 *
 * Reuses the checkpoint-00 §5 spike harness approach. It runs under the `pty` vitest project
 * (fileParallelism:false), so it never races another pty test for the controlling terminal.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
const SHOW_CURSOR = `${ESC}[?25h`;
const HIDE_CURSOR = `${ESC}[?25l`;
const ALT_SCREEN_ENTER = `${ESC}[?1049h`;

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const bundle = join(appDir, 'dist', 'tui.bundle.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('UI-13 terminal restoration under a real PTY', () => {
  it('renders, honors resize, and restores the terminal on SIGINT', async () => {
    let output = '';
    const term = pty.spawn(process.execPath, [bundle, '--yolo'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: appDir,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    term.onData((data) => {
      output += data;
    });

    const exited = new Promise((resolve) => {
      term.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
    });

    // 1. It renders. The yolo banner text is trusted chrome drawn on the live region.
    await waitFor(() => output.includes('YOLO'), 15_000, 'initial render (YOLO banner)');
    expect(output).toContain('apply_patch'); // a completed transcript row rendered
    expect(output).toContain(HIDE_CURSOR); // Ink took over the cursor

    // 2. Resize is honored: the app redraws after the pty grows.
    const beforeResize = output.length;
    term.resize(120, 40);
    await waitFor(() => output.length > beforeResize, 10_000, 'redraw after resize');

    // Feed some input to prove the input path is live, then interrupt.
    term.write('hi');
    await delay(200);

    // 3. SIGINT must restore the terminal and exit cleanly.
    process.kill(term.pid, 'SIGINT');
    const result = await Promise.race([
      exited,
      delay(15_000).then(() => {
        term.kill();
        throw new Error('process did not exit after SIGINT');
      }),
    ]);

    expect(result.exitCode).toBe(0);
    // Cursor was shown again; the alternate screen was never entered, so nothing leaks.
    expect(output).toContain(SHOW_CURSOR);
    expect(output).not.toContain(ALT_SCREEN_ENTER);
  });
});
