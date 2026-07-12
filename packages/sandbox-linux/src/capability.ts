/**
 * Detecting whether a REAL sandbox is available, and reporting exactly why when it is not.
 *
 * `doctor` prints this verbatim (SB-03). "Sandbox unavailable" is useless to a user; "bwrap is
 * installed but /proc/sys/user/max_user_namespaces is 0, run `sysctl -w
 * kernel.unprivileged_userns_clone=1`" is actionable. Safe profiles fail CLOSED on an unavailable
 * backend — the detection result is what they branch on, so it must be precise.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants as FS, readFileSync } from 'node:fs';

export type SandboxUnavailableReason =
  'bwrap-missing' | 'bwrap-not-executable' | 'bwrap-broken' | 'userns-disabled' | 'unknown';

export interface SandboxCapability {
  /** True only when a real isolation backend is usable on this host right now. */
  readonly available: boolean;
  readonly backend: 'bubblewrap' | 'none';
  /** Absolute path to the bwrap binary, when found. */
  readonly bwrapPath: string | null;
  readonly bwrapVersion: string | null;
  /**
   * Absolute path to `prlimit`, when found. Null means rlimits cannot be applied and the deadline
   * plus process-group teardown are the only bounds — still safe, but reported so `doctor` is
   * honest about which controls are active.
   */
  readonly prlimitPath: string | null;
  /** Machine-readable reason the backend is unavailable. Null when available. */
  readonly reason: SandboxUnavailableReason | null;
  /** Human-readable, actionable detail for `doctor`. */
  readonly detail: string;
  /** Individual probe outcomes, so `doctor` can show the whole picture. */
  readonly probes: readonly CapabilityProbe[];
}

export interface CapabilityProbe {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
const PRLIMIT_CANDIDATES = ['/usr/bin/prlimit', '/bin/prlimit', '/usr/local/bin/prlimit'];

function findExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, FS.X_OK);
      return candidate;
    } catch {
      // Try the next candidate; a missing binary is the expected case, not an error here.
    }
  }
  return null;
}

function findBwrap(): string | null {
  return findExecutable(BWRAP_CANDIDATES);
}

/** Locate `prlimit`, used to apply rlimits inside the sandbox. */
export function findPrlimit(): string | null {
  return findExecutable(PRLIMIT_CANDIDATES);
}

/**
 * Are unprivileged user namespaces enabled? bwrap needs them to remap uids without being setuid.
 * The knobs differ by distro; we read the ones that exist and treat "file absent" as "not the knob
 * this kernel uses", never as a failure on its own.
 */
function userNamespacesEnabled(): { ok: boolean; detail: string } {
  const readInt = (path: string): number | null => {
    try {
      return Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    } catch {
      return null;
    }
  };

  const maxUserNs = readInt('/proc/sys/user/max_user_namespaces');
  if (maxUserNs !== null && maxUserNs <= 0) {
    return {
      ok: false,
      detail:
        'user.max_user_namespaces is 0; enable it with `sysctl -w user.max_user_namespaces=10000`',
    };
  }

  const clone = readInt('/proc/sys/kernel/unprivileged_userns_clone');
  if (clone !== null && clone === 0) {
    return {
      ok: false,
      detail:
        'kernel.unprivileged_userns_clone is 0; enable it with `sysctl -w kernel.unprivileged_userns_clone=1`',
    };
  }

  const detail =
    maxUserNs !== null
      ? `user.max_user_namespaces=${maxUserNs}`
      : 'user-namespace sysctls not present; relying on a runtime probe';
  return { ok: true, detail };
}

/**
 * The decisive probe: actually run bwrap. A binary that exists but cannot create a namespace (a
 * hardened container, a seccomp policy, a missing capability) is NOT a usable backend, and the
 * only honest way to know is to try. The probe is trivial and side-effect-free — it runs `true`
 * inside a throwaway namespace.
 */
function runtimeProbe(bwrapPath: string): { ok: boolean; detail: string } {
  try {
    // Run `/usr/bin/true`, not `/bin/true`. On a merged-/usr system (this host: /bin -> usr/bin)
    // binding only /usr leaves /bin unresolvable, and the probe would misdiagnose a working
    // sandbox as a namespace failure. Use the canonical path and let buildBwrapArgs recreate the
    // symlinks for real runs.
    execFileSync(
      bwrapPath,
      [
        '--unshare-all',
        '--die-with-parent',
        '--ro-bind',
        '/usr',
        '/usr',
        // Recreate the merged-/usr symlinks, exactly as a real run does. On this host coreutils
        // are uutils (Rust): /usr/bin/true -> ../lib/cargo/.../true, which needs the loader under
        // /lib64. Without these symlinks the probe fails even though a real sandbox would work.
        '--symlink',
        'usr/bin',
        '/bin',
        '--symlink',
        'usr/lib',
        '/lib',
        '--symlink',
        'usr/lib64',
        '/lib64',
        '/usr/bin/true',
      ],
      { stdio: 'ignore', timeout: 10_000 },
    );
    return { ok: true, detail: 'bwrap created a namespace and ran a probe process' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    return {
      ok: false,
      detail: `bwrap failed to create a namespace (${err.code ?? err.status ?? 'error'}); the host may forbid unprivileged user namespaces`,
    };
  }
}

function bwrapVersion(bwrapPath: string): string | null {
  try {
    return execFileSync(bwrapPath, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Detect the sandbox backend. Pure inspection: it makes no lasting change to the host and is safe
 * to call at startup and from `doctor`. It always returns a value — it never throws — because a
 * detection that throws cannot be reported, and an unreportable failure fails OPEN.
 */
export function detectCapability(): SandboxCapability {
  const probes: CapabilityProbe[] = [];

  const prlimitPath = findPrlimit();
  const bwrapPath = findBwrap();
  probes.push({
    name: 'bwrap-binary',
    ok: bwrapPath !== null,
    detail: bwrapPath ?? `not found in ${BWRAP_CANDIDATES.join(', ')}`,
  });
  probes.push({
    name: 'prlimit-binary',
    ok: prlimitPath !== null,
    detail: prlimitPath ?? 'not found; rlimits will be skipped (deadline + group-kill still apply)',
  });
  if (bwrapPath === null) {
    return {
      available: false,
      backend: 'none',
      bwrapPath: null,
      bwrapVersion: null,
      prlimitPath,
      reason: 'bwrap-missing',
      detail: 'bubblewrap is not installed; `apt-get install bubblewrap` (PK-01 prerequisite)',
      probes,
    };
  }

  const version = bwrapVersion(bwrapPath);
  probes.push({
    name: 'bwrap-version',
    ok: version !== null,
    detail: version ?? 'could not run --version',
  });

  const userns = userNamespacesEnabled();
  probes.push({ name: 'user-namespaces', ok: userns.ok, detail: userns.detail });
  if (!userns.ok) {
    return {
      available: false,
      backend: 'none',
      bwrapPath,
      bwrapVersion: version,
      prlimitPath,
      reason: 'userns-disabled',
      detail: userns.detail,
      probes,
    };
  }

  const runtime = runtimeProbe(bwrapPath);
  probes.push({ name: 'runtime-probe', ok: runtime.ok, detail: runtime.detail });
  if (!runtime.ok) {
    return {
      available: false,
      backend: 'none',
      bwrapPath,
      bwrapVersion: version,
      prlimitPath,
      reason: 'bwrap-broken',
      detail: runtime.detail,
      probes,
    };
  }

  return {
    available: true,
    backend: 'bubblewrap',
    bwrapPath,
    bwrapVersion: version,
    prlimitPath,
    reason: null,
    detail: `bubblewrap ${version ?? '(unknown version)'} is available and functional`,
    probes,
  };
}
