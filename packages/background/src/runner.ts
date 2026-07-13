/**
 * The injected process boundary (BG-05). The manager owns the LIFECYCLE and STATE MACHINE; it never
 * spawns a real process. A `Runner` turns an abstract launch request into a live `RunnerControl` and
 * reports back through the callbacks the manager supplies. Production wires a real shell/workflow
 * runner (in `tool-worker`/`sandbox-linux`, the declared I/O owners); tests wire a deterministic fake
 * and drive the callbacks by hand, so the state machine is tested without real processes.
 */

import type { BackgroundCategory } from './category.ts';

/** A typed input request raised by a running process (BG-05). */
export interface InputRequest {
  /** What the process is asking for, e.g. a prompt string. Untrusted: sanitize before display. */
  readonly prompt: string;
  /** True when the request is a secret (so the UI masks input). */
  readonly secret?: boolean;
}

/** How a run ended. `ok` distinguishes success from failure; `code` is the process exit code. */
export interface RunnerExit {
  readonly ok: boolean;
  readonly code: number | null;
  /** A short, user-safe reason on failure. */
  readonly reason?: string;
}

/** The callbacks a {@link Runner} invokes as the process makes progress. */
export interface RunnerCallbacks {
  onOutput(chunk: string): void;
  /** The process made a typed request for input; the job immediately becomes `awaiting_input`. */
  onInputRequest(request: InputRequest): void;
  /** The process appears to be blocking on undeclared interactive input (detected TTY wait). */
  onInputWaitDetected(): void;
  onExit(exit: RunnerExit): void;
}

/** The handle the manager uses to steer a live run. */
export interface RunnerControl {
  provideInput(value: string): void;
  cancel(): void;
}

export interface RunnerSpec {
  readonly taskId: string;
  readonly category: BackgroundCategory;
  /** Opaque launch payload (command + args, workflow id, ...). The manager does not interpret it. */
  readonly payload: unknown;
}

export interface Runner {
  start(spec: RunnerSpec, callbacks: RunnerCallbacks): RunnerControl;
}
