/**
 * Integration/failure: HTTP/SSE reconnect vs. stdio no-auto-restart (MC-06, defaults.md).
 *
 * The HTTP transport reconnects with bounded backoff when its SSE stream drops — driven by an
 * injected fake gateway and a ManualClock so the backoff is observed, not slept through. Stdio does
 * the OPPOSITE: a child that exits is NOT respawned unless the config opts in.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualClock } from '@qwen-harness/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HttpTransport,
  StdioTransport,
  type HttpGateway,
  type SseConnection,
  type SseHandlers,
} from '../../src/index.ts';

class FakeGateway implements HttpGateway {
  openCount = 0;
  #handlers: SseHandlers | null = null;

  send(): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return Promise.resolve({ status: 200, headers: {}, body: '' });
  }
  openSse(_req: unknown, handlers: SseHandlers): Promise<SseConnection> {
    this.openCount += 1;
    this.#handlers = handlers;
    return Promise.resolve({ lastEventId: null, close: () => undefined });
  }
  dropStream(err: Error): void {
    this.#handlers?.onClose(err);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('HTTP/SSE reconnect with bounded backoff (MC-06)', () => {
  it('reconnects after a drop only once the backoff has elapsed', async () => {
    const clock = new ManualClock(0);
    const gateway = new FakeGateway();
    const transport = new HttpTransport({
      url: 'https://srv/mcp',
      gateway,
      clock,
      random01: () => 0.5,
    });

    await transport.start();
    expect(gateway.openCount).toBe(1);

    gateway.dropStream(new Error('stream dropped'));
    await flush();
    // The reconnect is SCHEDULED, not immediate — it waits for the backoff.
    expect(gateway.openCount).toBe(1);

    clock.advance(30_000); // elapse well past the first backoff ceiling
    await flush();
    expect(gateway.openCount).toBe(2);

    await transport.close();
  });
});

describe('stdio does NOT auto-restart (MC-06)', () => {
  let dir: string;
  let marker: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-mcp-restart-'));
    marker = join(dir, 'starts.log');
    script = join(dir, 'exiting-server.cjs');
    writeFileSync(marker, '', 'utf8');
    // Records one line every time it STARTS, then exits shortly after. If the transport restarted
    // it, the marker would grow a second line.
    writeFileSync(
      script,
      `require('fs').appendFileSync(${JSON.stringify(marker)}, 'start\\n'); setTimeout(() => process.exit(0), 50);`,
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a child that exits is not respawned', async () => {
    const transport = new StdioTransport({ command: process.execPath, args: [script] });
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    await transport.start();

    // Wait until the child has exited (its close handler fired), then give any (buggy) restart a
    // window to happen.
    const startedAt = Date.now();
    while (!closed && Date.now() - startedAt < 5_000) await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    // Started exactly once — no automatic restart.
    expect(readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length).toBe(1);
    await transport.close();
  });
});
