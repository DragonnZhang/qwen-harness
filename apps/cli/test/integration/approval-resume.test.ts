import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ThreadId } from '@qwen-harness/protocol';
import type { ProviderStreamEvent } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findPendingApproval } from '../../src/sessions.ts';

/**
 * The cross-process proof (SS-04).
 *
 * Process A starts a turn, hits an action that needs approval, and is KILLED (SIGKILL) while the
 * prompt is on screen. It gets no chance to clean up, write a summary, or end the turn.
 *
 * Process B — a genuinely separate OS process — then resumes that session, is asked the same
 * question, answers `y`, and the SAME turn finishes. The turn id does not change, no second turn is
 * started, and the tool finally runs. The only thing carrying the pending approval across the gap
 * is the durable event log, which is the entire point: an event-sourced system whose approvals
 * lived in memory would be lying about what it can recover.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const FIXTURE = join(REPO, 'apps', 'cli', 'test', 'fixtures', 'scripted-cli.ts');

const shellCall = (callId: string, marker: string): ProviderStreamEvent => {
  const args = {
    command: '/usr/bin/env',
    argv: ['node', '-e', `require('fs').writeFileSync('${marker}', 'ran')`],
    cwd: '.',
  };
  return {
    type: 'tool-call-complete',
    itemId: `it_${callId}`,
    callId,
    toolName: 'run_shell',
    argumentsJson: JSON.stringify(args),
    arguments: args,
  };
};

interface Run {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exit: Promise<number>;
}

function spawnCli(workspace: string, scriptPath: string, args: readonly string[]): Run {
  const child = spawn(TSX, [FIXTURE, ...args], {
    cwd: workspace,
    env: { ...process.env, QH_SCRIPT: scriptPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exit: new Promise<number>((res) => child.on('exit', (code) => res(code ?? -1))),
  };
}

function openStore(workspace: string): EventStore {
  return new EventStore({
    path: join(workspace, '.qwen-harness', 'sessions.sqlite'),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    ids: new SequentialIds(),
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Wait until the durable log says the turn is parked on an approval. */
async function waitForPendingApproval(workspace: string, timeoutMs = 30_000): Promise<ThreadId> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(join(workspace, '.qwen-harness', 'sessions.sqlite'))) {
      const store = openStore(workspace);
      try {
        for (const thread of store.listThreads()) {
          if (findPendingApproval(store, thread.id) !== null) return thread.id;
        }
      } finally {
        store.close();
      }
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for a pending approval');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('a pending approval survives the death of the process that asked', () => {
  let workspace: string;
  let scriptA: string;
  let scriptB: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-xproc-'));
    scriptA = join(workspace, 'script-a.json');
    scriptB = join(workspace, 'script-b.json');
    // Process A's model: ask to run a shell command. (It never gets a second round — it is killed.)
    writeFileSync(
      scriptA,
      JSON.stringify([
        [shellCall('call_shell001', 'marker.txt'), { type: 'done', finishReason: 'tool_calls' }],
      ]),
    );
    // Process B's model: after the approved tool result comes back, wrap up.
    writeFileSync(
      scriptB,
      JSON.stringify([
        [
          { type: 'text-done', itemId: 'm', text: 'The command ran after you approved it.' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]),
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('a second process resumes the SAME turn and finishes it', async () => {
    // --- process A: runs until it needs an approval, then dies without answering ---------------
    const a = spawnCli(workspace, scriptA, ['run', '--profile', 'ask', 'create the marker file']);
    const threadId = await waitForPendingApproval(workspace);

    // It really is waiting on the human: the prompt reaches the terminal (a pipe flushes it a
    // moment after the event is durable — the log is written FIRST, on purpose), and nothing ran.
    await waitFor(() => a.stdout().includes('permission required'));
    expect(a.stdout()).toContain('/usr/bin/env');
    expect(existsSync(join(workspace, 'marker.txt'))).toBe(false);

    a.child.kill('SIGKILL');
    await a.exit;

    // What the log knows, with process A gone.
    const before = openStore(workspace);
    const pending = findPendingApproval(before, threadId);
    const turnsBefore = before
      .readThread(threadId)
      .filter((e) => e.payload.type === 'turn-started').length;
    const originalTurnId = pending?.turnId;
    before.close();

    expect(pending).not.toBeNull();
    expect(pending?.pendingCalls.map((c) => c.toolName)).toEqual(['run_shell']);
    expect(turnsBefore).toBe(1);

    // --- process B: a NEW process resumes the same session and answers ------------------------
    const b = spawnCli(workspace, scriptB, ['resume', threadId]);
    b.child.stdin?.write('y\n');
    const codeB = await b.exit;

    expect(b.stdout(), b.stderr()).toContain('permission required');
    expect(codeB, `${b.stdout()}\n${b.stderr()}`).toBe(0);

    // The tool ran — in the real sandbox, in the second process.
    expect(existsSync(join(workspace, 'marker.txt'))).toBe(true);

    const after = openStore(workspace);
    try {
      const events = after.readThread(threadId);
      const starts = events.filter((e) => e.payload.type === 'turn-started');

      // THE invariant: the approval resumed the same turn. It did not start a new one, and no new
      // user message was appended for it.
      expect(starts).toHaveLength(1);
      expect(starts[0]?.turnId).toBe(originalTurnId);

      const ended = events.filter((e) => e.payload.type === 'turn-ended');
      expect(ended).toHaveLength(1);
      expect(ended[0]?.turnId).toBe(originalTurnId);
      expect(ended[0]?.payload).toMatchObject({ state: 'completed', reason: 'natural-completion' });

      // The approval was requested in one process and answered in another, for the same call.
      const requested = events.filter((e) => e.payload.type === 'approval-requested');
      const resolved = events.filter((e) => e.payload.type === 'approval-resolved');
      expect(requested.length).toBeGreaterThanOrEqual(1);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.turnId).toBe(originalTurnId);
      expect(resolved[0]?.payload).toMatchObject({ granted: true });

      // And the tool result is durable, paired to the original call id.
      const results = events
        .map((e) => e.payload)
        .filter((p) => p.type === 'item-appended' && p.item.type === 'tool-result');
      expect(results).toHaveLength(1);

      expect(findPendingApproval(after, threadId)).toBeNull();
    } finally {
      after.close();
    }
  }, 60_000);

  it('a non-interactive run never auto-approves: it parks the turn and exits 3', async () => {
    const run = spawnCli(workspace, scriptA, [
      'run',
      '--profile',
      'ask',
      '--json',
      'create the marker file',
    ]);
    run.child.stdin?.end();
    const code = await run.exit;

    expect(code, run.stderr()).toBe(3);
    const report = JSON.parse(run.stdout().trim()) as {
      state: string;
      pendingApproval: { toolName: string } | null;
    };
    expect(report.state).toBe('awaiting-approval');
    expect(report.pendingApproval?.toolName).toBe('run_shell');
    expect(existsSync(join(workspace, 'marker.txt'))).toBe(false);

    // Parked, not lost: the log still holds the request, so a human can pick it up later.
    const store = openStore(workspace);
    try {
      const thread = store.listThreads()[0];
      expect(thread).toBeDefined();
      expect(findPendingApproval(store, thread!.id)).not.toBeNull();
    } finally {
      store.close();
    }
  }, 60_000);
});
