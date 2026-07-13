import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { ClientHelloSchema, PROTOCOL_VERSION, type ClientHello } from '@qwen-harness/protocol';

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
 */

export type ServerFrame =
  | { readonly kind: 'hello-ack'; readonly protocolVersion: number; readonly daemonPid: number }
  | { readonly kind: 'hello-reject'; readonly reason: string }
  | { readonly kind: 'event'; readonly event: unknown }
  | { readonly kind: 'error'; readonly message: string };

export type ClientFrame =
  | { readonly kind: 'hello'; readonly hello: ClientHello }
  | { readonly kind: 'command'; readonly command: unknown };

export interface SocketServerHandlers {
  /** Called with each validated command from a connected, handshaken client. */
  onCommand(command: unknown, send: (frame: ServerFrame) => void): void;
  onConnect?(clientName: string): void;
  onDisconnect?(clientName: string): void;
}

/**
 * The daemon's socket server. Validates the handshake, then routes commands to the handler and lets
 * the handler push events back. One server, many client connections.
 */
export class CommandSocketServer {
  #server: Server | null = null;

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
    let handshaken = false;
    let clientName = '(unknown)';
    const send = (frame: ServerFrame) => {
      if (!socket.destroyed) socket.write(JSON.stringify(frame) + '\n');
    };

    forEachLine(socket, (line) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(line) as ClientFrame;
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
        const parsed = ClientHelloSchema.safeParse(frame.hello);
        if (!parsed.success) {
          send({ kind: 'hello-reject', reason: 'invalid hello' });
          socket.destroy();
          return;
        }
        if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
          send({
            kind: 'hello-reject',
            reason: `protocol version ${parsed.data.protocolVersion} != daemon ${PROTOCOL_VERSION}`,
          });
          socket.destroy();
          return;
        }
        handshaken = true;
        clientName = parsed.data.clientName;
        this.handlers.onConnect?.(clientName);
        send({ kind: 'hello-ack', protocolVersion: PROTOCOL_VERSION, daemonPid: this.daemonPid });
        return;
      }

      if (frame.kind === 'command') {
        this.handlers.onCommand(frame.command, send);
      }
    });

    socket.on('close', () => {
      if (handshaken) this.handlers.onDisconnect?.(clientName);
    });
    socket.on('error', () => socket.destroy());
  }

  close(): Promise<void> {
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
        const frame = JSON.parse(line) as ServerFrame;
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
