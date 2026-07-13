/**
 * @qwen-harness/daemon
 *
 * The per-user supervisor daemon (SS-08). It holds the single writer lease for a thread and exposes
 * a versioned Unix-domain-socket command/event server. The TUI and CLI are clients: they attach,
 * send typed commands, and receive typed events, and can detach and reconnect. Because the daemon
 * owns the runtime, it outlives any single UI, and one writer lease prevents two independent
 * processes from interleaving a thread's turns.
 */

export { acquireLease, isLeaseHeld, readLeasePid, LeaseError } from './lease.ts';
export type { LeaseHandle } from './lease.ts';
export { CommandSocketServer, CommandSocketClient } from './socket-protocol.ts';
export type { ServerFrame, ClientFrame, SocketServerHandlers } from './socket-protocol.ts';
