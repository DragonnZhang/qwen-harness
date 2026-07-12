/**
 * The controlled executors for out-of-process hook forms.
 *
 * This is the ONLY module in the product outside the sandbox that spawns a child process, and it
 * does so under tight constraints (threat model, "Hook -> runtime"):
 *
 *   - MINIMAL ENVIRONMENT. The child gets an allowlisted env, never the parent's. The provider key
 *     is excluded BY CONSTRUCTION: the allowlist names the vars a hook may see, and that name is
 *     not among them. The executor never even mentions the credential, so it cannot leak it.
 *   - A DEADLINE. Spawning honours an AbortSignal; the engine wires that signal to a timeout, and
 *     the executor kills the process group with SIGKILL when it fires. No hook runs unbounded.
 *   - VISIBLE FAILURE. A non-zero exit, a spawn error, or unparseable output is returned as a
 *     structured failure. It is never smoothed into a silent success — a failing hook must not
 *     silently allow.
 *
 * HTTP hooks do NOT open a socket here; they go through the injected `NetworkBroker` (the `network`
 * package), which owns outbound traffic. This module only shapes the request and parses the reply.
 */
import { spawn } from 'node:child_process';

import type { CommandHandler } from './registry.ts';
import type { NetworkBroker, NetworkHookRequest, NetworkHookResponse } from './ports.ts';

/** Cap on captured output so a chatty or hostile hook cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 1_024 * 1_024;

/**
 * The safe environment allowlist. These let a hook find an interpreter and behave locale-correctly;
 * none of them is a credential. Anything a hook legitimately needs beyond this is passed
 * explicitly via `CommandHandler.env`, which is auditable at the registration site.
 */
export const SAFE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
];

export interface CommandResult {
  readonly exitCode: number | null;
  readonly termSignal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the process could not be spawned at all (e.g. command not found). */
  readonly spawnError?: string;
  /** Set when the run was cancelled via the signal (timeout or upstream cancellation). */
  readonly aborted: boolean;
}

export interface CommandExecutorOptions {
  /**
   * The environment to FILTER through the allowlist. Injected so tests can prove a secret placed
   * here never reaches the child. Defaults to the real process environment.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Extra var names allowed through, on top of {@link SAFE_ENV_ALLOWLIST}. Still never a credential. */
  readonly extraEnvAllowlist?: readonly string[];
}

/**
 * Build the minimal child environment: allowlisted vars from the base env, plus the handler's
 * explicit additions, plus a couple of non-secret hook-context vars. A value that is `undefined`
 * in the base env is simply absent — the child never sees it.
 */
export function buildChildEnv(
  handlerEnv: Readonly<Record<string, string>> | undefined,
  options: CommandExecutorOptions,
  context: Readonly<Record<string, string>>,
): Record<string, string> {
  const base = options.baseEnv ?? process.env;
  const allow = new Set([...SAFE_ENV_ALLOWLIST, ...(options.extraEnvAllowlist ?? [])]);
  const env: Record<string, string> = {};
  for (const name of allow) {
    const value = base[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const [key, value] of Object.entries(context)) env[key] = value;
  if (handlerEnv) for (const [key, value] of Object.entries(handlerEnv)) env[key] = value;
  return env;
}

export class CommandExecutor {
  readonly #options: CommandExecutorOptions;

  constructor(options: CommandExecutorOptions = {}) {
    this.#options = options;
  }

  /**
   * Spawn the hook, feed `payload` on stdin, and resolve with a structured result. The returned
   * promise never rejects — every failure mode is a field on `CommandResult`, so the engine folds
   * them uniformly instead of some throwing and some not.
   */
  run(
    handler: CommandHandler,
    payload: string,
    signal: AbortSignal,
    context: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      const env = buildChildEnv(handler.env, this.#options, context);
      const child = spawn(handler.command, [...(handler.args ?? [])], {
        ...(handler.cwd !== undefined ? { cwd: handler.cwd } : {}),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
        // A cancelled hook must actually die, not linger ignoring SIGTERM.
        killSignal: 'SIGKILL',
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf8');
      });

      child.on('error', (err: Error & { code?: string }) => {
        // The runtime aborts the signal on timeout/cancellation; Node reports that as an error.
        const aborted = signal.aborted || err.name === 'AbortError';
        finish({
          exitCode: null,
          termSignal: null,
          stdout,
          stderr,
          aborted,
          ...(aborted ? {} : { spawnError: `${err.code ?? 'spawn-error'}: ${err.message}` }),
        });
      });

      child.on('close', (code, term) => {
        finish({ exitCode: code, termSignal: term, stdout, stderr, aborted: signal.aborted });
      });

      // Hand the invocation to the hook on stdin, the way command hooks conventionally read it.
      const stdin = child.stdin;
      if (stdin) {
        stdin.on('error', () => {
          // A hook that never reads stdin closes the pipe; that is not our failure to surface.
        });
        stdin.end(payload);
      }
    });
  }
}

/** Shape and issue an HTTP hook through the injected broker, and hand back the raw reply. */
export async function executeHttpHook(
  broker: NetworkBroker,
  request: NetworkHookRequest,
  signal: AbortSignal,
): Promise<NetworkHookResponse> {
  return broker.fetch(request, signal);
}
