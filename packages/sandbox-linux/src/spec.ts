/**
 * The typed description of ONE sandboxed execution. Everything the backend needs to build a real
 * `bwrap` invocation, and nothing it does not — no ambient host state leaks in.
 */

import type { IsolationMode } from '@qwen-harness/protocol';

export type { IsolationMode };

/**
 * A bind mount request. `source` is a canonical host path; `dest` is where it appears inside the
 * sandbox. Absence of a bind is how a path is denied: the process cannot reach what was never
 * mounted, which is a stronger statement than a deny rule the process might find a way around.
 */
export interface BindMount {
  readonly source: string;
  readonly dest: string;
  readonly mode: 'ro' | 'rw';
}

/**
 * Resource caps applied via `prlimit` before the target execs.
 *
 * DELIBERATE OMISSION: `addressSpaceBytes` (RLIMIT_AS) is opt-in and OFF by default. On the target
 * kernel a Node process reserves multiple GB of *virtual* address space for pointer compression
 * even when its RSS is tiny, so a low RLIMIT_AS makes Node abort at startup — and the tool-worker
 * IS a Node process. Capping virtual memory is the wrong tool here; CPU, file size, and open files
 * are the caps that bound a runaway without breaking the legitimate workload. See the README.
 */
export interface ResourceLimits {
  /** RLIMIT_CPU, seconds of CPU time. Fires deterministically (SIGXCPU). */
  readonly cpuSeconds?: number;
  /** RLIMIT_FSIZE, bytes any single file may reach. Fires deterministically (SIGXFSZ). */
  readonly fileSizeBytes?: number;
  /** RLIMIT_NOFILE, open file descriptors. */
  readonly openFiles?: number;
  /**
   * RLIMIT_NPROC. Best-effort ONLY: on this kernel, inside an unprivileged user namespace, the
   * per-uid process count is not reliably enforced. It is still set (it helps where it works), but
   * the real bound on a fork bomb is the wall-clock deadline plus whole-process-group teardown.
   */
  readonly processes?: number;
  /** RLIMIT_AS, bytes of virtual address space. Off by default; see the type comment. */
  readonly addressSpaceBytes?: number;
}

/** The frozen default caps. Chosen to bound a runaway while leaving a Node worker healthy. */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpuSeconds: 300,
  fileSizeBytes: 2 * 1024 * 1024 * 1024, // 2 GiB — matches the background-output hard stop
  openFiles: 1024,
  processes: 512,
};

export interface IsolationSpec {
  readonly mode: IsolationMode;
  /** Canonical absolute workspace root. Bound read-only or read-write per `mode`. */
  readonly workspaceRoot: string;
  /**
   * A private writable scratch directory (canonical host path). Bound read-write in EVERY mode,
   * including `read-only`: a read-only tool still needs somewhere to put a temp file, and a
   * dedicated scratch keeps that write off the workspace. Absent means "no scratch".
   */
  readonly scratchRoot?: string;
  /** Additional binds, e.g. a read-only toolchain directory. Ordered; later wins on overlap. */
  readonly extraBinds?: readonly BindMount[];
  /** Network is denied unless this is true AND managed policy allows it. */
  readonly networkAllowed: boolean;
  readonly limits?: ResourceLimits;
}

export interface SandboxSpec {
  readonly isolation: IsolationSpec;
  /** Absolute path to the executable. Resolved by the caller; the backend does not search PATH. */
  readonly command: string;
  readonly args: readonly string[];
  /** Working directory INSIDE the sandbox. Must be a bound path. */
  readonly cwd: string;
  /**
   * Environment for the child, already minimized. The backend passes it through `--clearenv` +
   * explicit `--setenv`, so nothing from the parent environment leaks unless it is named here.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Hard wall-clock deadline in ms. On expiry the whole process group is killed. */
  readonly timeoutMs: number;
  /**
   * Cap on captured stdout+stderr bytes. On overflow the process group is killed and the result is
   * marked truncated — the reliable bound on an output flood.
   */
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}
