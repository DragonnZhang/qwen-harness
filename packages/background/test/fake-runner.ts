import type {
  InputRequest,
  Runner,
  RunnerCallbacks,
  RunnerControl,
  RunnerExit,
  RunnerSpec,
} from '../src/index.ts';

interface Handle {
  readonly callbacks: RunnerCallbacks;
  cancelled: boolean;
  readonly inputs: string[];
}

/**
 * A deterministic {@link Runner} for tests: it spawns no process. It captures the manager's callbacks
 * per task so a test can push output, request input, signal a detected input-wait, or exit BY HAND,
 * exercising the real state machine without wall-clock waits or real processes.
 */
export class FakeRunner implements Runner {
  readonly handles = new Map<string, Handle>();

  start(spec: RunnerSpec, callbacks: RunnerCallbacks): RunnerControl {
    const handle: Handle = { callbacks, cancelled: false, inputs: [] };
    this.handles.set(spec.taskId, handle);
    return {
      provideInput: (value: string): void => {
        handle.inputs.push(value);
      },
      cancel: (): void => {
        handle.cancelled = true;
      },
    };
  }

  #handle(taskId: string): Handle {
    const handle = this.handles.get(taskId);
    if (!handle) throw new Error(`no fake run for ${taskId}`);
    return handle;
  }

  started(taskId: string): boolean {
    return this.handles.has(taskId);
  }

  cancelled(taskId: string): boolean {
    return this.#handle(taskId).cancelled;
  }

  inputs(taskId: string): readonly string[] {
    return this.#handle(taskId).inputs;
  }

  emitOutput(taskId: string, chunk: string): void {
    this.#handle(taskId).callbacks.onOutput(chunk);
  }

  requestInput(taskId: string, request: InputRequest): void {
    this.#handle(taskId).callbacks.onInputRequest(request);
  }

  detectInputWait(taskId: string): void {
    this.#handle(taskId).callbacks.onInputWaitDetected();
  }

  exit(taskId: string, exit: RunnerExit): void {
    this.#handle(taskId).callbacks.onExit(exit);
  }
}
