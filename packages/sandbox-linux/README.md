# @qwen-harness/sandbox-linux

The real Linux sandbox backend (ADR 0003). Bubblewrap, proven on the target host.

This is a declared I/O owner: the **only** package that may construct a sandboxed process. It is
not a string classifier — "sandboxing" that inspects a command string is explicitly forbidden by
the threat model.

## The one idea

**A path is denied by NOT binding it.** The child starts in an empty mount namespace; we bind in
only what the spec permits. `/root`, `~/.ssh`, `/etc/shadow`, the Docker socket — none are denied
by a rule the process might outwit. They do not exist inside the sandbox. Absence is a stronger
guarantee than a blocklist, and it is exactly what the security tests verify by trying to reach
them and failing.

## What is proven, on this host, by real execution

`test/security/real-sandbox.test.ts` runs the actual sandbox and attempts actual escapes. A
sandbox test that mocks the sandbox proves nothing — whether the kernel confines the process is the
entire question, and only a real process answers it.

- Cannot see `/root`; cannot read a secret file outside the workspace; cannot read `~/.ssh`.
- `workspace-write` can write inside the workspace but not outside it.
- `read-only` makes the workspace itself unwritable, while scratch stays writable.
- A parent-process secret env var (a stand-in for the provider key) is **absent** from the child.
- The whole process tree is torn down on the deadline — a grandchild sleeper leaves no orphan.
- An output flood is bounded, not buffered forever.
- Network is denied by default and reachable only when explicitly granted (verified against a
  loopback server, so the test needs no internet).

## Fail closed

`detectCapability()` actually runs a bwrap smoke test rather than checking the binary exists — a
bwrap that is present but broken (userns disabled by a container runtime) must report unavailable,
or a safe profile would believe it was isolated when it was not. When the backend is unavailable a
safe profile fails **closed**: a missing sandbox is never silently downgraded to unconfined
execution, and `doctor` prints the exact missing capability (SB-03).

## Host-specific detail worth knowing (ADR 0003 addendum)

The target is merged-`/usr` with **uutils** (Rust) coreutils: `/bin`, `/lib`, `/lib64` are
symlinks into `/usr`, and `/usr/bin/true` is itself a symlink into `/usr/lib/cargo/...` that needs
the loader under `/lib64`. So `buildBwrapArgs` recreates those symlinks **inside** the namespace;
binding the real directories alone leaves `/bin/sh` and the dynamic loader unresolvable. The
capability smoke test does the same, or it would misreport a working sandbox as a namespace failure.

## rlimits

Applied by wrapping the target in `prlimit` (lowering a limit needs no capability, so it works
after cap-drop). CPU, FSIZE, and NOFILE fire deterministically. NPROC is best-effort in an
unprivileged user namespace, so the **reliable** bound on a fork bomb is the wall-clock deadline
plus whole-process-group teardown — not a limit we depend on. RLIMIT_AS is off by default: a Node
worker reserves gigabytes of virtual address space for pointer compression even at tiny RSS, so a
low RLIMIT_AS would abort the worker at startup.
