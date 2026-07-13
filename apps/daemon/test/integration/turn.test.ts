import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { HarnessEvent, PermissionProfile, ThreadId } from '@qwen-harness/protocol';
import { authorityForProfile } from '@qwen-harness/cli';
import {
  freezeCapabilities,
  type ModelProvider,
  type ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { SequentialIds } from '@qwen-harness/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { Daemon } from '../../src/daemon.ts';
import { CommandSocketClient, type ServerFrame } from '../../src/socket-protocol.ts';

/**
 * The daemon driving a REAL turn (SS-08, RT-06).
 *
 * One writer (the lease), many observers (the socket). The model is scripted; the policy engine,
 * the sandboxed tool worker, the event store and the state machine are the production ones. What
 * these tests prove is that the socket is not a demo surface: a prompt over it starts a real turn,
 * an approval over it resumes THAT turn, and a cancel over it really kills the process group of the
 * tool that is running.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const DAEMON_BIN = join(REPO, 'apps', 'daemon', 'src', 'bin.ts');

function scriptedProvider(rounds: ProviderStreamEvent[][]): ModelProvider {
  let i = 0;
  return {
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: true,
      reasoningEffortGranularity: 'graded',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream() {
      const round = rounds[i++] ?? [{ type: 'done', finishReason: 'stop' }];
      for (const event of round) yield event;
    },
  };
}

function shellCall(callId: string, argv: readonly string[]): ProviderStreamEvent {
  const args = { command: '/usr/bin/env', argv: [...argv], cwd: '.' };
  return {
    type: 'tool-call-complete',
    itemId: `it_${callId}`,
    callId,
    toolName: 'run_shell',
    argumentsJson: JSON.stringify(args),
    arguments: args,
  };
}

const done = (text: string): ProviderStreamEvent[] => [
  { type: 'text-done', itemId: 'm', text },
  { type: 'done', finishReason: 'stop' },
];

/** A connected observer. Records every frame the daemon pushes. */
class Observer {
  readonly frames: ServerFrame[] = [];
  readonly #client: CommandSocketClient;

  constructor(socketPath: string) {
    this.#client = new CommandSocketClient(socketPath);
  }

  async attach(name: string): Promise<void> {
    await this.#client.connect(name, (frame) => this.frames.push(frame));
  }

  send(command: unknown): void {
    this.#client.send(command);
  }

  close(): void {
    this.#client.close();
  }

  events(): HarnessEvent[] {
    return this.frames
      .filter((f) => f.kind === 'event')
      .map((f) => (f.kind === 'event' ? (f.event as HarnessEvent) : null))
      .filter((e): e is HarnessEvent => e !== null);
  }

  async waitFor<T extends ServerFrame['kind']>(
    kind: T,
    timeoutMs = 30_000,
  ): Promise<Extract<ServerFrame, { kind: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find((f) => f.kind === kind);
      if (found !== undefined) return found as Extract<ServerFrame, { kind: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for a ${kind} frame`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

interface Harness {
  readonly daemon: Daemon;
  readonly socketPath: string;
  readonly leasePath: string;
  readonly workspace: string;
}

const started: Harness[] = [];
const observers: Observer[] = [];

async function startDaemon(opts: {
  rounds: ProviderStreamEvent[][];
  profile: PermissionProfile;
}): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'qh-daemon-'));
  const socketPath = join(workspace, 'daemon.sock');
  const leasePath = join(workspace, 'daemon.lease');
  const daemon = await Daemon.start({
    socketPath,
    leasePath,
    statePath: join(workspace, 'sessions.sqlite'),
    workspaceRoot: workspace,
    homeDir: '/home/nonexistent',
    authority: authorityForProfile(opts.profile),
    model: 'scripted',
    instructions: 'be careful',
    clock: { now: () => Date.now() },
    ids: new SequentialIds(),
    provider: scriptedProvider(opts.rounds),
  });
  const harness = { daemon, socketPath, leasePath, workspace };
  started.push(harness);
  return harness;
}

async function attach(harness: Harness, name: string): Promise<Observer> {
  const observer = new Observer(harness.socketPath);
  await observer.attach(name);
  observers.push(observer);
  return observer;
}

/** The thread id the daemon minted, learned the way a real client learns it: from the log. */
async function createThread(observer: Observer): Promise<ThreadId> {
  observer.send({ type: 'create-thread', cwd: '.', name: null });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const created = observer.events().find((e) => e.payload.type === 'thread-created');
    if (created !== undefined) return created.threadId;
    if (Date.now() > deadline) throw new Error('the daemon never created a thread');
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  for (const observer of observers.splice(0)) observer.close();
  for (const harness of started.splice(0)) {
    await harness.daemon.stop();
    rmSync(harness.workspace, { recursive: true, force: true });
  }
});

describe('the daemon socket drives a real turn', () => {
  it('an approval round-trips over the socket and resumes the SAME turn', async () => {
    const harness = await startDaemon({
      profile: 'ask',
      rounds: [
        [
          shellCall('call_shell001', [
            'node',
            '-e',
            "require('fs').writeFileSync('approved.txt','ran')",
          ]),
          { type: 'done', finishReason: 'tool_calls' },
        ],
        done('I ran it.'),
      ],
    });

    // TWO clients observe the same session. Only the daemon writes.
    const alice = await attach(harness, 'alice');
    const bob = await attach(harness, 'bob');

    const threadId = await createThread(alice);
    alice.send({ type: 'start-turn', threadId, text: 'create the marker file' });

    // The daemon asks — and BOTH observers see the question, with the exact action.
    const asked = await alice.waitFor('approval-request');
    const askedBob = await bob.waitFor('approval-request');
    expect(asked.request.toolName).toBe('run_shell');
    expect(asked.request.description).toContain('/usr/bin/env');
    expect(asked.request.risk).toBe('high');
    expect(askedBob.request.callId).toBe(asked.request.callId);

    // Nothing has run while the question is open.
    expect(existsSync(join(harness.workspace, 'approved.txt'))).toBe(false);

    // Bob answers. The SAME turn resumes.
    bob.send({
      type: 'approve',
      threadId,
      callId: asked.request.callId,
      granted: true,
      scope: 'once',
    });

    const result = await alice.waitFor('turn-result');
    expect(result.state).toBe('completed');
    expect(result.reason).toBe('natural-completion');
    expect(result.finalText).toContain('I ran it');
    expect(result.turnId).toBe(asked.request.turnId);

    // The real sandbox really ran it.
    expect(existsSync(join(harness.workspace, 'approved.txt'))).toBe(true);

    // One turn. The approval was not a new user message.
    const events = harness.daemon.store.readThread(threadId);
    expect(events.filter((e) => e.payload.type === 'turn-started')).toHaveLength(1);
    expect(events.filter((e) => e.payload.type === 'approval-resolved')).toHaveLength(1);

    // Both observers received the durable stream, not just the one who typed.
    expect(bob.events().length).toBeGreaterThan(5);
    expect(bob.events().some((e) => e.payload.type === 'turn-ended')).toBe(true);
  }, 60_000);

  it('a denial over the socket is fed back to the model, which adapts', async () => {
    const harness = await startDaemon({
      profile: 'ask',
      rounds: [
        [
          shellCall('call_shell002', [
            'node',
            '-e',
            "require('fs').writeFileSync('denied.txt','ran')",
          ]),
          { type: 'done', finishReason: 'tool_calls' },
        ],
        done('Understood, I will not run that.'),
      ],
    });
    const client = await attach(harness, 'cli');
    const threadId = await createThread(client);
    client.send({ type: 'start-turn', threadId, text: 'create the marker file' });

    const asked = await client.waitFor('approval-request');
    client.send({
      type: 'approve',
      threadId,
      callId: asked.request.callId,
      granted: false,
      scope: null,
    });

    const result = await client.waitFor('turn-result');
    expect(result.state).toBe('completed');
    expect(result.finalText).toContain('will not run');
    expect(existsSync(join(harness.workspace, 'denied.txt'))).toBe(false);

    const events = harness.daemon.store.readThread(threadId);
    const resolved = events.find((e) => e.payload.type === 'approval-resolved');
    expect(resolved?.payload).toMatchObject({ granted: false });
    // The refusal is a durable, paired tool RESULT, so the model saw it in band.
    const denial = events
      .map((e) => e.payload)
      .find((p) => p.type === 'item-appended' && p.item.type === 'tool-result');
    expect(denial?.type === 'item-appended' ? denial.item : null).toMatchObject({
      ok: false,
      errorCategory: 'user-denied',
    });
  }, 60_000);

  it('a cancel over the socket kills the running tool and ends the turn with a reason', async () => {
    const harness = await startDaemon({
      // `yolo` so the tool starts immediately: this test is about cancellation, not approval.
      profile: 'yolo',
      rounds: [
        [
          shellCall('call_shell003', [
            'node',
            '-e',
            "setTimeout(() => require('fs').writeFileSync('slow.txt','ran'), 20000)",
          ]),
          { type: 'done', finishReason: 'tool_calls' },
        ],
        done('finished'),
      ],
    });
    const client = await attach(harness, 'cli');
    const threadId = await createThread(client);
    client.send({ type: 'start-turn', threadId, text: 'run the slow command' });

    // Wait until the side effect has actually STARTED — we want to cancel a live process, not a
    // plan to start one.
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (
        harness.daemon.store
          .readThread(threadId)
          .some((e) => e.payload.type === 'side-effect-started')
      )
        break;
      if (Date.now() > deadline) throw new Error('the tool never started');
      await new Promise((r) => setTimeout(r, 25));
    }

    const cancelledAt = Date.now();
    client.send({ type: 'interrupt', threadId });

    const result = await client.waitFor('turn-result');
    const elapsed = Date.now() - cancelledAt;

    // The turn ENDED, and it named why. It did not merely stop.
    expect(result.state).toBe('cancelled');
    expect(result.reason).toBe('user-cancelled');
    // The 20s sleep did not run to completion: the whole process group went with the cancel.
    expect(elapsed).toBeLessThan(15_000);
    expect(existsSync(join(harness.workspace, 'slow.txt'))).toBe(false);

    const events = harness.daemon.store.readThread(threadId);
    const ended = events.filter((e) => e.payload.type === 'turn-ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toMatchObject({ state: 'cancelled', reason: 'user-cancelled' });
  }, 60_000);

  it('an approval with nobody attached to answer parks the turn instead of auto-approving', async () => {
    const harness = await startDaemon({
      profile: 'ask',
      rounds: [
        [
          shellCall('call_shell004', [
            'node',
            '-e',
            "require('fs').writeFileSync('never.txt','ran')",
          ]),
          { type: 'done', finishReason: 'tool_calls' },
        ],
        done('done'),
      ],
    });
    const client = await attach(harness, 'cli');
    const threadId = await createThread(client);
    client.send({ type: 'start-turn', threadId, text: 'create the marker file' });

    // The one observer leaves the moment it is asked. Nobody can answer.
    await client.waitFor('approval-request');
    client.close();

    const deadline = Date.now() + 20_000;
    for (;;) {
      const events = harness.daemon.store.readThread(threadId);
      const parked =
        events.some((e) => e.payload.type === 'approval-requested') &&
        !events.some((e) => e.payload.type === 'approval-resolved') &&
        !events.some((e) => e.payload.type === 'turn-ended');
      if (parked && harness.daemon.store.readThread(threadId).length > 0) {
        // Give the engine a moment to have actually returned before asserting nothing ran.
        await new Promise((r) => setTimeout(r, 200));
        break;
      }
      if (Date.now() > deadline) throw new Error('the turn never parked');
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(existsSync(join(harness.workspace, 'never.txt'))).toBe(false);
    const parkedEvents = harness.daemon.store.readThread(threadId);
    expect(parkedEvents.some((e) => e.payload.type === 'turn-ended')).toBe(false);
    expect(parkedEvents.some((e) => e.payload.type === 'approval-resolved')).toBe(false);
    const parkedTurnId = parkedEvents.find((e) => e.payload.type === 'turn-started')?.turnId;

    // A new client attaches and picks the parked turn back up. A PROMPT would be refused — an
    // approval is not a user message — so it resumes the thread explicitly.
    const late = await attach(harness, 'late');
    late.send({ type: 'start-turn', threadId, text: 'just do it' });
    const refusal = await late.waitFor('error');
    expect(refusal.message).toContain('awaiting an approval');

    late.send({ type: 'resume-thread', threadId });
    const asked = await late.waitFor('approval-request');
    expect(asked.request.turnId).toBe(parkedTurnId);
    late.send({
      type: 'approve',
      threadId,
      callId: asked.request.callId,
      granted: true,
      scope: 'once',
    });

    const result = await late.waitFor('turn-result');
    expect(result.state).toBe('completed');
    expect(result.turnId).toBe(parkedTurnId); // the SAME turn, resumed after a detach
    expect(existsSync(join(harness.workspace, 'never.txt'))).toBe(true);
    expect(
      harness.daemon.store.readThread(threadId).filter((e) => e.payload.type === 'turn-started'),
    ).toHaveLength(1);
  }, 60_000);

  it('a malformed command is rejected at the boundary, not acted on', async () => {
    const harness = await startDaemon({ profile: 'ask', rounds: [done('hi')] });
    const client = await attach(harness, 'cli');
    client.send({ type: 'start-turn', threadId: 'not-a-thread-id', text: 'go' });
    const error = await client.waitFor('error');
    expect(error.message).toContain('invalid command');
  }, 30_000);
});

describe('exactly one writer', () => {
  it('a second daemon refuses to start while a live one holds the lease', async () => {
    const harness = await startDaemon({ profile: 'ask', rounds: [done('hi')] });

    const second = spawn(
      TSX,
      [
        DAEMON_BIN,
        '--socket',
        join(harness.workspace, 'second.sock'),
        '--lease',
        harness.leasePath,
        '--state',
        join(harness.workspace, 'sessions.sqlite'),
        '--workspace',
        harness.workspace,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    second.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const code = await new Promise<number>((res) => second.on('exit', (c) => res(c ?? -1)));

    // It refuses — it does not wait, retry, or open a second writer on the same store.
    expect(code, stderr).toBe(3);
    expect(stderr).toContain('locked by a live daemon');
    expect(stderr).toContain(String(process.pid));
    expect(existsSync(join(harness.workspace, 'second.sock'))).toBe(false);
  }, 60_000);
});
