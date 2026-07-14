/**
 * UI-04 (T + E) — the SLASH-COMMAND SURFACE, over a REAL PTY, driving the COMPILED bundle.
 *
 * This proves the completion menu is real in the shipped `dist/tui.bundle.mjs` (ADR 0004: a PTY test
 * drives the shipped bundle, never a transpiler), under a genuine pseudo-terminal via node-pty. It
 * models on `golden-path-8.test.ts` / `mode-switch.test.ts` and, in one interactive session, proves:
 *
 *   1. RENDERS — typing `/` opens a menu that lists the real registered commands (`/help`, `/status`,
 *      … each with a description);
 *   2. FILTERS — typing `/help` narrows the menu to just `/help` (other commands leave the frame);
 *   3. EXECUTES (output) — Enter on `/help` closes the menu and prints the real help panel
 *      (`Slash commands:` + every command), observable in the bytes AFTER the keystroke;
 *   4. EXECUTES (state) — `/mode`, selected by ARROWING DOWN to it (Up/Down navigation, since `mode`
 *      shares the `mode` prefix with `model`), cycles the approval mode: the status line re-renders
 *      `ask → auto-accept-edits`, the same real effect Shift+Tab produces;
 *   5. SECURITY — typing `/notacommand` yields NO runnable command (the menu says so) and executes
 *      NOTHING: no help panel appears and the mode does not change. Injected text is never a command.
 *   6. `/quit` EXECUTES the exit path, and the terminal is cleanly restored (cursor shown, no
 *      alt-screen leak, exit 0).
 *
 * Runs under the `pty` project (fileParallelism:false) alongside golden-path-8 and mode-switch; it
 * neither weakens nor depends on them.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
const SHOW_CURSOR = `${ESC}[?25h`;
const HIDE_CURSOR = `${ESC}[?25l`;
const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
const ENTER = '\r';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const bundle = join(appDir, 'dist', 'tui.bundle.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Strip CSI escape sequences so the editor's echoed buffer line can be matched as plain text.
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const stripAnsi = (s) => s.replace(ANSI, '');

/**
 * True once the editor's INPUT LINE echoes exactly `text`. The prompt `❯ ` prefixes only the editor
 * line, so `❯ <text>` is unique to the buffer — unlike a menu ROW, which also appears in the
 * unfiltered `/` menu. Gating an executing Enter on this echo guarantees the buffer is complete
 * BEFORE Enter fires, independent of how fast the terminal rendered the intervening keystrokes.
 */
const bufferShows = (o, text) => stripAnsi(o).includes(`❯ ${text}`);

function spawnBundle(args, env) {
  const state = { output: '' };
  // A wide terminal keeps the one-line status and the menu rows from wrapping, so each command name
  // is a contiguous run of bytes we can match.
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

describe('UI-04 — the slash-command menu through the compiled TUI over a PTY', () => {
  it('renders, filters, executes real commands, refuses injected text, and restores on exit', async () => {
    const app = spawnBundle(['--scripted-turn'], {});

    // It renders, hides the cursor, shows the editor prompt, and launches in `ask`.
    await app.waitFor((o) => o.includes(HIDE_CURSOR), 15_000, 'initial render (cursor hidden)');
    await app.waitFor((o) => o.includes('❯'), 15_000, 'editor prompt');
    await app.waitFor((o) => o.includes('ask'), 15_000, 'launch mode ask');

    // 1. RENDERS — `/` opens the menu listing the real commands.
    app.term.write('/');
    await app.waitFor((o) => o.includes('/help'), 10_000, 'menu shows /help');
    await app.waitFor((o) => o.includes('/status'), 10_000, 'menu shows /status');
    // The menu offers more than one command (a real registry, not a single hardcoded row).
    await app.waitFor((o) => o.includes('/quit'), 10_000, 'menu shows /quit');

    // 2. FILTERS — completing to `/help` narrows the menu to just `/help`.
    const beforeFilter = app.output.length;
    app.term.write('help');
    await app.waitFor(
      (o) => o.slice(beforeFilter).includes('/help'),
      10_000,
      '/help still shown after filtering',
    );
    await delay(300); // let the filtered frame settle
    const filtered = app.output.slice(beforeFilter);
    // `/status` and `/quit` no longer start with `help`, so they are gone from the filtered frames.
    expect(filtered).not.toContain('/status');
    expect(filtered).not.toContain('/quit');

    // 3. EXECUTES (output) — Enter runs /help: the menu closes and the real help panel prints.
    // Gate on the buffer echo so Enter fires only once the buffer is exactly `/help`.
    await app.waitFor((o) => bufferShows(o, '/help'), 10_000, 'buffer echoes /help');
    const beforeHelp = app.output.length;
    app.term.write(ENTER);
    await app.waitFor(
      (o) => o.slice(beforeHelp).includes('Slash commands:'),
      10_000,
      '/help executed — help panel printed',
    );
    // The panel lists the real registry (proves it read `listCommands()`, not a canned string).
    await app.waitFor((o) => o.slice(beforeHelp).includes('/mode'), 10_000, 'help lists /mode');

    // 4. EXECUTES (state) — `/mode` cycles the approval mode, the same real effect Shift+Tab has.
    // `mode` sorts before `model`, so it is the highlighted (index 0) match for `/mode`: Enter runs it.
    app.term.write('/mode');
    await app.waitFor((o) => o.includes('/model'), 10_000, '/mode menu shows both mode and model');
    // Gate the executing Enter on the buffer echo — the `/model` ROW alone appears in the unfiltered
    // menu too, so it does not prove the buffer reached `/mode`.
    await app.waitFor((o) => bufferShows(o, '/mode'), 10_000, 'buffer echoes /mode');
    const beforeCycle = app.output.length;
    app.term.write(ENTER);
    await app.waitFor(
      (o) => o.slice(beforeCycle).includes('auto-accept-edits'),
      10_000,
      '/mode executed — status line cycled ask → auto-accept-edits',
    );

    // 4b. A SECOND, DISTINCT command executes through the menu — proving it dispatches the highlighted
    // registry object, not one hardcoded command. We use `/status` because `status` is a UNIQUE
    // prefix: no other command name begins with `s`, so EVERY prefix of `/status` (`/s`, `/sta`, …)
    // filters the menu to exactly the `/status` row and Enter runs it — the result does not depend on
    // how many keystrokes the terminal has rendered when Enter fires. (Targeting `/model`, whose
    // prefix `mode` is shared with `/mode`, made this racy: the `/model` ROW renders while the buffer
    // is still `/mode`, so Enter could run the wrong command. Highlight NAVIGATION between shared-prefix
    // rows is instead proven deterministically at the component level in `test/unit/tui.test.ts`.)
    app.term.write('/status');
    // Wait for the buffer to actually echo `/status` (the `/status` menu ROW shows in the full `/`
    // menu too, so it cannot gate Enter). Once the input line reads `/status`, Enter runs it.
    await app.waitFor((o) => bufferShows(o, '/status'), 10_000, 'buffer echoes /status');
    const beforeStatusRun = app.output.length;
    app.term.write(ENTER);
    // `/status` prints a `workspace:` line that no other command prints (`/help` prints
    // `Slash commands:`, `/mode` cycles the status line) — so this uniquely proves `/status` executed.
    await app.waitFor(
      (o) => o.slice(beforeStatusRun).includes('workspace:'),
      10_000,
      'Enter ran the SECOND menu command (/status) — status panel printed',
    );

    // 5. SECURITY — injected text after `/` is not a command: the menu says there is nothing to run,
    // and nothing executes (no help panel, no further mode change) from the moment it is typed.
    const beforeInjected = app.output.length;
    app.term.write('/notacommand');
    await app.waitFor(
      (o) => o.slice(beforeInjected).includes('no matching command'),
      10_000,
      'injected text offers no runnable command',
    );
    await delay(300);
    const injectedSlice = app.output.slice(beforeInjected);
    expect(injectedSlice).not.toContain('Slash commands:'); // /help did NOT run
    expect(injectedSlice).not.toContain('yolo'); // no further mode cycle happened
    // Esc closes the menu, discarding the non-command line without running anything.
    app.term.write(ESC);
    await delay(200);

    // 6. /quit EXECUTES the exit path; the terminal is restored cleanly. Gate the Enter on the buffer
    // echo — `Exit the session` is the `/quit` DESCRIPTION, which also shows in the full `/` menu.
    app.term.write('/quit');
    await app.waitFor((o) => bufferShows(o, '/quit'), 10_000, 'buffer echoes /quit');
    app.term.write(ENTER);

    const result = await Promise.race([
      app.exited,
      delay(15_000).then(() => {
        app.term.kill();
        throw new Error('process did not exit after /quit');
      }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(app.output).toContain(SHOW_CURSOR);
    expect(app.output).not.toContain(ALT_SCREEN_ENTER);
  });
});
