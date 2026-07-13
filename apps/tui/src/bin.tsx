/**
 * The TUI entry point and terminal-restoration owner (UI-13, ADR 0004).
 *
 * This is a COMPOSITION ROOT: it may open host capabilities (stdin/stdout, signals). It enters the
 * Ink app and — critically — guarantees the terminal is restored on EVERY exit path: SIGINT,
 * SIGTERM, an uncaught error, and a normal unmount. Restoration means the cursor is shown and raw
 * mode is released; the classic renderer never enters the alternate screen, so there is nothing to
 * leak there. Ink performs most of this on unmount; we make it belt-and-suspenders so a signal that
 * races Ink's own teardown still leaves a clean terminal.
 *
 * Per ADR 0004 this file is SHIPPED COMPILED (`dist/tui.bundle.mjs`); it is never executed through
 * an in-process transpiler on the production or performance path.
 */

import { render } from 'ink';
import type { ReactElement } from 'react';

import { ItemSchema, sanitize, type Item } from '@qwen-harness/protocol';

import { App } from './App.tsx';
import { DEMO_ITEMS } from './demo.ts';
import { LiveApp } from './live.tsx';
import { createScriptedTurn, type LiveController } from './scripted-turn.ts';
import { arraySource, emitterSource } from './source.ts';
import type { StatusModel } from './types.ts';

/** ESC = 27. Built via fromCharCode so no raw control byte or escape sits in source (per brief). */
const ESC = String.fromCharCode(27);
/** ESC [ ? 2 5 h — show the cursor. Written explicitly so no exit path can leave it hidden. */
const SHOW_CURSOR = ESC + '[?25h';

/** Restore the terminal to a sane state. Safe to call multiple times and on any exit path. */
function restore(): void {
  const out = process.stdout;
  if (out.isTTY) out.write(SHOW_CURSOR);
  const input = process.stdin;
  if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(false);
}

function buildStatus(mode: StatusModel['mode']): StatusModel {
  return {
    cwd: sanitize(process.cwd(), { origin: 'user', multiline: false, maxLength: 80 }).text,
    model: sanitize('qwen3.7-max', { origin: 'user', multiline: false }).text,
    mode,
    activity: 'idle',
    contextTokens: null,
  };
}

let submitSeq = 0;
function userMessage(text: string): Item {
  submitSeq += 1;
  const id = `itm_in${String(submitSeq).padStart(6, '0')}`;
  return ItemSchema.parse({
    id,
    turnId: 'trn_live01',
    threadId: 'thr_live01',
    seq: 1000 + submitSeq,
    createdAt: 0,
    type: 'user-message',
    text,
  });
}

/**
 * Load a durable transcript a prior process emitted (the base64 JSON in `QWEN_TUI_RESUME`) and
 * validate every item at the boundary. This is the TUI half of "session resume": a fresh process
 * re-projects durable state it did not itself produce. Engine-level turn continuation is the
 * daemon's responsibility; here the transcript survives process death and re-renders.
 */
function resumeItems(encoded: string): readonly Item[] {
  const json = Buffer.from(encoded, 'base64').toString('utf8');
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error('QWEN_TUI_RESUME is not a JSON array');
  return raw.map((entry) => ItemSchema.parse(entry));
}

/** Pick the root element for this invocation, plus an optional live controller for the exit dump. */
function selectRoot(mode: StatusModel['mode']): {
  element: ReactElement;
  controller: LiveController | null;
} {
  const resume = process.env['QWEN_TUI_RESUME'];
  if (typeof resume === 'string' && resume.length > 0) {
    return {
      element: <App source={arraySource(resumeItems(resume))} status={buildStatus(mode)} />,
      controller: null,
    };
  }

  if (process.argv.includes('--scripted-turn')) {
    const controller = createScriptedTurn(mode);
    return { element: <LiveApp controller={controller} />, controller };
  }

  const source = emitterSource(DEMO_ITEMS);
  return {
    element: (
      <App
        source={source}
        status={buildStatus(mode)}
        onSubmit={(text) => source.push(userMessage(text))}
      />
    ),
    controller: null,
  };
}

function main(): void {
  const mode: StatusModel['mode'] = process.argv.includes('--yolo') ? 'yolo' : 'ask';
  const { element, controller } = selectRoot(mode);

  const instance = render(element, { exitOnCtrlC: false });

  // The durable transcript is emitted once, on the way out, on stderr — the terminal is already
  // being restored, so nothing races Ink's live region. A resuming process reads it back.
  let dumped = false;
  const dumpDurable = (): void => {
    if (dumped || controller === null) return;
    dumped = true;
    controller.dumpDurable((line) => process.stderr.write(`\n${line}\n`));
  };

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    restore();
    instance.unmount();
    dumpDurable();
    // Give Ink a tick to flush its final frame, then leave with a clean terminal.
    setImmediate(() => {
      restore();
      process.exit(code);
    });
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', restore);
  process.once('uncaughtException', (error: unknown) => {
    restore();
    console.error(error);
    process.exit(1);
  });

  instance
    .waitUntilExit()
    .then(() => {
      restore();
      dumpDurable();
      process.exit(0);
    })
    .catch(() => {
      restore();
      process.exit(1);
    });
}

main();
