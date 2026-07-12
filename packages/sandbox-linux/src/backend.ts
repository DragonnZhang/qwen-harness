import { harnessError } from '@qwen-harness/protocol';
import type { IsolationMode } from '@qwen-harness/protocol';

import {
  buildBwrapArgs,
  runSandboxed,
  SANDBOX_SCRATCH,
  SANDBOX_WORKSPACE,
  type SandboxRunResult,
} from './bwrap.ts';
import { detectCapability, type SandboxCapability } from './capability.ts';
import { runUnconfined } from './process.ts';
import type { SandboxSpec } from './spec.ts';

/**
 * The backend interface. A container backend could implement the same shape later; today there is
 * one real implementation (bubblewrap) and one explicitly-degraded one (disabled), and the runtime
 * chooses between them by asking `detect()` — never by guessing.
 *
 * `spawn` starts a process and returns a cancellable handle; `run` is the await-to-completion
 * convenience over it. Both exist because a foreground tool call wants the promise while a
 * long-lived background job wants the handle.
 */
export interface SandboxBackend {
  readonly kind: 'bubblewrap' | 'disabled';
  detect(): SandboxCapability;
  spawn(spec: SandboxSpec): SandboxedProcess;
  run(spec: SandboxSpec): Promise<SandboxRunResult>;
  /** The argv a spec would produce. Exposed for audit and for the security tests. */
  preview(spec: SandboxSpec): string[];
}

/**
 * A running (or finished) sandboxed process. Holds the completion promise plus a `cancel()` that
 * tears down the WHOLE process group — not just the leader — so no descendant can outlive the call.
 */
export interface SandboxedProcess {
  readonly completed: Promise<SandboxRunResult>;
  /** Kill the whole process group now. Idempotent; the completion promise still settles. */
  cancel(): void;
}

/** Monotonic time source. `performance.now()` is monotonic, not wall-clock — safe and injectable. */
export type MonotonicNow = () => number;

/** Bridge a `cancel()` and any caller-supplied signal onto one controller the run listens to. */
function cancellable(spec: SandboxSpec): { spec: SandboxSpec; cancel: () => void } {
  const controller = new AbortController();
  if (spec.signal) {
    if (spec.signal.aborted) controller.abort();
    else spec.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { spec: { ...spec, signal: controller.signal }, cancel: () => controller.abort() };
}

export class BubblewrapBackend implements SandboxBackend {
  readonly kind = 'bubblewrap' as const;
  readonly #now: MonotonicNow;
  #cached: SandboxCapability | null = null;

  constructor(now: MonotonicNow = () => performance.now()) {
    this.#now = now;
  }

  /**
   * Detects whether the real backend can run. Delegates to the capability probe, which actually
   * runs a bwrap smoke test rather than merely checking that the binary exists — a bwrap that is
   * present but broken (e.g. userns disabled by the container runtime) must report unavailable, or
   * a safe profile would think it was isolated when it was not.
   */
  detect(): SandboxCapability {
    return (this.#cached ??= detectCapability());
  }

  preview(spec: SandboxSpec): string[] {
    return buildBwrapArgs(spec, { prlimitPath: this.detect().prlimitPath });
  }

  spawn(spec: SandboxSpec): SandboxedProcess {
    const cap = this.#requireAvailable();
    const { spec: merged, cancel } = cancellable(spec);
    const completed = runSandboxed(cap.bwrapPath as string, merged, this.#now, {
      prlimitPath: cap.prlimitPath,
    });
    return { completed, cancel };
  }

  run(spec: SandboxSpec): Promise<SandboxRunResult> {
    const cap = this.#requireAvailable();
    return runSandboxed(cap.bwrapPath as string, spec, this.#now, { prlimitPath: cap.prlimitPath });
  }

  #requireAvailable(): SandboxCapability {
    const cap = this.detect();
    if (!cap.available || cap.bwrapPath === null) {
      // Fail CLOSED. A safe profile never silently runs a tool unconfined (SB-01).
      throw harnessError({
        origin: 'sandbox',
        category: `sandbox.unavailable.${cap.reason ?? 'unknown'}`,
        message: cap.detail,
        userActionRequired: true,
      });
    }
    return cap;
  }
}

/**
 * The `yolo` backend: no bwrap wrapper at all.
 *
 * This is a DELIBERATE, LOGGED, AUDITABLE choice — never a silent fallback. Constructing it
 * requires an `AuditSink`, and every process it runs is recorded before it starts, so isolation can
 * never be disabled without a trace. A safe profile must NEVER be routed here; the runtime selects
 * it only for `yolo` (or when managed policy has explicitly set isolation to `disabled`).
 *
 * It still uses process groups, separate stdout/stderr, the deadline, output caps, and cancellation
 * — the invariants the threat model keeps active even in `yolo`. What it does not do is confine the
 * filesystem, network, or capabilities, which is exactly what "isolation disabled" means.
 */
export interface AuditSink {
  /** Called once, synchronously, when a process is about to run WITHOUT isolation. */
  isolationDisabled(record: DisabledIsolationRecord): void;
}

export interface DisabledIsolationRecord {
  readonly reason: 'yolo' | 'managed-disabled';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export class DisabledBackend implements SandboxBackend {
  readonly kind = 'disabled' as const;
  readonly #now: MonotonicNow;
  readonly #audit: AuditSink;
  readonly #reason: DisabledIsolationRecord['reason'];

  constructor(
    audit: AuditSink,
    options: { now?: MonotonicNow; reason?: DisabledIsolationRecord['reason'] } = {},
  ) {
    this.#audit = audit;
    this.#now = options.now ?? (() => performance.now());
    this.#reason = options.reason ?? 'yolo';
  }

  detect(): SandboxCapability {
    // Honest: this backend applies NO isolation. Reported so `doctor` shows the degradation.
    return {
      available: true,
      backend: 'none',
      bwrapPath: null,
      bwrapVersion: null,
      prlimitPath: null,
      reason: null,
      detail:
        'isolation is DISABLED (yolo / managed-disabled); no filesystem or network confinement',
      probes: [
        {
          name: 'isolation',
          ok: false,
          detail: 'disabled by profile/policy — this is not a sandbox',
        },
      ],
    };
  }

  preview(spec: SandboxSpec): string[] {
    return [spec.command, ...spec.args];
  }

  spawn(spec: SandboxSpec): SandboxedProcess {
    this.#record(spec);
    const { spec: merged, cancel } = cancellable(spec);
    return { completed: runUnconfined(merged, this.#now), cancel };
  }

  run(spec: SandboxSpec): Promise<SandboxRunResult> {
    this.#record(spec);
    return runUnconfined(spec, this.#now);
  }

  #record(spec: SandboxSpec): void {
    this.#audit.isolationDisabled({
      reason: this.#reason,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
    });
  }
}

/**
 * Choose a backend from an isolation mode. A safe mode (`read-only`, `workspace-write`) REQUIRES a
 * working bwrap and fails closed if it is unavailable; `disabled` routes to `DisabledBackend`, the
 * only non-isolating path, which is always audited.
 */
export function selectBackend(
  mode: IsolationMode,
  options: { audit: AuditSink; now?: MonotonicNow },
): SandboxBackend {
  if (mode === 'disabled') {
    return new DisabledBackend(options.audit, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      reason: 'yolo',
    });
  }
  const backend = new BubblewrapBackend(options.now);
  const cap = backend.detect();
  if (!cap.available) {
    throw harnessError({
      origin: 'sandbox',
      category: `sandbox.unavailable.${cap.reason ?? 'unknown'}`,
      message: `a safe isolation mode (${mode}) requires a working sandbox: ${cap.detail}`,
      userActionRequired: true,
    });
  }
  return backend;
}

export { SANDBOX_WORKSPACE, SANDBOX_SCRATCH };
export type { SandboxRunResult };
