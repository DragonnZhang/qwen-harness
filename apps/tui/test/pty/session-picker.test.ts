/**
 * UI-10 (TUI) — the SESSION PICKER, over a REAL PTY, driving the COMPILED bundle.
 *
 * This proves the picker lists ACTUAL durable sessions and resumes one into the real live turn
 * path — not a mock list and not source under a transpiler. It:
 *
 *   1. seeds TWO real durable sessions into a temp workspace's on-disk event store (the same
 *      `<cwd>/.qwen-harness/sessions.sqlite` the live `run` mode writes) by appending real
 *      `thread-created` / `turn-started` / `item-appended` events through `@qwen-harness/storage`;
 *   2. spawns `dist/tui.bundle.mjs` in `sessions` mode under node-pty with that workspace as cwd,
 *      and asserts BOTH seeded sessions RENDER in the picker (their sanitized names + prompts);
 *   3. selects one by keystroke and asserts the RESUMED transcript re-renders — content that lives
 *      ONLY in the reconstructed thread (the assistant reply, the tool-result diff), which the
 *      picker never shows, so its appearance proves a real reconstruct-from-the-store resume;
 *   4. exits via SIGINT and asserts clean terminal restoration (cursor shown, no alt-screen leak,
 *      exit 0).
 *
 * Runs under the `pty` project (fileParallelism:false) alongside golden-path-8; it neither weakens
 * nor depends on that test. A resumed turn would use the real `createHarnessRuntime`; this test does
 * not drive a NEW turn (no live credential), it asserts the list + select + re-render + restore that
 * UI-10 is defined by.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '@qwen-harness/storage';
import * as pty from 'node-pty';
import { afterAll, describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(27);
const SHOW_CURSOR = `${ESC}[?25h`;
const HIDE_CURSOR = `${ESC}[?25l`;
const ALT_SCREEN_ENTER = `${ESC}[?1049h`;

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const bundle = join(appDir, 'dist', 'tui.bundle.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnBundle(args, cwd, env) {
  const state = { output: '' };
  const term = pty.spawn(process.execPath, [bundle, ...args], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
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

/**
 * Seed one real durable session: a created thread, a user turn, an assistant reply, and a
 * tool-result diff — the shape a resume reconstructs. Everything crosses the store's real schema
 * validation and transactional projection, so what the picker later lists is genuine durable state.
 */
function seedSession(store, opts) {
  const { threadId, turnId, name, prompt, assistant, diff } = opts;
  const actor = { kind: 'user', id: 'act_user01' };
  const base = { threadId, correlationId: 'cor_seed000001', permissionProfile: 'ask', actor };
  store.append({
    ...base,
    payload: { type: 'thread-created', cwd: '/seed', canonicalRepo: '/seed', name },
  });
  store.append({ ...base, turnId, payload: { type: 'turn-started', userText: prompt } });
  store.append({
    ...base,
    turnId,
    itemId: `${threadId.replace('thr', 'itm')}a`,
    payload: {
      type: 'item-appended',
      item: {
        id: `${threadId.replace('thr', 'itm')}a`,
        turnId,
        threadId,
        seq: 0,
        createdAt: 1,
        type: 'assistant-message',
        text: assistant,
        complete: true,
      },
    },
  });
  store.append({
    ...base,
    turnId,
    itemId: `${threadId.replace('thr', 'itm')}b`,
    payload: {
      type: 'item-appended',
      item: {
        id: `${threadId.replace('thr', 'itm')}b`,
        turnId,
        threadId,
        seq: 1,
        createdAt: 2,
        type: 'tool-result',
        callId: 'call_seed_1',
        toolName: 'apply_patch',
        ok: true,
        preview: diff,
        outputRef: null,
        truncated: false,
        durationMs: 5,
        errorCategory: null,
      },
    },
  });
}

const workspace = mkdtempSync(join(tmpdir(), 'qwen-tui-sessions-'));

afterAll(() => {
  // Best-effort cleanup; the OS reaps the temp dir regardless.
});

describe('UI-10 — the session picker over a PTY lists real durable sessions and resumes one', () => {
  it('renders seeded sessions, selects one, and re-renders its reconstructed transcript', async () => {
    // -----------------------------------------------------------------------------------------
    // Seed two REAL durable sessions in the workspace's on-disk store.
    // -----------------------------------------------------------------------------------------
    mkdirSync(join(workspace, '.qwen-harness'), { recursive: true });
    let tick = 1_700_000_000_000;
    let n = 0;
    const store = new EventStore({
      path: join(workspace, '.qwen-harness', 'sessions.sqlite'),
      clock: { now: () => ++tick, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      ids: { next: (p) => `${p}_seed${(n++).toString(36).padStart(6, '0')}` },
    });

    // Seeded first -> older -> listed second (listThreads orders by updated_at DESC).
    seedSession(store, {
      threadId: 'thr_seedalpha01',
      turnId: 'trn_seedalpha01',
      name: 'Fix greeting bug',
      prompt: 'make greet() return a fuller message',
      assistant: 'Done: greet() now returns the string hello-world-greeting.',
      diff: '-  return "hi";\n+  return "hello, world";',
    });
    // Seeded second -> newest -> listed FIRST (index 1). This is the one we resume.
    seedSession(store, {
      threadId: 'thr_seedbeta002',
      turnId: 'trn_seedbeta002',
      name: 'Refactor logger',
      prompt: '重构日志模块 extract it out',
      assistant: 'Extracted the logger into a new module named logger-module-file.',
      diff: '-  console.log(x);\n+  logger.info(x);',
    });
    store.close();

    // -----------------------------------------------------------------------------------------
    // SPAWN — the picker, driven over a real PTY against the compiled bundle.
    // -----------------------------------------------------------------------------------------
    const app = spawnBundle(['sessions'], workspace, {});

    await app.waitFor((o) => o.includes(HIDE_CURSOR), 15_000, 'initial render (cursor hidden)');
    await app.waitFor((o) => o.includes('Resume a session'), 15_000, 'picker title');

    // BOTH seeded sessions are listed with their sanitized names — real durable state, not a mock.
    await app.waitFor((o) => o.includes('Refactor logger'), 10_000, 'newest session name');
    await app.waitFor((o) => o.includes('Fix greeting bug'), 10_000, 'older session name');
    // The picker shows the first prompt of each (untrusted text rendered as SafeText).
    expect(app.output).toContain('重构日志模块');
    // The assistant replies live ONLY in the reconstructed transcript, never in the picker list.
    expect(app.output).not.toContain('logger-module-file');
    expect(app.output).not.toContain('hello-world-greeting');

    // -----------------------------------------------------------------------------------------
    // SELECT the newest session by number. It resumes into the real live turn path and the
    // reconstructed transcript re-renders.
    // -----------------------------------------------------------------------------------------
    app.term.write('1');

    // Content unique to the reconstructed thread appears: assistant reply + the tool-result diff.
    await app.waitFor(
      (o) => o.includes('logger-module-file'),
      15_000,
      'resumed assistant reply re-rendered from the store',
    );
    await app.waitFor((o) => o.includes('logger.info(x);'), 15_000, 'resumed tool-result diff');
    // The user prompt row is back too.
    expect(app.output).toContain('重构日志模块');
    // We resumed the NEWEST session, not the other one.
    expect(app.output).not.toContain('hello-world-greeting');

    // -----------------------------------------------------------------------------------------
    // Exit cleanly and assert terminal restoration.
    // -----------------------------------------------------------------------------------------
    await sigintAndAwaitClean(app);
  });
});
