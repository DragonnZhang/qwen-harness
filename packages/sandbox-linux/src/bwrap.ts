import { supervise } from './process.ts';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits, type SandboxSpec } from './spec.ts';

/**
 * The bubblewrap backend. This is the REAL Linux sandbox (ADR 0003) — not a string classifier.
 *
 * The core design choice, stated once: **a path is denied by NOT binding it.** bubblewrap starts
 * the child in an empty mount namespace and we bind in only what the spec permits. `/root`,
 * `~/.ssh`, `/etc/shadow`, the Docker socket — none of them are denied by a rule the process might
 * outwit; they simply do not exist inside the sandbox. Absence is a stronger guarantee than a
 * blocklist, and it is the guarantee the security tests actually verify.
 */

/**
 * The internal mountpoints the worker sees. The worker is told these via env (QH_WORKSPACE_ROOT,
 * QH_SCRATCH_ROOT) and never learns the real host path — one less thing that can leak into a tool
 * result or a model prompt.
 */
export const SANDBOX_WORKSPACE = '/qh/workspace';
export const SANDBOX_SCRATCH = '/qh/scratch';

function limitFlags(limits: ResourceLimits): string[] {
  const flags: string[] = [];
  if (limits.cpuSeconds !== undefined) flags.push(`--cpu=${limits.cpuSeconds}`);
  if (limits.fileSizeBytes !== undefined) flags.push(`--fsize=${limits.fileSizeBytes}`);
  if (limits.openFiles !== undefined) flags.push(`--nofile=${limits.openFiles}`);
  if (limits.processes !== undefined) flags.push(`--nproc=${limits.processes}`);
  if (limits.addressSpaceBytes !== undefined) flags.push(`--as=${limits.addressSpaceBytes}`);
  return flags;
}

export interface BuildBwrapOptions {
  /**
   * Path to `prlimit`. When present AND the spec has limits, the target is wrapped so rlimits are
   * applied in the child before it execs (bwrap has no rlimit flags of its own). When null, rlimits
   * are skipped and the deadline plus process-group teardown are the bound.
   */
  readonly prlimitPath?: string | null;
}

/**
 * Builds the exact `bwrap` argv for a spec. Pure and total, so it is unit-testable without
 * spawning anything — the security tests assert on this argv AND on real execution.
 */
export function buildBwrapArgs(spec: SandboxSpec, options: BuildBwrapOptions = {}): string[] {
  const iso = spec.isolation;
  const args: string[] = [];

  // Every namespace unshared. `--unshare-net` is included here and only reversed below when the
  // network is explicitly granted, so the default is no-network by construction.
  args.push(
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup',
  );
  if (!iso.networkAllowed) args.push('--unshare-net');

  // Die with the parent, and start a new session so the child cannot reach the controlling
  // terminal — this closes the TIOCSTI keystroke-injection vector.
  args.push('--die-with-parent', '--new-session');

  // Drop EVERY capability inside the namespace. This is not optional and is easy to forget: probed
  // on this host, a bwrap child of a ROOT runtime otherwise keeps a full capability set
  // (CapEff=000001ffffffffff). Dropping all capabilities is what makes "uid 0 in the sandbox"
  // harmless — without it the isolation is a facade when the daemon runs as root.
  args.push('--cap-drop', 'ALL');

  // A read-only OS. The toolchain (node, git, sh) lives under /usr; it is never writable.
  //
  // /etc is DELIBERATELY NOT bound. Binding it read-only would still expose /etc/shadow and any
  // credential a user left in /etc to a uid-0 process inside the sandbox — and /etc/** is a
  // protected path in the threat model. A coding tool does not need the host's /etc; when a
  // workload genuinely needs TLS roots or resolv.conf (only meaningful once network is granted)
  // the backend adds those specific files as extra binds, never the whole directory.
  args.push('--ro-bind', '/usr', '/usr');

  // Merged-/usr: on this host /bin, /sbin, /lib, /lib64 are symlinks into /usr. Recreate them
  // INSIDE the sandbox with `--symlink` so `/bin/sh`, the dynamic loader at `/lib64/ld-linux…`,
  // etc. resolve. Binding the symlink targets directly would not help — the loader looks for the
  // conventional paths. (`--symlink a b` makes b -> a; the target is under the bound /usr.)
  args.push('--symlink', 'usr/bin', '/bin');
  args.push('--symlink', 'usr/sbin', '/sbin');
  args.push('--symlink', 'usr/lib', '/lib');
  args.push('--symlink', 'usr/lib64', '/lib64');

  // Minimal /proc and /dev. Not the host's — a private proc scoped to the child's PID namespace.
  args.push('--proc', '/proc', '--dev', '/dev');
  // A private /tmp so the child cannot see or collide with host temp files.
  args.push('--tmpfs', '/tmp');

  // The workspace. Read-only isolation binds it ro; workspace-write binds it rw. This is the
  // single line that distinguishes `plan` from `ask` at the filesystem level.
  const workspaceMode = iso.mode === 'workspace-write' ? '--bind' : '--ro-bind';
  args.push(workspaceMode, iso.workspaceRoot, SANDBOX_WORKSPACE);

  // Scratch is always writable, even under read-only isolation: a read-only tool still needs a
  // place for a temp file, and keeping it off the workspace means read-only really is read-only.
  if (iso.scratchRoot !== undefined) {
    args.push('--bind', iso.scratchRoot, SANDBOX_SCRATCH);
  }

  for (const bind of iso.extraBinds ?? []) {
    args.push(bind.mode === 'rw' ? '--bind' : '--ro-bind', bind.source, bind.dest);
  }

  // Clear the environment, then set back ONLY what the spec chose. `--clearenv` is the belt to the
  // allowlist's braces: even if the caller forgot to minimize, nothing from the parent leaks.
  args.push('--clearenv');
  for (const [name, value] of Object.entries(spec.env)) {
    args.push('--setenv', name, value);
  }
  args.push('--setenv', 'QH_WORKSPACE_ROOT', SANDBOX_WORKSPACE);
  if (iso.scratchRoot !== undefined) args.push('--setenv', 'QH_SCRATCH_ROOT', SANDBOX_SCRATCH);

  args.push('--chdir', spec.cwd);

  // Terminate bwrap's own argv. Everything after `--` is the program (or the prlimit wrapper).
  args.push('--');

  // Apply rlimits by wrapping the target in prlimit, which sets them and then execs. Lowering an
  // rlimit needs no capability, so this works even after --cap-drop ALL. On this host CPU, FSIZE,
  // NOFILE and AS fire deterministically; NPROC is best-effort in an unprivileged userns (see
  // spec.ts), so the reliable bound on a fork bomb remains the deadline plus group teardown.
  const limits = iso.limits ?? DEFAULT_RESOURCE_LIMITS;
  const flags = limitFlags(limits);
  if (options.prlimitPath != null && flags.length > 0) {
    args.push(options.prlimitPath, ...flags, '--');
  }

  args.push(spec.command, ...spec.args);
  return args;
}

/** The host paths a spec makes reachable, for audit and for `doctor` to display. */
export function reachablePaths(spec: SandboxSpec): readonly string[] {
  const iso = spec.isolation;
  const paths = ['/usr (ro)', '/proc (minimal)', '/dev (minimal)', '/tmp (private tmpfs)'];
  const mode = iso.mode === 'workspace-write' ? 'rw' : 'ro';
  paths.push(`${iso.workspaceRoot} -> ${SANDBOX_WORKSPACE} (${mode})`);
  if (iso.scratchRoot !== undefined) paths.push(`${iso.scratchRoot} -> ${SANDBOX_SCRATCH} (rw)`);
  for (const bind of iso.extraBinds ?? []) paths.push(`${bind.dest} (${bind.mode})`);
  return paths;
}

export interface SandboxRunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * Runs a spec under bwrap. Separate stdout/stderr, bounded output, a hard deadline, and
 * whole-process-group teardown.
 *
 * The deadline + group kill is the *reliable* bound on a fork bomb: RLIMIT_NPROC is best-effort in
 * an unprivileged userns (see spec.ts), so we do not depend on it. When the deadline fires we kill
 * the bwrap process group, and because every descendant lives in bwrap's PID namespace, killing
 * bwrap reaps the entire tree — there are no orphans to leak.
 */
export function runSandboxed(
  bwrapPath: string,
  spec: SandboxSpec,
  now: () => number,
  options: BuildBwrapOptions = {},
): Promise<SandboxRunResult> {
  // bwrap IS the leader of the process group; every tool descendant lives beneath it, so the
  // shared supervisor's group-kill reaps the entire sandbox tree.
  return supervise(bwrapPath, buildBwrapArgs(spec, options), spec, now);
}
