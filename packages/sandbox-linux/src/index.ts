/**
 * @qwen-harness/sandbox-linux
 *
 * The real Linux sandbox backend (ADR 0003). Bubblewrap, proven on the target host.
 *
 * The one idea to carry away: **a path is denied by NOT binding it.** The child starts in an empty
 * mount namespace; we bind in only what the spec permits. `/root`, `~/.ssh`, the Docker socket —
 * none are denied by a rule the process might outwit. They do not exist inside the sandbox.
 * Absence is a stronger guarantee than a blocklist, and it is what the security tests verify.
 *
 * This is one of the declared I/O owners: the ONLY package that may construct a sandboxed process.
 * A safe profile fails CLOSED when the backend is unavailable — a missing sandbox is never
 * silently downgraded to unconfined execution.
 */

export {
  BubblewrapBackend,
  DisabledBackend,
  selectBackend,
  SANDBOX_WORKSPACE,
  SANDBOX_SCRATCH,
} from './backend.ts';
export type {
  SandboxBackend,
  SandboxedProcess,
  MonotonicNow,
  SandboxRunResult,
  AuditSink,
  DisabledIsolationRecord,
} from './backend.ts';

export { detectCapability, findPrlimit } from './capability.ts';
export type { SandboxCapability, SandboxUnavailableReason, CapabilityProbe } from './capability.ts';

export { buildBwrapArgs, runSandboxed, reachablePaths } from './bwrap.ts';
export type { BuildBwrapOptions } from './bwrap.ts';

export { supervise, runUnconfined } from './process.ts';

export { canonicalizePath, canonicalizeWithin, CanonicalizeError } from './canonicalize.ts';
export type { CanonicalPath, CanonicalizeOptions, CanonicalizeErrorCode } from './canonicalize.ts';

export { minimizeEnv, DEFAULT_ENV_ALLOWLIST } from './env.ts';
export type { EnvMinimizeOptions } from './env.ts';

export { DEFAULT_RESOURCE_LIMITS } from './spec.ts';
export type {
  IsolationSpec,
  SandboxSpec,
  BindMount,
  ResourceLimits,
  IsolationMode,
} from './spec.ts';
