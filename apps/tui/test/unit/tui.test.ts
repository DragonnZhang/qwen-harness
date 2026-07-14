/**
 * Unit tests for the Ink components via ink-testing-library (no PTY).
 *
 * ink-testing-library renders with `debug: true`, so `lastFrame()` returns the full static +
 * dynamic frame — which lets us assert on the completed transcript, the live diff colouring, the
 * persistent yolo banner, and the editor's key handling without a terminal.
 *
 * This is a `.test.ts` (not `.tsx`) because the `unit` vitest project globs `*.test.ts`; components
 * are constructed with `React.createElement` instead of JSX.
 */

import { ItemSchema } from '@qwen-harness/protocol';
import { render } from 'ink-testing-library';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App.tsx';
import { Editor } from '../../src/Editor.tsx';
import { arraySource } from '../../src/source.ts';

const CTRL_C = String.fromCharCode(3);
const ENTER = String.fromCharCode(13);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
function base(type, id, extra) {
  seq += 1;
  return { id, turnId: 'trn_test01', threadId: 'thr_test01', seq, createdAt: 0, type, ...extra };
}
const user = (id, text) => base('user-message', id, { text });
const assistant = (id, text, complete = true) => base('assistant-message', id, { text, complete });
const toolResult = (id, preview, ok = true) =>
  base('tool-result', id, {
    callId: 'call_1',
    toolName: 'apply_patch',
    ok,
    preview,
    outputRef: null,
    truncated: false,
    durationMs: 5,
    errorCategory: null,
  });

const status = (mode) => ({
  cwd: '/repo',
  model: 'qwen3.7-max',
  mode,
  activity: 'idle',
  contextTokens: null,
});

const rendered = [];
function mount(element) {
  const instance = render(element);
  rendered.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

describe('App transcript (UI-01/UI-02)', () => {
  it('renders user and assistant content with distinct chrome labels', async () => {
    const items = [user('itm_u1', 'hello world'), assistant('itm_a1', 'hi back')];
    const { lastFrame } = mount(h(App, { source: arraySource(items), status: status('ask') }));
    await tick();
    const out = lastFrame();
    expect(out).toContain('hello world');
    expect(out).toContain('hi back');
    // Trusted chrome labels are present and separate from the content.
    expect(out).toContain('user');
    expect(out).toContain('assistant');
  });

  it('renders a unified diff with add and remove lines (UI-02)', async () => {
    const diff = ['@@ -1,2 +1,2 @@', ' keep', '-old line', '+new line'].join('\n');
    const { lastFrame } = mount(
      h(App, { source: arraySource([toolResult('itm_r1', diff)]), status: status('ask') }),
    );
    await tick();
    const out = lastFrame();
    expect(out).toContain('+new line');
    expect(out).toContain('-old line');
    expect(out).toContain('keep');
  });

  it('makes hostile tool output inert (no escape survives, content remains)', async () => {
    const hostile = `ok ${String.fromCharCode(27)}[31mRED${String.fromCharCode(27)}[0m done`;
    const { lastFrame } = mount(
      h(App, { source: arraySource([toolResult('itm_r2', hostile)]), status: status('ask') }),
    );
    await tick();
    const out = lastFrame();
    expect(out).toContain('RED');
    expect(out).toContain('done');
    expect(out).not.toContain('[31m');
  });
});

describe('StatusLine yolo banner (UI-06)', () => {
  it('shows the persistent yolo danger banner only in yolo mode', async () => {
    const yolo = mount(h(App, { source: arraySource([]), status: status('yolo') }));
    await tick();
    expect(yolo.lastFrame()).toContain('YOLO MODE');

    const ask = mount(h(App, { source: arraySource([]), status: status('ask') }));
    await tick();
    expect(ask.lastFrame()).not.toContain('YOLO MODE');
  });
});

describe('Editor key handling (UI-03/UI-07)', () => {
  it('inserts printable input and submits on Enter', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = mount(
      h(Editor, { onSubmit, onInterrupt: vi.fn(), onExit: vi.fn(), busy: false }),
    );
    stdin.write('h');
    stdin.write('i');
    await tick();
    expect(lastFrame()).toContain('hi');

    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Ctrl-C on idle first clears the input, then a second press exits', async () => {
    const onExit = vi.fn();
    const { lastFrame, stdin } = mount(
      h(Editor, { onSubmit: vi.fn(), onInterrupt: vi.fn(), onExit, busy: false }),
    );
    stdin.write('a');
    stdin.write('b');
    await tick();
    expect(lastFrame()).toContain('ab');

    stdin.write(CTRL_C);
    await tick();
    expect(lastFrame()).not.toContain('ab');
    expect(onExit).not.toHaveBeenCalled();

    stdin.write(CTRL_C);
    await tick();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Ctrl-C while busy interrupts active work instead of exiting', async () => {
    const onInterrupt = vi.fn();
    const onExit = vi.fn();
    const { stdin } = mount(h(Editor, { onSubmit: vi.fn(), onInterrupt, onExit, busy: true }));
    stdin.write(CTRL_C);
    await tick();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('Shift+Tab cycles the approval mode and inserts nothing (UI-06)', async () => {
    const onCycleMode = vi.fn();
    const onSubmit = vi.fn();
    // ESC [ Z is the backtab (Shift+Tab) sequence; Ink decodes it as tab+shift.
    const SHIFT_TAB = `${String.fromCharCode(27)}[Z`;
    const { lastFrame, stdin } = mount(
      h(Editor, { onSubmit, onInterrupt: vi.fn(), onExit: vi.fn(), onCycleMode, busy: false }),
    );
    stdin.write(SHIFT_TAB);
    await tick();
    expect(onCycleMode).toHaveBeenCalledTimes(1);
    // It is a command, not text: the buffer stays empty and nothing was submitted.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('[Z');
  });
});

/**
 * The demo transcript is parsed through `ItemSchema` at module load, so an invalid fixture id
 * crashes the shipped binary on startup — which is exactly how it was first found (the compiled
 * bundle threw a ZodError before rendering a single byte). Importing it here makes that a unit
 * failure instead of a broken binary.
 */
describe('demo transcript fixture', () => {
  it('every scripted item satisfies the protocol schema', async () => {
    const { DEMO_ITEMS } = await import('../../src/demo.ts');
    expect(DEMO_ITEMS.length).toBeGreaterThan(0);
    for (const item of DEMO_ITEMS) {
      expect(() => ItemSchema.parse(item)).not.toThrow();
    }
  });
});

/**
 * Slash-command menu arrow-navigation, tested DETERMINISTICALLY at the component level (UI-04).
 *
 * The PTY test proves the menu renders/filters/executes/refuses-injection over a real terminal, but
 * arrow-nav timing under a loaded host is flaky in a PTY. ink-testing-library drives the real Editor
 * synchronously, so "Down moves the highlight and Enter runs the SECOND match" is proven without any
 * terminal-timing race. `/mode` and `/model` both match the query `mo`, in that order.
 */
describe('slash-command menu navigation (UI-04)', () => {
  const SAFE = (s) => s; // Editor sanitizes for display; the test passes plain strings as props.
  const DOWN = `${String.fromCharCode(27)}[B`;

  function mountMenu(onCycleMode) {
    return mount(
      h(Editor, {
        onSubmit: vi.fn(),
        onInterrupt: vi.fn(),
        onExit: vi.fn(),
        onCycleMode,
        busy: false,
        mode: 'ask',
        model: SAFE('qwen3.7-max'),
        cwd: SAFE('/repo'),
      }),
    );
  }

  it('Enter on the first match runs it (/mode → cycles the mode)', async () => {
    const onCycleMode = vi.fn();
    const { stdin, lastFrame } = mountMenu(onCycleMode);
    for (const ch of '/mode') stdin.write(ch);
    await tick();
    // The menu lists both /mode and /model (prefix "mode" matches both).
    expect(lastFrame()).toContain('/model');
    stdin.write(ENTER);
    await tick();
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });

  it('Down then Enter runs the SECOND match (/model → prints the model panel)', async () => {
    const onCycleMode = vi.fn();
    const { stdin, lastFrame } = mountMenu(onCycleMode);
    for (const ch of '/mode') stdin.write(ch);
    await tick();
    stdin.write(DOWN); // highlight moves to /model (index 1)
    await tick();
    stdin.write(ENTER); // runs /model, which opens the notice panel
    await tick();
    // /model printed the model panel (not /mode — onCycleMode was NOT called).
    expect(lastFrame()).toContain('model:');
    expect(onCycleMode).not.toHaveBeenCalled();
  });

  it('injected non-command text after / is never executed', async () => {
    const onCycleMode = vi.fn();
    const { stdin, lastFrame } = mountMenu(onCycleMode);
    for (const ch of '/notacommand') stdin.write(ch);
    await tick();
    stdin.write(ENTER);
    await tick();
    // Nothing ran: no mode cycle, no model panel.
    expect(onCycleMode).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('model:');
  });
});

/**
 * `@`-file completion in the editor (UI-04). The lister is INJECTED, so this is deterministic and
 * filesystem-free: typing `@` opens a menu of the injected matches, ↑/↓ moves the highlight, and Tab
 * SPLICES the highlighted path into the buffer (it never submits, never opens the file). Hostile
 * filenames render inert.
 */
describe('@-file completion (UI-04)', () => {
  const TAB = String.fromCharCode(9);
  const DOWN = `${String.fromCharCode(27)}[B`;
  const files = [
    { display: 'src/', insert: 'src/', isDir: true },
    { display: 'app.ts', insert: 'app.ts', isDir: false },
    { display: 'README.md', insert: 'README.md', isDir: false },
  ];

  function mountEditor(listFiles) {
    const onSubmit = vi.fn();
    const instance = mount(
      h(Editor, {
        onSubmit,
        onInterrupt: vi.fn(),
        onExit: vi.fn(),
        busy: false,
        listFiles,
      }),
    );
    return { ...instance, onSubmit };
  }

  it('typing @ opens the menu; Tab completes the highlighted path into the buffer', async () => {
    const { stdin, lastFrame, onSubmit } = mountEditor(() => files);
    stdin.write('@');
    await tick();
    expect(lastFrame()).toContain('src/');
    expect(lastFrame()).toContain('app.ts');

    stdin.write(TAB); // completes the first match (src/)
    await tick();
    expect(lastFrame()).toContain('@src/');
    // Completion is not submission.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Down then Tab completes the SECOND match', async () => {
    const { stdin, lastFrame } = mountEditor(() => files);
    stdin.write('@');
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('@app.ts');
  });

  it('Enter submits the message with the typed mention (does not complete)', async () => {
    // A lister that matches only when the query is exactly "app.ts" keeps the menu open at Enter.
    const { stdin, onSubmit } = mountEditor((q) =>
      q === 'app.ts' ? [{ display: 'app.ts', insert: 'app.ts', isDir: false }] : [],
    );
    for (const ch of 'see @app.ts') stdin.write(ch);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('see @app.ts');
  });

  // The inert-display security property lives in the lister, not the editor: `listFileMatches`
  // returns each name as sanitized `SafeText`, proven in `file-complete.test.ts`
  // ("a hostile filename is returned as inert SafeText"). The editor is typed to accept only
  // `SafeText` for `display`, so the trust boundary is enforced by the compiler, not this test.
});
