/**
 * Network confinement against a REAL loopback server started by the test — no internet needed.
 *
 * Denied-by-default must actually stop a connection, and a granted network must actually allow one.
 * Asserting on `--unshare-net` in the argv would prove nothing about the kernel; these tests prove
 * it against a live socket.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BubblewrapBackend } from '../../src/backend.ts';
import { NODE, SANDBOX_WORKSPACE, makeWorkspace, specFor, type Workspace } from './helpers.ts';

const backend = new BubblewrapBackend(() => Date.now());
let server: Server;
let port: number;
let ws: Workspace;

beforeAll(async () => {
  server = createServer((_req, res) => res.end('pong'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server port');
  port = addr.port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

/** A tiny fetch script that prints the body on success or the error code on failure. */
function fetchScript(): string {
  return join(SANDBOX_WORKSPACE, 'fetch.js');
}

function writeFetchScript(w: Workspace, targetPort: number): void {
  const script = `
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port: ${targetPort}, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { console.log('OK:' + body); process.exit(0); });
    });
    req.on('error', (e) => { console.log('ERR:' + e.code); process.exit(0); });
    req.on('timeout', () => { console.log('ERR:TIMEOUT'); req.destroy(); });
  `;
  writeFileSync(join(w.workspace, 'fetch.js'), script);
}

describe('network is denied by default', () => {
  it('a connection to the loopback server FAILS when network is not granted', async () => {
    writeFetchScript(ws, port);
    const result = await backend.run(
      specFor(ws, { command: NODE, args: [fetchScript()], networkAllowed: false }),
    );
    expect(result.stdout).not.toContain('OK:pong');
    expect(result.stdout).toMatch(
      /ERR:(ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|TIMEOUT|EADDRNOTAVAIL)/,
    );
  });
});

describe('network works when granted', () => {
  it('the same connection SUCCEEDS when network is granted', async () => {
    writeFetchScript(ws, port);
    const result = await backend.run(
      specFor(ws, { command: NODE, args: [fetchScript()], networkAllowed: true }),
    );
    expect(result.stdout.trim()).toBe('OK:pong');
  });
});
