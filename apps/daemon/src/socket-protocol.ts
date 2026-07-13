import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { ClientHelloSchema, PROTOCOL_VERSION } from '@qwen-harness/protocol';
import { z } from 'zod';

/**
 * The versioned Unix-domain-socket command/event protocol (SS-08, design §4).
 *
 * The TUI and CLI are CLIENTS: they attach to the daemon over this socket, send typed commands,
 * and receive typed events. The daemon owns the runtime; a client never mutates state directly.
 * Because clients connect and detach freely, the daemon can outlive any single UI, and multiple
 * clients can watch the same thread.
 *
 * Framing is newline-delimited JSON. The FIRST frame from a client MUST be a `ClientHello` with a
 * matching protocol version — a version mismatch is refused immediately, so a client and daemon of
 * different builds fail loudly rather than corrupting a thread with a misunderstood command.
 *
 * Every frame crossing the socket is parsed by a zod schema before anything reads a field from it.
 * A local socket is still an untrusted boundary: whoever can connect can send bytes, and a daemon
 * that trusted the shape of those bytes would be one malformed frame away from undefined behavior.
 */

/** What the daemon asks a client, when policy says an action needs a human. */
export const ApprovalRequestFrameSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  /** The exact normalized action, as policy described it. This is what the human approves. */
  description: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  reason: z.string(),
});
export type ApprovalRequestFrame = z.infer<typeof ApprovalRequestFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello-ack'),
    protocolVersion: z.number().int().positive(),
    daemonPid: z.number().int(),
  }),
  z.object({ kind: z.literal('hello-reject'), reason: z.string() }),
  /** A durable `HarnessEvent`, exactly as it was written to the log. */
  z.object({ kind: z.literal('event'), event: z.unknown() }),
  z.object({ kind: z.literal('approval-request'), request: ApprovalRequestFrameSchema }),
  z.object({
    kind: z.literal('turn-result'),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    state: z.string(),
    reason: z.string().nullable(),
    finalText: z.string(),
  }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), hello: ClientHelloSchema }),
  z.object({ kind: z.literal('command'), command: z.unknown() }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export interface SocketServerHandlers {
  /** Called with each validated FRAME from a connected, handshaken client. The command inside is
   * still unvalidated — the daemon parses it against the protocol's `CommandSchema`. */
  onCommand(command: unknown, send: (frame: ServerFrame) => void): void;
  onConnect?(clientName: string, send: (frame: ServerFrame) => void): void;
  onDisconnect?(clientName: string, send: (frame: ServerFrame) => void): void;
}

/**
 * The daemon's socket server. Validates the handshake, then routes commands to the handler and lets
 * the handler push events back. One server, many client connections.
 */
export class CommandSocketServer {
  #server: Server | null = null;
  readonly #sockets = new Set<Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly handlers: SocketServerHandlers,
    private readonly daemonPid = process.pid,
  ) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#onSocket(socket));
      server.on('error', reject);
      server.listen(this.socketPath, () => {
        this.#server = server;
        resolve();
      });
    });
  }

  #onSocket(socket: Socket): void {
    this.#sockets.add(socket);
    let handshaken = false;
    let clientName = '(unknown)';
    const send = (frame: ServerFrame) => {
      if (!socket.destroyed) socket.write(JSON.stringify(frame) + '\n');
    };

    forEachLine(socket, (line) => {
      let frame: ClientFrame;
      try {
        const parsed = ClientFrameSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          send({ kind: 'error', message: 'malformed frame' });
          return;
        }
        frame = parsed.data;
      } catch {
        send({ kind: 'error', message: 'unparseable frame' });
        return;
      }

      if (!handshaken) {
        // The first frame MUST be a version-matching hello, or the connection is refused.
        if (frame.kind !== 'hello') {
          send({ kind: 'hello-reject', reason: 'expected a hello frame first' });
          socket.destroy();
          return;
        }
        if (frame.hello.protocolVersion !== PROTOCOL_VERSION) {
          send({
            kind: 'hello-reject',
            reason: `protocol version ${frame.hello.protocolVersion} != daemon ${PROTOCOL_VERSION}`,
          });
          socket.destroy();
          return;
        }
        handshaken = true;
        clientName = frame.hello.clientName;
        send({ kind: 'hello-ack', protocolVersion: PROTOCOL_VERSION, daemonPid: this.daemonPid });
        this.handlers.onConnect?.(clientName, send);
        return;
      }

      if (frame.kind === 'command') {
        this.handlers.onCommand(frame.command, send);
      }
    });

    socket.on('close', () => {
      this.#sockets.delete(socket);
      if (handshaken) this.handlers.onDisconnect?.(clientName, send);
    });
    socket.on('error', () => socket.destroy());
  }

  close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    return new Promise((resolve) => {
      if (this.#server === null) return resolve();
      this.#server.close(() => resolve());
      this.#server = null;
    });
  }
}

/** A client connection to the daemon. Handshakes, then sends commands and receives event frames. */
export class CommandSocketClient {
  #socket: Socket | null = null;

  constructor(private readonly socketPath: string) {}

  connect(
    clientName: string,
    onFrame: (frame: ServerFrame) => void,
  ): Promise<{ daemonPid: number }> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.#socket = socket;
      let acked = false;

      socket.on('connect', () => {
        socket.write(
          JSON.stringify({
            kind: 'hello',
            hello: { protocolVersion: PROTOCOL_VERSION, clientName },
          }) + '\n',
        );
      });

      forEachLine(socket, (line) => {
        const parsed = ServerFrameSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          // A frame this build cannot understand is dropped, not guessed at.
          return;
        }
        const frame = parsed.data;
        if (!acked) {
          if (frame.kind === 'hello-ack') {
            acked = true;
            resolve({ daemonPid: frame.daemonPid });
            return;
          }
          if (frame.kind === 'hello-reject') {
            reject(new Error(`daemon rejected the connection: ${frame.reason}`));
            socket.destroy();
            return;
          }
        }
        onFrame(frame);
      });

      socket.on('error', reject);
    });
  }

  send(command: unknown): void {
    this.#socket?.write(JSON.stringify({ kind: 'command', command }) + '\n');
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/** Split an incoming socket stream into newline-delimited frames. */
function forEachLine(socket: Socket, onLine: (line: string) => void): void {
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  });
}
