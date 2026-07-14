import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';

/**
 * GOLDEN-PATH-9 companion — the LIVE TUI streams a real `qwen3.7-max` response.
 *
 * This drives the COMPILED bundle (`apps/tui/dist/tui.bundle.mjs`) in `run` mode under a REAL PTY,
 * against the REAL model through the REAL composition (`createHarnessRuntime` — real provider, real
 * sandboxed pipeline, durable store). It proves the thing a demo cannot: that typing a prompt into
 * the shipped TUI produces a streaming assistant response from the actual service. The scripted PTY
 * test (`apps/tui/test/pty/golden-path-8.test.ts`) proves the same interaction deterministically;
 * this is the live end of it.
 *
 * Fails CLOSED (skipped) with no key; runs only under `pnpm test:live`, never `pnpm check`.
 */

const hasKey = Boolean(process.env['DASHSCOPE_API_KEY']);

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ENTER = '\r';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', '..', 'apps', 'tui', 'dist', 'tui.bundle.mjs');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasKey)('live TUI streaming (qwen3.7-max, real PTY, compiled bundle)', () => {
  it('renders, streams a real assistant response, and restores the terminal', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'qh-tui-live-'));
    execSync('git init -q', { cwd: ws });

    let output = '';
    const term = pty.spawn(process.execPath, [bundle, 'run'], {
      name: 'xterm-256color',
      cols: 90,
      rows: 28,
      cwd: ws,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    term.onData((d) => {
      output += d;
    });
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      term.onExit(({ exitCode }) => resolve({ exitCode }));
    });

    const waitFor = async (
      predicate: (o: string) => boolean,
      timeoutMs: number,
      label: string,
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(output)) return;
        await delay(30);
      }
      throw new Error(`timed out waiting for: ${label}\n--- tail ---\n${output.slice(-1500)}`);
    };

    // 1. The compiled TUI renders the real interactive session: cursor taken over, status line
    //    shows the live model, the editor prompt is ready.
    await waitFor((o) => o.includes(HIDE_CURSOR), 15_000, 'initial render');
    await waitFor((o) => o.includes('qwen3.7-max'), 15_000, 'live status line');
    await waitFor((o) => o.includes('❯'), 15_000, 'editor prompt');

    // 2. Type a prompt and submit it.
    const marker = output.length;
    term.write('Reply with exactly one short sentence.');
    await delay(250);
    term.write(ENTER);

    // 3. A real streaming response arrives from the live model and lands in the transcript.
    await waitFor(
      (o) => o.length > marker + 200 && /assistant/i.test(o.slice(marker)),
      120_000,
      'streamed assistant response from qwen3.7-max',
    );

    // 4. SIGINT restores the terminal cleanly (cursor shown, exit 0).
    process.kill(term.pid, 'SIGINT');
    const result = await Promise.race([
      exited,
      delay(15_000).then(() => {
        term.kill();
        throw new Error('process did not exit after SIGINT');
      }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(output).toContain(SHOW_CURSOR);

    // No secret leaked into the rendered stream.
    expect(output).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  }, 180_000);
});
