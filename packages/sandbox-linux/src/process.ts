/**
 * Process supervision shared by the real backend and the disabled (`yolo`) backend.
 *
 * The controls here apply REGARDLESS of isolation, because the threat model keeps them active even
 * in `yolo`: separate stdout/stderr, a bounded output buffer, a hard wall-clock deadline,
 * cancellation via AbortSignal, and — the important one — killing the whole process GROUP so that a
 * child which spawned a grandchild leaves nothing behind.
 *
 * The reliable bound on a fork bomb lives here, not in an rlimit: RLIMIT_NPROC is unreliable in an
 * unprivileged user namespace on this kernel (see spec.ts), so we do not depend on it. `detached:
 * true` puts the child in its own process group; `process.kill(-pid, ...)` signals every member of
 * that group at once. Under bubblewrap the whole tree also shares bwrap's PID namespace, so the
 * group kill and `--die-with-parent` reap it twice over.
 */

import { spawn } from 'node:child_process';

import type { SandboxRunResult } from './bwrap.ts';
import type { SandboxSpec } from './spec.ts';

/** Spawn `command` directly with a minimized env and every non-isolation control applied. */
export function runUnconfined(spec: SandboxSpec, now: () => number): Promise<SandboxRunResult> {
  return supervise(spec.command, [...spec.args], spec, now, {
    cwd: spec.cwd,
    env: { ...spec.env },
  });
}

interface SuperviseOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

/**
 * The single supervision core. `runSandboxed` calls this with the bwrap argv; `runUnconfined`
 * calls it with the raw command. Keeping ONE implementation means the output cap, the deadline, and
 * the group teardown cannot drift between the isolated and non-isolated paths.
 */
export function supervise(
  command: string,
  args: string[],
  spec: Pick<SandboxSpec, 'timeoutMs' | 'maxOutputBytes' | 'signal'>,
  now: () => number,
  options: SuperviseOptions = {},
): Promise<SandboxRunResult> {
  const startedAtMs = now();

  return new Promise<SandboxRunResult>((settle) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a deadline or an abort can signal the whole tree at once.
      detached: true,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cap = spec.maxOutputBytes;
    const onData = (which: 'out' | 'err') => (chunk: Buffer) => {
      const current = which === 'out' ? stdout.length : stderr.length;
      if (current >= cap) {
        if (!truncated) {
          truncated = true;
          killGroup();
        }
        return;
      }
      const room = cap - current;
      const text = chunk.toString('utf8').slice(0, room);
      if (chunk.length > room) {
        truncated = true;
        killGroup();
      }
      if (which === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', onData('out'));
    child.stderr?.on('data', onData('err'));

    function killGroup(): void {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the whole process group — leader, children, grandchildren.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone; nothing to reap.
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, spec.timeoutMs);

    const onAbort = (): void => killGroup();
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      settle({
        exitCode,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut,
        // Duration relative to the injected start time — no ambient clock in this package.
        durationMs: Math.max(0, now() - startedAtMs),
      });
    };

    child.on('error', (error) => {
      stderr += `sandbox spawn error: ${error.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
