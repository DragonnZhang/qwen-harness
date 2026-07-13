import {
  createHarnessRuntime,
  findPendingApproval,
  reconstructHistory,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
  type RunAuthority,
  type TurnOutcome,
} from '@qwen-harness/cli';
import {
  CommandSchema,
  type CorrelationId,
  type HarnessEvent,
  type IdSource,
  type ThreadId,
} from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';

import { acquireLease, type LeaseHandle } from './lease.ts';
import { CommandSocketServer, type ServerFrame } from './socket-protocol.ts';

/**
 * The runtime daemon (SS-08).
 *
 * It is the single WRITER for the threads it owns: it takes the lease before it opens the store, so
 * a second daemon cannot start against the same state and two SQLite writers can never interleave a
 * thread's turns. Clients attach over the Unix socket; any number of them may WATCH a session, but
 * none of them writes — they send commands and the daemon runs the turn.
 *
 * The turn it runs is the real one: the same `createHarnessRuntime` composition the CLI uses, with
 * the real policy engine, the real sandboxed tool worker, and the real event store. The daemon adds
 * exactly two things on top: it streams the durable events to attached clients, and it turns an
 * approval into a socket round trip. When a client answers, the SAME turn resumes — an approval is
 * never a new user message. When no client is attached to answer, the turn suspends in
 * `awaiting-approval` and the durable log keeps it, resumable later. Nothing is auto-approved.
 */

export interface DaemonOptions {
  readonly socketPath: string;
  readonly leasePath: string;
  /** Absolute path to the SQLite event store this daemon owns. */
  readonly statePath: string;
  readonly workspaceRoot: string;
  readonly homeDir: string;
  /** The ceiling and effective authority. The daemon runs the SAME composition the CLI runs. */
  readonly authority: RunAuthority;
  readonly model: string;
  readonly instructions: string;
  readonly clock: { now(): number };
  readonly ids: IdSource;
  /** Injected for deterministic tests. Production leaves it out and the real adapter is used. */
  readonly provider?: HarnessRuntimeOptions['provider'];
  readonly log?: (line: string) => void;
}

interface AttachedClient {
  readonly name: string;
  readonly send: (frame: ServerFrame) => void;
}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly callId: string;
  readonly settle: (
    decision:
      | { kind: 'approved'; scope: 'once' | 'session' | 'rule' }
      | { kind: 'denied'; reason: string }
      | { kind: 'deferred'; reason: string },
  ) => void;
}

const INSTRUCTION_FALLBACK =
  'You are a coding assistant working inside a sandboxed workspace. Use the available tools to inspect and edit files and run commands. Be concise.';

export class Daemon {
  readonly #opts: DaemonOptions;
  readonly #lease: LeaseHandle;
  readonly #store: EventStore;
  readonly #server: CommandSocketServer;
  readonly #clients = new Set<AttachedClient>();
  readonly #runtimes = new Map<ThreadId, HarnessRuntime>();

  #pending: PendingApproval | null = null;
  #inFlight: { threadId: ThreadId; abort: AbortController } | null = null;
  #closed = false;

  private constructor(opts: DaemonOptions, lease: LeaseHandle, store: EventStore) {
    this.#opts = opts;
    this.#lease = lease;
    this.#store = store;
    this.#server = new CommandSocketServer(opts.socketPath, {
      onConnect: (name, send) => {
        this.#clients.add({ name, send });
      },
      onDisconnect: (name, send) => {
        for (const client of this.#clients) {
          if (client.name === name && client.send === send) this.#clients.delete(client);
        }
        // The last observer just left. An outstanding approval now has nobody to answer it, so it
        // is DEFERRED — the turn suspends and the durable log keeps the request. It is not denied
        // (that would be a decision nobody made) and it is certainly not approved.
        if (this.#clients.size === 0 && this.#pending !== null) {
          const pending = this.#pending;
          this.#pending = null;
          pending.settle({ kind: 'deferred', reason: 'every client detached before answering' });
        }
      },
      onCommand: (command, send) => {
        this.#onCommand(command, send);
      },
    });
  }

  /**
   * Take the lease, open the store, listen. The ORDER matters: the lease is acquired before the
   * store is opened, so a second daemon fails before it can touch the database.
   */
  static async start(opts: DaemonOptions): Promise<Daemon> {
    const lease = acquireLease(opts.leasePath);
    let store: EventStore;
    try {
      store = new EventStore({
        path: opts.statePath,
        clock: {
          now: () => opts.clock.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        ids: opts.ids,
      });
    } catch (e) {
      lease.release();
      throw e;
    }

    const daemon = new Daemon(opts, lease, store);
    try {
      await daemon.#server.listen();
    } catch (e) {
      store.close();
      lease.release();
      throw e;
    }
    opts.log?.(`daemon listening on ${opts.socketPath} (pid ${String(process.pid)})`);
    return daemon;
  }

  get store(): EventStore {
    return this.#store;
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inFlight?.abort.abort();
    await this.#server.close();
    this.#store.close();
    this.#lease.release();
  }

  // -------------------------------------------------------------------------------------------

  #broadcast(frame: ServerFrame): void {
    for (const client of this.#clients) client.send(frame);
  }

  #onCommand(raw: unknown, send: (frame: ServerFrame) => void): void {
    const parsed = CommandSchema.safeParse(raw);
    if (!parsed.success) {
      send({ kind: 'error', message: `invalid command: ${parsed.error.issues[0]?.message ?? ''}` });
      return;
    }
    const command = parsed.data;

    switch (command.type) {
      case 'create-thread': {
        const threadId = this.#opts.ids.next('thr') as ThreadId;
        this.#store.append({
          threadId,
          correlationId: this.#opts.ids.next('cor') as CorrelationId,
          permissionProfile: this.#opts.authority.profile,
          actor: { kind: 'user', id: 'act_user01' as never },
          payload: {
            type: 'thread-created',
            cwd: this.#opts.workspaceRoot,
            canonicalRepo: this.#opts.workspaceRoot,
            name: command.name,
          },
        });
        // The client learns the new thread id from the event stream, like every other fact.
        this.#broadcast({
          kind: 'event',
          event: this.#store.readThread(threadId).at(-1) ?? null,
        });
        return;
      }

      case 'start-turn': {
        const problem = this.#cannotRun(command.threadId);
        if (problem !== null) {
          send({ kind: 'error', message: problem });
          return;
        }
        if (findPendingApproval(this.#store, command.threadId) !== null) {
          // A parked turn is still alive. A new prompt is NOT how you answer it — that would make
          // an approval into a user message, which is exactly the thing this design forbids.
          send({
            kind: 'error',
            message: 'this thread is awaiting an approval; answer it, or send resume-thread',
          });
          return;
        }
        // Fire and forget: the turn reports itself through the event stream and a final
        // `turn-result` frame. Failures are surfaced as frames, never swallowed.
        this.#spawnTurn(command.threadId, command.text);
        return;
      }

      case 'resume-thread': {
        const problem = this.#cannotRun(command.threadId);
        if (problem !== null) {
          send({ kind: 'error', message: problem });
          return;
        }
        if (findPendingApproval(this.#store, command.threadId) === null) {
          send({ kind: 'error', message: 'that thread has nothing to resume' });
          return;
        }
        this.#spawnTurn(command.threadId, '');
        return;
      }

      case 'approve': {
        const pending = this.#pending;
        if (pending === null) {
          send({ kind: 'error', message: 'there is no approval waiting for an answer' });
          return;
        }
        if (command.callId !== null && command.callId !== pending.callId) {
          // An answer must name the action it answers. Approving "whatever is pending" is exactly
          // the confusion an attacker would want.
          send({ kind: 'error', message: 'that decision does not match the pending approval' });
          return;
        }
        this.#pending = null;
        pending.settle(
          command.granted
            ? { kind: 'approved', scope: command.scope ?? 'once' }
            : { kind: 'denied', reason: 'a client denied the action' },
        );
        return;
      }

      case 'interrupt': {
        const inFlight = this.#inFlight;
        if (inFlight === null) {
          send({ kind: 'error', message: 'no turn is running' });
          return;
        }
        // Cancellation propagates through the one abort tree: model stream, tool pipeline, and the
        // sandboxed worker's whole process group (RT-06). The turn then ENDS, with a reason.
        inFlight.abort.abort();
        const pending = this.#pending;
        if (pending !== null) {
          this.#pending = null;
          pending.settle({ kind: 'deferred', reason: 'the turn was cancelled' });
        }
        return;
      }

      default:
        send({ kind: 'error', message: `unsupported command: ${command.type}` });
        return;
    }
  }

  #cannotRun(threadId: ThreadId): string | null {
    if (this.#inFlight !== null) return 'a turn is already running on this daemon';
    if (this.#store.getThread(threadId) === undefined) return `no such thread: ${threadId}`;
    return null;
  }

  #spawnTurn(threadId: ThreadId, text: string): void {
    void this.#runTurn(threadId, text).catch((e: unknown) => {
      this.#broadcast({
        kind: 'error',
        message: `turn failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  }

  /**
   * Run (or resume) one turn against the real engine and stream it. If the thread's log says a turn
   * is already waiting for an approval, this continues THAT turn rather than starting a new one.
   */
  async #runTurn(threadId: ThreadId, text: string): Promise<void> {
    const abort = new AbortController();
    this.#inFlight = { threadId, abort };
    try {
      const runtime = this.#runtimeFor(threadId);
      const history = reconstructHistory(this.#store, threadId);
      const pending = findPendingApproval(this.#store, threadId);

      const result: TurnOutcome =
        pending !== null
          ? await runtime.resumeTurn({
              threadId,
              turnId: pending.turnId,
              correlationId: pending.correlationId,
              history,
              pendingCalls: pending.pendingCalls,
              signal: abort.signal,
            })
          : await runtime.runTurn({
              threadId,
              correlationId: this.#opts.ids.next('cor') as CorrelationId,
              userText: text,
              history,
              signal: abort.signal,
            });

      this.#broadcast({
        kind: 'turn-result',
        threadId,
        turnId: result.turnId,
        state: result.state,
        reason: result.reason,
        finalText: result.finalText,
      });
    } finally {
      this.#inFlight = null;
      this.#pending = null;
    }
  }

  /**
   * One runtime per thread, kept alive for the daemon's lifetime — so a `session`-scoped grant
   * survives from one turn to the next within the session the daemon owns, exactly as the user
   * expects when they answer "allow for this session".
   */
  #runtimeFor(threadId: ThreadId): HarnessRuntime {
    const existing = this.#runtimes.get(threadId);
    if (existing !== undefined) return existing;

    const runtime = createHarnessRuntime({
      workspaceRoot: this.#opts.workspaceRoot,
      authority: this.#opts.authority,
      model: this.#opts.model,
      instructions: this.#opts.instructions || INSTRUCTION_FALLBACK,
      homeDir: this.#opts.homeDir,
      clock: this.#opts.clock,
      ids: this.#opts.ids,
      store: this.#store,
      onEvent: (event: HarnessEvent) => {
        this.#broadcast({ kind: 'event', event });
      },
      approvals: {
        request: (request, signal) =>
          new Promise((resolve) => {
            if (this.#clients.size === 0) {
              resolve({
                kind: 'deferred',
                reason: 'no client is attached to answer; the turn stays awaiting approval',
              });
              return;
            }
            if (signal.aborted) {
              resolve({ kind: 'deferred', reason: 'the turn was cancelled' });
              return;
            }

            this.#pending = {
              threadId,
              callId: request.callId,
              settle: resolve,
            };
            this.#broadcast({
              kind: 'approval-request',
              request: {
                threadId,
                turnId: request.turnId,
                callId: request.callId,
                toolName: request.toolName,
                description: request.description,
                risk: request.risk,
                reason: request.reason,
              },
            });
          }),
      },
      ...(this.#opts.provider ? { provider: this.#opts.provider } : {}),
    });

    this.#runtimes.set(threadId, runtime);
    return runtime;
  }
}
