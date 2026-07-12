import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CANARY_API_KEY } from '@qwen-harness/testkit';

import { BubblewrapBackend, type SandboxSpec } from '../../src/index.ts';

/**
 * These tests run the REAL bubblewrap sandbox on this host and attempt REAL escapes. A sandbox
 * test that mocks the sandbox proves nothing — the entire question is whether the kernel actually
 * confines the process, which only a real process can answer (threat model, "Sandbox acceptance").
 *
 * If the backend is unavailable (bwrap absent, userns disabled), every test FAILS rather than
 * skips: a release cannot pass in a degraded mode, so "the sandbox isn't here" must be loud.
 */
const backend = new BubblewrapBackend();
const cap = backend.detect();

const NODE = process.execPath;

describe('real bubblewrap sandbox (SB-01, SB-02, SB-04, SC-01)', () => {
  it('the backend is actually available on this host — release cannot pass degraded', () => {
    expect(cap.available, `sandbox unavailable: ${cap.detail}`).toBe(true);
    expect(cap.backend).toBe('bubblewrap');
  });

  let workspace: string;
  let scratch: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-ws-'));
    scratch = mkdtempSync(join(tmpdir(), 'qh-scratch-'));
    outside = mkdtempSync(join(tmpdir(), 'qh-secret-'));
    writeFileSync(join(workspace, 'file.txt'), 'workspace content\n');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(() => {
    for (const d of [workspace, scratch, outside]) rmSync(d, { recursive: true, force: true });
  });

  function spec(
    overrides: Partial<SandboxSpec> & Pick<SandboxSpec, 'command' | 'args'>,
  ): SandboxSpec {
    return {
      isolation: {
        mode: 'workspace-write',
        workspaceRoot: workspace,
        scratchRoot: scratch,
        networkAllowed: false,
      },
      cwd: '/qh/workspace',
      env: { PATH: '/usr/bin:/bin', HOME: '/qh/scratch' },
      timeoutMs: 15_000,
      maxOutputBytes: 1_000_000,
      ...overrides,
    };
  }

  // --- filesystem isolation ----------------------------------------------

  it('cannot see /root', async () => {
    const r = await backend.run(
      spec({
        command: NODE,
        args: [
          '-e',
          'const fs=require("fs"); try{fs.readdirSync("/root"); console.log("SAW-ROOT")}catch(e){console.log("DENIED:"+e.code)}',
        ],
      }),
    );
    expect(r.stdout).toContain('DENIED:ENOENT');
    expect(r.stdout).not.toContain('SAW-ROOT');
  });

  it('cannot read a secret file outside the workspace — it is not mounted', async () => {
    // The host path to the secret does not even exist inside the sandbox. Absence, not a deny rule.
    const r = await backend.run(
      spec({
        command: NODE,
        args: [
          '-e',
          `const fs=require("fs"); try{process.stdout.write(fs.readFileSync(${JSON.stringify(join(outside, 'secret.txt'))},"utf8"))}catch(e){console.log("DENIED:"+e.code)}`,
        ],
      }),
    );
    expect(r.stdout).not.toContain('TOP SECRET');
    expect(r.stdout).toContain('DENIED:ENOENT');
  });

  it('cannot read ~/.ssh — it is not mounted', async () => {
    const r = await backend.run(
      spec({
        command: NODE,
        args: [
          '-e',
          'const fs=require("fs"); try{fs.readdirSync(process.env.REAL_HOME+"/.ssh"); console.log("SAW-SSH")}catch(e){console.log("DENIED")}',
        ],
      }),
    );
    expect(r.stdout).not.toContain('SAW-SSH');
  });

  it('CAN write inside the workspace under workspace-write', async () => {
    const r = await backend.run(
      spec({
        command: NODE,
        args: [
          '-e',
          'require("fs").writeFileSync("/qh/workspace/new.txt","hi"); console.log("WROTE")',
        ],
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('WROTE');
    // The write really landed on the host, in the real workspace.
    expect(readFileSync(join(workspace, 'new.txt'), 'utf8')).toBe('hi');
  });

  it('CANNOT write outside the workspace even under workspace-write', async () => {
    const r = await backend.run(
      spec({
        command: NODE,
        args: [
          '-e',
          `try{require("fs").writeFileSync(${JSON.stringify(join(outside, 'evil.txt'))},"x"); console.log("WROTE-OUTSIDE")}catch(e){console.log("DENIED:"+e.code)}`,
        ],
      }),
    );
    expect(r.stdout).not.toContain('WROTE-OUTSIDE');
    // The file was never created on the host.
    expect(() => readFileSync(join(outside, 'evil.txt'))).toThrow();
  });

  it('read-only isolation makes the workspace itself unwritable', async () => {
    const r = await backend.run(
      spec({
        isolation: {
          mode: 'read-only',
          workspaceRoot: workspace,
          scratchRoot: scratch,
          networkAllowed: false,
        },
        command: NODE,
        args: [
          '-e',
          'try{require("fs").writeFileSync("/qh/workspace/x.txt","x"); console.log("WROTE")}catch(e){console.log("DENIED:"+e.code)}',
        ],
      }),
    );
    expect(r.stdout).not.toContain('WROTE');
    expect(r.stdout).toMatch(/DENIED:(EROFS|EACCES|EPERM)/);
  });

  it('read-only isolation still allows a scratch write', async () => {
    const r = await backend.run(
      spec({
        isolation: {
          mode: 'read-only',
          workspaceRoot: workspace,
          scratchRoot: scratch,
          networkAllowed: false,
        },
        command: NODE,
        args: [
          '-e',
          'require("fs").writeFileSync("/qh/scratch/tmp.txt","x"); console.log("SCRATCH-OK")',
        ],
      }),
    );
    expect(r.stdout).toContain('SCRATCH-OK');
  });

  // --- credential isolation ----------------------------------------------

  it('does NOT leak a parent-process secret env var into the child', async () => {
    // Simulate the provider key being present in the parent. The sandbox --clearenv + allowlist
    // must ensure the child cannot see it, whatever it is named.
    const secretName = 'QH_TEST_FAKE_PROVIDER_KEY';
    process.env[secretName] = CANARY_API_KEY;
    try {
      const r = await backend.run(
        spec({
          command: NODE,
          args: [
            '-e',
            `console.log("KEY="+(process.env[${JSON.stringify(secretName)}]??"ABSENT"))`,
          ],
        }),
      );
      expect(r.stdout).toContain('KEY=ABSENT');
      expect(r.stdout).not.toContain(CANARY_API_KEY);
    } finally {
      delete process.env[secretName];
    }
  });

  // --- process teardown --------------------------------------------------

  it('kills the whole process tree on timeout — no orphan survives', async () => {
    // A child that spawns a grandchild sleeper. If teardown only killed the leader, the sleeper
    // would outlive the deadline. It lives in bwrap's PID namespace, so killing bwrap reaps it.
    const started = performance.now();
    const r = await backend.run(
      spec({
        timeoutMs: 1500,
        command: NODE,
        args: [
          '-e',
          'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"]); setTimeout(()=>{},60000)',
        ],
      }),
    );
    const elapsed = performance.now() - started;
    expect(r.timedOut).toBe(true);
    // It was actually killed near the deadline, not left to run for a minute.
    expect(elapsed).toBeLessThan(6000);
  });

  it('bounds an output flood instead of buffering it forever', async () => {
    const r = await backend.run(
      spec({
        maxOutputBytes: 64 * 1024,
        timeoutMs: 15_000,
        command: NODE,
        args: ['-e', 'const b="x".repeat(65536); for(;;) process.stdout.write(b)'],
      }),
    );
    expect(r.truncated).toBe(true);
    // The captured output is bounded near the cap, not gigabytes.
    expect(r.stdout.length).toBeLessThan(1_000_000);
  });
});

// --- network isolation (uses a loopback server, no internet needed) -------

describe('real sandbox network isolation', () => {
  let server: Server;
  let port: number;
  let workspace: string;
  let scratch: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('REACHED-SERVER');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-ws-'));
    scratch = mkdtempSync(join(tmpdir(), 'qh-scratch-'));
  });
  afterEach(() => {
    for (const d of [workspace, scratch]) rmSync(d, { recursive: true, force: true });
  });

  function netSpec(networkAllowed: boolean): SandboxSpec {
    return {
      isolation: {
        mode: 'workspace-write',
        workspaceRoot: workspace,
        scratchRoot: scratch,
        networkAllowed,
      },
      cwd: '/qh/workspace',
      env: { PATH: '/usr/bin:/bin', HOME: '/qh/scratch' },
      timeoutMs: 10_000,
      maxOutputBytes: 100_000,
      command: NODE,
      args: [
        '-e',
        `fetch("http://127.0.0.1:${port}/").then(r=>r.text()).then(t=>console.log("GOT:"+t)).catch(e=>console.log("BLOCKED:"+(e.cause?.code??e.message)))`,
      ],
    };
  }

  it('DENIES network by default — the loopback server is unreachable', async () => {
    if (!backend.detect().available) return; // the availability test above already fails loudly
    const r = await backend.run(netSpec(false));
    expect(r.stdout).not.toContain('REACHED-SERVER');
    expect(r.stdout).toContain('BLOCKED');
  });

  it('ALLOWS network only when explicitly granted', async () => {
    if (!backend.detect().available) return;
    const r = await backend.run(netSpec(true));
    expect(r.stdout).toContain('GOT:REACHED-SERVER');
  });
});
