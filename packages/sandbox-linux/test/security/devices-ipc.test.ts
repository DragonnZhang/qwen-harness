/**
 * Device and IPC confinement — asserted against REAL bubblewrap behavior, never against argv.
 *
 * `bwrap-argv.test.ts` proves the backend EMITS `--dev` and `--unshare-ipc`. That is necessary but
 * not sufficient: a flag in an argv string proves nothing about what the kernel actually did. These
 * tests spawn a real process inside the sandbox and OBSERVE that
 *   - `/dev` is the minimal whitelisted set (no host block/memory devices are reachable), and
 *   - the process lives in its own IPC namespace (a different `ipc:[…]` inode than the host), so
 *     host System V IPC objects and host `/dev/shm` contents are invisible to it.
 * If any of these is NOT confined, that is a real escape and the test fails loudly.
 */

import { execFileSync } from 'node:child_process';
import { readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BubblewrapBackend } from '../../src/backend.ts';
import { CAP, NODE, SH, makeWorkspace, specFor, type Workspace } from './helpers.ts';

const backend = new BubblewrapBackend(() => Date.now());
let ws: Workspace;

beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

// A guard so a host that lost bwrap fails loudly here too, never skips.
it('bubblewrap is available on this host (precondition for the device/IPC suite)', () => {
  expect(CAP.available).toBe(true);
});

// The ONLY device names the bwrap `--dev` policy is allowed to expose. Anything the sandbox lists
// that is not in this set is an unexpected leak of a host device and must fail the subset check.
// (These are the synthetic/pseudo devices a minimal devtmpfs provides — never a block device like
// sda, never /dev/mem, never /dev/kmsg.)
const ALLOWED_DEV = new Set([
  'null',
  'zero',
  'full',
  'random',
  'urandom',
  'tty',
  'console',
  'ptmx',
  'pts',
  'shm',
  'fd',
  'stdin',
  'stdout',
  'stderr',
  'core',
]);

// Host device nodes a confined process must NOT be able to open. A raw disk, physical memory, the
// kernel log, and I/O ports are the canonical "if you can read this the sandbox is broken" targets.
const SENSITIVE_DEVICES = [
  '/dev/sda',
  '/dev/sdb',
  '/dev/vda',
  '/dev/mem',
  '/dev/kmsg',
  '/dev/port',
];

interface DevProbe {
  readonly dev: string[];
  readonly sensitive: Record<string, string>;
  readonly ipcns: string;
}

describe('device confinement (SB-02, S/I — the argv replacement)', () => {
  it('exposes only the minimal whitelisted /dev, and no sensitive host device is openable', async () => {
    const script = `
      const fs = require('fs');
      const dev = fs.readdirSync('/dev').sort();
      const probe = (p) => {
        try { const fd = fs.openSync(p, 'r'); fs.closeSync(fd); return 'OPENED'; }
        catch (e) { return e.code; }
      };
      const sensitive = {};
      for (const p of ${JSON.stringify(SENSITIVE_DEVICES)}) sensitive[p] = probe(p);
      console.log(JSON.stringify({ dev, sensitive, ipcns: fs.readlinkSync('/proc/self/ns/ipc') }));
    `;
    const r = await backend.run(specFor(ws, { command: NODE, args: ['-e', script] }));
    expect(r.exitCode, r.stderr).toBe(0);

    const probe = JSON.parse(r.stdout.trim()) as DevProbe;

    // Every entry the sandbox exposes is in the whitelist — no host device leaked through --dev.
    const unexpected = probe.dev.filter((d) => !ALLOWED_DEV.has(d));
    expect(
      unexpected,
      `unexpected /dev entries leaked into the sandbox: ${unexpected.join(', ')}`,
    ).toEqual([]);

    // The safe pseudo-devices a program legitimately needs really are present.
    for (const needed of ['null', 'zero', 'urandom', 'tty']) {
      expect(probe.dev).toContain(needed);
    }

    // No block/memory/kernel device is even present, let alone readable. bwrap's minimal /dev never
    // creates these, so open() returns ENOENT — absence, the strongest possible confinement.
    for (const p of SENSITIVE_DEVICES) {
      expect(
        probe.sensitive[p],
        `${p} was openable inside the sandbox — REAL DEVICE ESCAPE`,
      ).not.toBe('OPENED');
      expect(probe.sensitive[p]).toBe('ENOENT');
    }
  });
});

describe('IPC confinement (SB-02, S/I — the argv replacement)', () => {
  it('runs in a DIFFERENT IPC namespace than the host', async () => {
    // The definitional proof of --unshare-ipc: the child's ipc namespace inode differs from the
    // host's. Read the host's live (not a hardcoded value) so this tracks whatever host runs it.
    const hostIpcNs = readlinkSync('/proc/self/ns/ipc');

    const r = await backend.run(
      specFor(ws, {
        command: NODE,
        args: ['-e', "process.stdout.write(require('fs').readlinkSync('/proc/self/ns/ipc'))"],
      }),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const sandboxIpcNs = r.stdout.trim();

    expect(sandboxIpcNs).toMatch(/^ipc:\[\d+\]$/);
    expect(hostIpcNs).toMatch(/^ipc:\[\d+\]$/);
    expect(
      sandboxIpcNs,
      `sandbox shares the host IPC namespace (${hostIpcNs}) — IPC IS NOT ISOLATED`,
    ).not.toBe(hostIpcNs);
  });

  it('cannot see a host System V message queue (empty ipcs inside the isolated namespace)', async () => {
    // Create a real System V message queue on the HOST, then prove a process inside the sandbox's
    // IPC namespace cannot observe it. If the sandbox shared the host IPC namespace, `ipcs -q`
    // inside would list this queue.
    let qid: string | null = null;
    try {
      const out = execFileSync('ipcmk', ['-Q'], { encoding: 'utf8' });
      const m = out.match(/(\d+)\s*$/);
      expect(m, `ipcmk did not report a queue id: ${out}`).not.toBeNull();
      qid = (m as RegExpMatchArray)[1];

      // Sanity: the host really does see the queue we just made.
      const hostView = execFileSync('ipcs', ['-q'], { encoding: 'utf8' });
      expect(hostView).toMatch(new RegExp(`\\b${qid}\\b`));

      const r = await backend.run(specFor(ws, { command: SH, args: ['-c', 'ipcs -q'] }));
      expect(r.exitCode, r.stderr).toBe(0);
      // The isolated namespace has no message queues at all — certainly not the host's.
      expect(r.stdout, `sandbox saw host SysV queue ${qid} — IPC NAMESPACE ESCAPE`).not.toMatch(
        new RegExp(`\\b${qid}\\b`),
      );
    } finally {
      if (qid !== null) execFileSync('ipcrm', ['-q', qid]);
    }
  });

  it('cannot see host /dev/shm contents (private shared-memory tmpfs)', async () => {
    // Plant a file in the HOST's /dev/shm. A shared /dev/shm would let the sandbox read it; the
    // sandbox's private tmpfs means the path simply does not exist inside.
    const marker = `/dev/shm/qh-ipc-probe-${randomUUID()}`;
    writeFileSync(marker, 'HOST-SHM-SECRET\n');
    try {
      const r = await backend.run(
        specFor(ws, {
          command: NODE,
          args: [
            '-e',
            `try{const d=require('fs').readFileSync(${JSON.stringify(marker)},'utf8');console.log(d.includes('SECRET')?'LEAKED':'EMPTY')}catch(e){console.log(e.code)}`,
          ],
        }),
      );
      expect(
        r.stdout.trim(),
        'host /dev/shm content was readable inside the sandbox — SHM ESCAPE',
      ).not.toBe('LEAKED');
      expect(r.stdout.trim()).toBe('ENOENT');
    } finally {
      rmSync(marker, { force: true });
    }
  });
});
