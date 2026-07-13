/**
 * @qwen-harness/daemon
 *
 * The per-user supervisor daemon (SS-08). It holds the single writer lease for a thread, exposes a
 * versioned Unix-domain-socket command/event server, and RUNS THE TURN: the same
 * `createHarnessRuntime` composition the CLI uses, with the real policy engine, the real sandboxed
 * tool worker, and the real event store.
 *
 * The TUI and CLI are clients: they attach, send typed commands, and receive typed events, and can
 * detach and reconnect. Because the daemon owns the runtime, it outlives any single UI; because it
 * holds the lease, two independent processes cannot interleave a thread's turns. An approval is a
 * socket round trip that resumes the SAME turn — never a new user message, never an auto-approval.
 */

export { Daemon } from './daemon.ts';
export type { DaemonOptions } from './daemon.ts';
export { acquireLease, isLeaseHeld, readLeasePid, LeaseError } from './lease.ts';
export type { LeaseHandle } from './lease.ts';
export {
  CommandSocketServer,
  CommandSocketClient,
  ClientFrameSchema,
  ServerFrameSchema,
  ApprovalRequestFrameSchema,
} from './socket-protocol.ts';
export type {
  ServerFrame,
  ClientFrame,
  SocketServerHandlers,
  ApprovalRequestFrame,
} from './socket-protocol.ts';
