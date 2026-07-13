import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandSocketClient, CommandSocketServer, type ServerFrame } from '../../src/index.ts';

describe('command socket protocol (SS-08)', () => {
  let dir: string;
  let sockPath: string;
  let server: CommandSocketServer;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-sock-'));
    sockPath = join(dir, 'daemon.sock');
  });
  afterEach(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a client handshakes and round-trips a command to an event over a REAL unix socket', async () => {
    const received: unknown[] = [];
    server = new CommandSocketServer(sockPath, {
      onCommand: (command, send) => {
        received.push(command);
        // Echo an event back — a real daemon would route to the runtime and stream events.
        send({ kind: 'event', event: { type: 'ack', of: command } });
      },
    });
    await server.listen();

    const frames: ServerFrame[] = [];
    const client = new CommandSocketClient(sockPath);
    const { daemonPid } = await client.connect('test-tui', (f) => frames.push(f));
    expect(daemonPid).toBe(process.pid);

    client.send({ type: 'start-turn', text: 'hello' });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([{ type: 'start-turn', text: 'hello' }]);
    expect(frames.some((f) => f.kind === 'event')).toBe(true);
    client.close();
  });

  it('rejects a client whose protocol version does not match', async () => {
    server = new CommandSocketServer(sockPath, { onCommand: () => {} });
    await server.listen();

    // Manually send a hello with the wrong version.
    const { createConnection } = await import('node:net');
    const rejected = await new Promise<string>((resolve) => {
      const sock = createConnection(sockPath, () => {
        sock.write(
          JSON.stringify({ kind: 'hello', hello: { protocolVersion: 999, clientName: 'x' } }) +
            '\n',
        );
      });
      sock.on('data', (d) => {
        const frame = JSON.parse(d.toString().trim()) as ServerFrame;
        resolve(frame.kind);
        sock.destroy();
      });
    });
    expect(rejected).toBe('hello-reject');
  });
});
