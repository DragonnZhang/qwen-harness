import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import { McpError } from '../errors.ts';
import { decodeMessage, type JsonRpcMessage } from '../jsonrpc.ts';
import { type Transport, TransportListeners } from './transport.ts';

export interface StdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /**
   * The child's environment. Explicit and closed: a server subprocess does NOT inherit the parent
   * environment by default, so a credential in `process.env` cannot leak into an MCP server
   * (defaults.md, "OAuth token storage" — same child-environment restriction as the model key).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** How long to wait for a graceful exit before signalling, then killing (graded termination). */
  readonly terminationGraceMs?: number;
  /** Called with each line the server writes to stderr — routed to the per-server log (MC-10). */
  readonly onStderr?: (line: string) => void;
}

const DEFAULT_GRACE_MS = 2_000;

/**
 * stdio transport (MC-02): spawn a server subprocess and speak newline-delimited JSON-RPC over its
 * stdin/stdout. This is the workhorse local transport.
 *
 * Two subtleties the tests pin:
 *   - Framing is strictly one JSON value per line. A partial line is buffered until its newline
 *     arrives, so a large frame split across `data` events is reassembled, not dropped.
 *   - Termination is graded (MC-06): `close()` ends stdin, waits for a clean exit, then SIGTERM,
 *     then SIGKILL. A server that ignores the polite request is still guaranteed to die.
 *
 * This transport never restarts the child on its own. Auto-restart is a lifecycle-manager policy
 * that is off unless the server config explicitly opts in (defaults.md).
 */
export class StdioTransport implements Transport {
  readonly kind = 'stdio' as const;
  readonly #opts: StdioTransportOptions;
  readonly #listeners = new TransportListeners();
  #child: ChildProcessWithoutNullStreams | null = null;
  #stdoutBuffer = '';
  #stderrBuffer = '';

  constructor(opts: StdioTransportOptions) {
    this.#opts = opts;
  }

  onMessage(handler: (m: JsonRpcMessage) => void): void {
    this.#listeners.onMessage(handler);
  }
  onClose(handler: (err?: Error) => void): void {
    this.#listeners.onClose(handler);
  }

  start(): Promise<void> {
    if (this.#child !== null) return Promise.resolve();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#opts.command, [...(this.#opts.args ?? [])], {
        ...(this.#opts.cwd !== undefined ? { cwd: this.#opts.cwd } : {}),
        // A closed environment: only what the caller passed, never the ambient process env.
        env: { ...(this.#opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return Promise.reject(
        new McpError('connection', `failed to spawn "${this.#opts.command}"`, { cause: err }),
      );
    }
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.#onStderr(chunk));

    return new Promise<void>((resolve, reject) => {
      const onSpawnError = (err: Error): void => {
        reject(new McpError('connection', `spawn error: ${err.message}`, { cause: err }));
      };
      child.once('error', onSpawnError);
      child.once('spawn', () => {
        child.removeListener('error', onSpawnError);
        // From here on, an error or exit is a connection close, not a start failure.
        child.on('error', (err: Error) => this.#listeners.emitClose(err));
        child.on('exit', (code, signal) => {
          const reason =
            code === 0 || code === null
              ? undefined
              : new McpError('connection', `server exited with code ${code} (signal ${signal})`);
          this.#listeners.emitClose(reason);
        });
        resolve();
      });
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.#child;
    if (child === null || this.#listeners.closed) {
      throw new McpError('connection', 'stdio transport is not connected');
    }
    const line = JSON.stringify(message) + '\n';
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let newline = this.#stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.#dispatchLine(line);
      newline = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON line on stdout is a server bug or noise; surface it to the log, never crash.
      this.#opts.onStderr?.(`[non-json stdout] ${line}`);
      return;
    }
    try {
      this.#listeners.emitMessage(decodeMessage(parsed));
    } catch (err) {
      this.#opts.onStderr?.(`[protocol error] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #onStderr(chunk: string): void {
    this.#stderrBuffer += chunk;
    let newline = this.#stderrBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#stderrBuffer.slice(0, newline);
      this.#stderrBuffer = this.#stderrBuffer.slice(newline + 1);
      this.#opts.onStderr?.(line);
      newline = this.#stderrBuffer.indexOf('\n');
    }
  }

  /**
   * Graded termination (MC-06): ask nicely (close stdin), then SIGTERM after the grace period,
   * then SIGKILL. A well-behaved server exits on stdin EOF; a stuck one is guaranteed to die.
   */
  async close(): Promise<void> {
    const child = this.#child;
    if (child === null) {
      this.#listeners.emitClose();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#listeners.emitClose();
      return;
    }
    const grace = this.#opts.terminationGraceMs ?? DEFAULT_GRACE_MS;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('exit', done);
      try {
        child.stdin.end();
      } catch {
        /* stdin may already be gone */
      }
      const term = setTimeout(() => {
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), grace);
        kill.unref?.();
      }, grace);
      term.unref?.();
    });
    this.#child = null;
    this.#listeners.emitClose();
  }
}
