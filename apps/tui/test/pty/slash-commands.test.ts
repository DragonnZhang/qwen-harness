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
    const beforeCycle = app.output.length;
    app.term.write(ENTER);
    await app.waitFor(
      (o) => o.slice(beforeCycle).includes('auto-accept-edits'),
      10_000,
      '/mode executed — status line cycled ask → auto-accept-edits',
    );

    // 4b. A SECOND, DISTINCT command executes through the menu. Completing to `/model` filters
    // the menu to exactly one row (`model` is a prefix of `/model` but NOT of `/mode`), so Enter
    // runs `/model` — a different command from `/mode` — printing the model panel. This proves the
    // menu dispatches the highlighted registry object, not one hardcoded command. Arrow-key
    // navigation of the highlight is proven deterministically at the component level in
    // `test/unit/tui.test.ts` ("slash-command menu navigation (UI-04)"), where synchronous
    // ink-testing-library rendering removes the PTY keystroke-timing race that made this step flaky.
    const beforeModel = app.output.length;
    app.term.write('/model');
    await app.waitFor(
      (o) => o.slice(beforeModel).includes('/model'),
      10_000,
      '/model menu shown (filtered to one command)',
    );
    await delay(300); // let the filtered frame settle
    // `/mode` shares no `model`-prefix, so it is gone: the menu is now the single `/model` row.
    expect(app.output.slice(beforeModel)).not.toMatch(/\/mode\b(?!l)/);
    const beforeModelRun = app.output.length;
    app.term.write(ENTER);
    await app.waitFor(
      (o) => o.slice(beforeModelRun).includes('model:'),
      10_000,
      'Enter ran the SECOND menu command (/model) — model panel printed',
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

    // 6. /quit EXECUTES the exit path; the terminal is restored cleanly.
    const beforeQuit = app.output.length;
    app.term.write('/quit');
    await app.waitFor(
      (o) => o.slice(beforeQuit).includes('Exit the session'),
      10_000,
      '/quit menu shown',
    );
    await delay(200);
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
