/**
 * GOLDEN PATH 8 (TUI) — a real coding task through the COMPILED bundle, over a REAL PTY.
 *
 * This drives `dist/tui.bundle.mjs` (ADR 0004: the TUI ships compiled; a PTY test runs the shipped
 * bundle, never a transpiler) under a genuine pseudo-terminal via node-pty. The bundle runs an
 * ACTUAL `TurnEngine` (`--scripted-turn`): the production agent loop, its turn state machine, the
 * approval pause/resume, and real `AbortSignal` cancellation. Only the model provider and the tool
 * executor are scripted, so the run is deterministic — exactly the RT-08 boundary the `evals/e2e`
 * coding loop uses. Everything a terminal owns is real: raw-mode input, bracketed-paste Unicode,
 * streaming render, resize, the interrupt keystroke, and the restoration on exit.
 *
 * The capability-matrix sub-claims exercised, end to end:
 *   - multiline Unicode input (CJK + emoji + a combining mark) pasted and submitted;
 *   - a STREAMING assistant response, then a tool call, then a DIFF the user APPROVES by keystroke;
 *   - a mid-task RESIZE (80x24 -> 120x40) that redraws;
 *   - an INTERRUPT (Ctrl-C during work) that cancels the turn instead of killing the process;
 *   - SESSION RESUME: the durable transcript survives process death and re-renders in a fresh spawn;
 *   - clean terminal RESTORATION on exit (cursor shown, no alt-screen leak, exit 0).
 *
 * Runs under the `pty` project (fileParallelism:false), so it never races another PTY test for the
 * controlling terminal. It does not weaken `restoration.test.ts`; it stands alongside it.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
const SHOW_CURSOR = `${ESC}[?25h`;
const HIDE_CURSOR = `${ESC}[?25l`;
const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const ENTER = '\r';
const CTRL_C = String.fromCharCode(3);

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const bundle = join(appDir, 'dist', 'tui.bundle.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnBundle(args, env) {
  const state = { output: '' };
  const term = pty.spawn(process.execPath, [bundle, ...args], {
    name: 'xterm-256color',
    cols: 80,
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
  // Cursor shown again; the alternate screen was never entered, so nothing leaks.
  expect(session.output).toContain(SHOW_CURSOR);
  expect(session.output).not.toContain(ALT_SCREEN_ENTER);
}

describe('golden path 8 — a real task through the compiled TUI over a PTY', () => {
  it('drives input, streaming, diff approval, resize, interrupt, and resumes durable state', async () => {
    // ---------------------------------------------------------------------------------------
    // SPAWN 1 — the live task, driven interactively against a real TurnEngine.
    // ---------------------------------------------------------------------------------------
    const app = spawnBundle(['--scripted-turn'], {});

    // 1. It renders and takes over the cursor (Ink hid it); the editor prompt is live.
    await app.waitFor((o) => o.includes(HIDE_CURSOR), 15_000, 'initial render (cursor hidden)');
    await app.waitFor((o) => o.includes('❯'), 15_000, 'editor prompt');

    // 2. Multiline Unicode input: CJK + emoji + a combining mark (e + U+0301), as a bracketed
    //    paste (one atomic input, a real newline inside — never a submit), then Enter submits.
    const line1 = '修复问候语 🐛';
    const line2 = 'return a fuller greéting'; // "greéting" via a combining acute
    app.term.write(`${PASTE_START}${line1}\n${line2}${PASTE_END}`);
    await delay(150);
    await app.waitFor((o) => o.includes('修复问候语'), 10_000, 'pasted Unicode in the editor');
    app.term.write(ENTER);

    // 3. The user message is committed to the transcript, and the assistant STREAMS its reply.
    await app.waitFor((o) => o.includes('修复问候语'), 10_000, 'user message row');
    await app.waitFor((o) => o.includes('inspect the greeting'), 15_000, 'streamed assistant text');

    // 4. The tool call surfaces, and — because the scripted policy says `ask` — a real approval
    //    dialog blocks on the exact normalized action.
    await app.waitFor((o) => o.includes('Approval required'), 15_000, 'approval dialog');
    expect(app.output).toContain('apply_patch greeting.ts');

    // 5. Approve with a keystroke ('1' = allow once). The turn RESUMES into executing.
    app.term.write('1');

    // 6. The tool result is a unified DIFF, rendered with add/remove lines.
    await app.waitFor((o) => o.includes('return "hello, world";'), 15_000, 'diff add line');
    expect(app.output).toContain('return "hi";'); // the removed line

    // 7. Mid-task RESIZE: the app redraws after the pty grows.
    const beforeResize = app.output.length;
    app.term.resize(120, 40);
    await app.waitFor((o) => o.length > beforeResize, 10_000, 'redraw after resize');

    // 8. The second model round streams and the turn completes naturally; wait for its usage row
    //    (unique to round two) and let the turn settle back to idle before driving the next turn.
    await app.waitFor((o) => o.includes('total 424'), 15_000, 'second round usage');
    expect(app.output).toContain('All tests pass');

    // CX-01: the status line EXPOSES current context utilization. With a real transcript in place, the
    // `<n> ctx` indicator renders — it was previously dead code (contextTokens was always null, so the
    // StatusLine branch never fired). This is the frame proof that utilization is actually surfaced.
    await app.waitFor((o) => /\d+ ctx/.test(o), 10_000, 'context utilization indicator (CX-01)');

    await delay(500);

    // 9. A second turn starts long-running work; while it is BUSY, Ctrl-C must INTERRUPT the turn
    //    (cancel it) rather than kill the process.
    app.term.write('run the full suite');
    await app.waitFor((o) => o.includes('run the full suite'), 10_000, 'second prompt typed');
    app.term.write(ENTER);
    await app.waitFor(
      (o) => o.includes('Running the full test suite'),
      15_000,
      'long work started',
    );

    app.term.write(CTRL_C);
    // The process must still be alive a moment later: interrupt cancelled the turn, not the app.
    const stillAlive = await Promise.race([
      app.exited.then(() => 'exited'),
      delay(800).then(() => 'alive'),
    ]);
    expect(stillAlive).toBe('alive');

    // 10. Exit cleanly via SIGINT and assert terminal restoration.
    await sigintAndAwaitClean(app);

    // The real engine emitted a durable transcript on the way out. Capture it.
    const match = /<<<QWEN_DURABLE>>>([A-Za-z0-9+/=]+)<<<END_QWEN_DURABLE>>>/.exec(app.output);
    expect(match, 'durable transcript dump present').not.toBeNull();
    const durableJson = Buffer.from(match[1], 'base64').toString('utf8');
    const durable = JSON.parse(durableJson);
    expect(Array.isArray(durable)).toBe(true);
    // It is the REAL loop's persisted items: the user message, a tool-result diff, assistant text.
    const types = durable.map((item) => item.type);
    expect(types).toContain('user-message');
    expect(types).toContain('tool-result');
    expect(types).toContain('assistant-message');
    expect(durableJson).toContain('hello, world');

    // ---------------------------------------------------------------------------------------
    // SPAWN 2 — SESSION RESUME: a fresh process re-projects the durable transcript.
    // ---------------------------------------------------------------------------------------
    const encoded = Buffer.from(durableJson, 'utf8').toString('base64');
    const resumed = spawnBundle([], { QWEN_TUI_RESUME: encoded });

    await resumed.waitFor((o) => o.includes(HIDE_CURSOR), 15_000, 'resume render');
    // The durable state survived process death and re-renders: the diff and the reply are back.
    await resumed.waitFor((o) => o.includes('return "hello, world";'), 15_000, 'resumed diff');
    await resumed.waitFor((o) => o.includes('修复问候语'), 10_000, 'resumed user message');
    expect(resumed.output).toContain('All tests pass');

    await sigintAndAwaitClean(resumed);
  });
});
