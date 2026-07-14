/**
 * UI-06 (TUI) — RUNTIME APPROVAL-MODE SWITCHING, over a REAL PTY, driving the COMPILED bundle.
 *
 * This proves the Shift+Tab keybinding cycles the approval mode LIVE, in the shipped
 * `dist/tui.bundle.mjs` (ADR 0004: a PTY test drives the shipped bundle, never a transpiler), under
 * a genuine pseudo-terminal via node-pty. It:
 *
 *   1. spawns the bundle in `--scripted-turn` (the same real-engine harness golden-path-8 uses) with
 *      no `--profile`, so it launches in the default `ask` mode, and asserts the status line renders
 *      `ask`;
 *   2. presses Shift+Tab (the backtab sequence ESC [ Z, which Ink decodes as tab+shift) four times
 *      and asserts the status line RE-RENDERS and CYCLES ask→auto-accept-edits→yolo→plan→ask — each
 *      new profile is asserted in the bytes written AFTER its keystroke, so a stale earlier frame in
 *      the cumulative stream cannot satisfy it;
 *   3. asserts the persistent yolo danger banner appears while in `yolo` and is gone after cycling
 *      past it;
 *   4. exits via SIGINT and asserts clean terminal restoration (cursor shown, no alt-screen leak,
 *      exit 0).
 *
 * The ceiling clamp on a runtime switch is not cleanly assertable here (the scripted controller has
 * no real authority, and driving a live credential under a PTY is out of scope), so it is proven as
 * a focused controller/authority unit test in `apps/tui/test/unit/mode-switch-ceiling.test.ts`.
 *
 * Runs under the `pty` project (fileParallelism:false) alongside golden-path-8; it neither weakens
 * nor depends on that test.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
const SHOW_CURSOR = `${ESC}[?25h`;
const HIDE_CURSOR = `${ESC}[?25l`;
const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
const SHIFT_TAB = `${ESC}[Z`;

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const bundle = join(appDir, 'dist', 'tui.bundle.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnBundle(args, env) {
  const state = { output: '' };
  // A wide terminal keeps the one-line status ("<cwd> · <model> · <mode> · idle") from wrapping, so
  // a profile name is always a contiguous run of bytes we can match.
  const term = pty.spawn(process.execPath, [bundle, ...args], {
    name: 'xterm-256color',
    cols: 160,
    rows: 24,
    cwd: appDir,
    env: { ...process.env, TERM: 'xterm-256color', ...env },
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

async function sigintAndAwaitClean(session) {
  process.kill(session.term.pid, 'SIGINT');
  const result = await Promise.race([
    session.exited,
    delay(15_000).then(() => {
      session.term.kill();
      throw new Error('process did not exit after SIGINT');
    }),
  ]);
  expect(result.exitCode).toBe(0);
  expect(session.output).toContain(SHOW_CURSOR);
  expect(session.output).not.toContain(ALT_SCREEN_ENTER);
}

describe('UI-06 — runtime approval-mode switching through the compiled TUI over a PTY', () => {
  it('cycles the mode on Shift+Tab and re-renders the status line, then restores on exit', async () => {
    const app = spawnBundle(['--scripted-turn'], {});

    // It renders and takes over the cursor; the status line shows the launch mode (`ask`).
    await app.waitFor((o) => o.includes(HIDE_CURSOR), 15_000, 'initial render (cursor hidden)');
    await app.waitFor((o) => o.includes('❯'), 15_000, 'editor prompt');
    await app.waitFor((o) => o.includes('ask'), 15_000, 'launch mode ask in the status line');
    // Not yet in yolo: the danger banner must be absent.
    expect(app.output).not.toContain('YOLO MODE');

    // Cycle order from `ask`: auto-accept-edits → yolo → plan → ask. Each expectation is matched only
    // in the bytes written AFTER its keystroke, so an earlier frame cannot spuriously satisfy it.
    const step = async (expected, label) => {
      const from = app.output.length;
      app.term.write(SHIFT_TAB);
      await app.waitFor((o) => o.slice(from).includes(expected), 10_000, `cycled to ${label}`);
    };

    await step('auto-accept-edits', 'auto-accept-edits');
    await step('yolo', 'yolo');
    // In yolo, the persistent danger banner is now on screen (trusted chrome, live region).
    await app.waitFor((o) => o.includes('YOLO MODE'), 10_000, 'yolo danger banner shown');

    // Let the yolo frame settle so no trailing yolo redraw lands after the next offset.
    await delay(300);

    // Continue past yolo; the banner must disappear once the mode leaves yolo. Assert `plan` renders
    // and that no yolo banner is emitted in the frames written after the keystroke.
    const beforePlan = app.output.length;
    app.term.write(SHIFT_TAB);
    await app.waitFor((o) => o.slice(beforePlan).includes('plan'), 10_000, 'cycled to plan');
    await delay(300);
    const afterPlan = app.output.length;
    app.term.write(SHIFT_TAB);
    await app.waitFor((o) => o.slice(afterPlan).includes('ask'), 10_000, 'cycled back to ask');
    // From `plan` onward the yolo banner is no longer emitted on redraw.
    expect(app.output.slice(beforePlan)).not.toContain('YOLO MODE');

    await sigintAndAwaitClean(app);
  });
});
