# ADR 0003: Bubblewrap as the Linux sandbox backend

Status: accepted
Date: 2026-07-12
Checkpoint: 00

## Context

`docs/security/threat-model.md` and matrix rows `SB-01`..`SB-04` require a **real** Linux
isolation backend. A deny-string list is explicitly not a sandbox, and a policy-only fallback
cannot pass the release gate. The backend must constrain filesystem, network, process tree,
environment, devices/IPC, and resources, and it must be able to host the **tool-worker process**
so that model-initiated file, shell, and Git I/O never executes in the runtime process.

Candidates available on the target host: `bubblewrap` (present), `unshare`/`setpriv` (present),
Docker (absent), Podman (absent).

## Decision

Use **bubblewrap** (`/usr/bin/bwrap`) as the sandbox backend.

Every control class was probed on the actual target host at checkpoint 00 and observed to hold
(see `docs/execution/checkpoints/00-preflight-and-contract-probes.md` §3), including running
Node.js itself inside the sandbox — which is what makes the capability-scoped tool-worker
architecture viable rather than aspirational.

Rejected alternatives:

- **Docker / Podman**: not installed on the target, and requiring a container daemon would add a
  privileged always-on dependency for what is a per-tool-call sandbox. Container backends remain
  a possible future addition behind the same `SandboxBackend` interface.
- **Raw `unshare(2)` via a helper**: we would be reimplementing bubblewrap's careful
  setuid/user-namespace handling, mount propagation, and `--die-with-parent` semantics. That is
  security-critical code with no upside.
- **Policy-only (no OS isolation)**: forbidden by the threat model as a release-gating backend.
  It remains implemented **only** as an explicitly-degraded mode that `doctor` reports and that
  fails `pnpm check`.

## Consequences

1. `packages/sandbox-linux` wraps `bwrap` behind a typed `SandboxBackend` interface and is the
   only package permitted to construct a sandboxed process.
2. `bubblewrap` becomes a documented hard prerequisite for a non-degraded install. `PK-01` must
   detect it, and `doctor` (`SB-03`) must report its absence as a degradation that fails release.
3. Because unprivileged user namespaces are enabled on the target, the sandbox does not require
   the runtime to be root. The probe confirmed uid remapping works.
4. `yolo` disables the default sandbox by design; the managed-policy ceiling, redaction, audit,
   budgets, cancellation, and terminal sanitization remain active regardless (threat model,
   §"yolo").
5. Sandbox escape attempts (path, symlink, process, network, resource) are a required security
   suite, not a claim. String matching alone can never satisfy `SB-04`.
