# The sandbox

The harness does not classify command strings and call that a sandbox. Model-initiated file, shell,
and Git work executes in a **separate process created by bubblewrap** — a real Linux isolation
backend using namespaces, with the runtime process never touching the workspace on the model's
behalf.

Source of truth: `packages/sandbox-linux/src/`, `packages/tool-worker/src/`, and
[ADR 0003](../decisions/0003-sandbox-backend-bubblewrap.md).

## The core idea

**A path is denied by not binding it.**

bubblewrap starts the child in an empty mount namespace, and the backend binds in only what the
grant permits. `/root`, `~/.ssh`, `/etc/shadow`, the Docker socket — none of them are denied by a
rule the process might outwit. They *do not exist* inside the sandbox. Absence is a stronger
guarantee than a blocklist, and it is what the security tests actually verify.

## What every tool call gets

One fresh sandboxed process per tool call:

1. A private host scratch directory is created (`/tmp/qh-rpc-…`).
2. The request is written to a file in it — not to argv, not to an env var, so a large payload cannot
   hit `ARG_MAX`.
3. The child environment is built from an **allowlist**: `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`,
   `TERM`, plus the sandbox's own `QH_*` handles and `HOME`/`TMPDIR` pointed at scratch. Everything
   else — including the model credential, `SSH_AUTH_SOCK`, and any cloud session token — simply does
   not exist for the child. `--clearenv` is the belt to that allowlist's braces.
4. bubblewrap runs the Node worker bundle inside the namespace.
5. The scratch directory is removed afterwards.

The worker sees the workspace at `/qh/workspace` and scratch at `/qh/scratch`. It never learns the
real host path — one less thing that can leak into a tool result or a model prompt.

## What is actually blocked

| Control | How | Result |
|---|---|---|
| **Filesystem** | empty mount namespace; only `/usr` (read-only), a private `/proc` and `/dev`, a `tmpfs` `/tmp`, the workspace, and scratch are bound | the host home, `/etc`, `/root`, and every credential store are *not present* |
| **`/etc`** | deliberately **not bound at all**, not even read-only | `/etc/shadow` and anything a user left in `/etc` are unreachable even to a uid-0 process inside the sandbox |
| **Network** | `--unshare-net` unless the grant explicitly allows network | no egress. The CLI's grant sets `network: false`. |
| **Process tree** | `--unshare-pid`, `--die-with-parent`, and whole-process-group teardown | no orphaned runaway; the child cannot see host processes |
| **Terminal** | `--new-session` | the child cannot reach the controlling terminal — this closes the `TIOCSTI` keystroke-injection vector |
| **Capabilities** | `--cap-drop ALL` | this is what makes "uid 0 inside the sandbox" harmless. Without it, a bwrap child of a root runtime keeps a full capability set, and the isolation is a facade. |
| **IPC / UTS / cgroup** | `--unshare-ipc`, `--unshare-uts`, `--unshare-cgroup` | no shared SysV IPC, no host hostname, no cgroup escape surface |
| **Resources** | `prlimit`, when present: CPU 300 s, max file size 2 GiB, 1,024 open files, 512 processes | a runaway is bounded. When `prlimit` is missing, the wall-clock deadline plus process-group kill remain — `doctor` tells you which controls are active. |
| **Read-only mode** | `plan` binds the workspace `--ro-bind` | the single line that separates `plan` from `ask` at the filesystem level |

Scratch is writable in **every** mode, including read-only isolation: a read-only tool still needs
somewhere to put a temp file, and keeping that off the workspace is what makes read-only actually
read-only.

`RLIMIT_AS` (virtual address space) is **off by default**, and that is a considered decision, not an
oversight: on this kernel Node reserves multiple GB of *virtual* address space for pointer
compression even when its RSS is tiny, so a low `RLIMIT_AS` makes Node abort at startup — and the
tool worker *is* a Node process. CPU time, file size, and open files are the caps that bound a
runaway without breaking the legitimate workload.

## What the sandbox does **not** do

Say this plainly, because a sandbox oversold is a sandbox that gets trusted where it should not be:

- It does not make untrusted native code safe. A kernel vulnerability is a kernel vulnerability. For
  genuinely hostile code, use a disposable VM, not a permission profile.
- It does not restrict what a *granted* network call can reach beyond the policy layer's host rules.
  In the CLI the grant denies network entirely, so this is moot today.
- It does not protect the workspace from itself. In `workspace-write` isolation, a tool can write
  anywhere in your repository — that is the point. Protected paths (`.env`, `*.pem`, `.git/**`) are
  enforced by *policy*, above the sandbox, and remain protected even inside the workspace.
- It is not a substitute for reading the diff.

## Host requirements and the known caveats

`doctor` probes all of this and prints exactly what it found. See
[Getting started](getting-started.md#4-run-doctor).

**bubblewrap must be installed** (`/usr/bin/bwrap`, `/usr/local/bin/bwrap`, or `/bin/bwrap`) and
**unprivileged user namespaces must be enabled**. The detection ends with a *runtime probe* that
actually runs bwrap: a binary that exists but cannot create a namespace — a hardened container, a
seccomp policy, a missing capability — is not a usable backend, and trying is the only honest way to
know.

**The merged-`/usr` + uutils caveat.** On the target host (Ubuntu 26.10):

- `/usr` is merged: `/bin`, `/sbin`, `/lib`, `/lib64` are symlinks into `/usr`;
- coreutils is **uutils** (the Rust rewrite): `/usr/bin/true` is itself a symlink to a
  dynamically-linked binary that needs the loader under `/lib64`.

Binding only the real directories is therefore not enough. The sandbox **recreates the merged-`/usr`
symlinks inside the namespace** (`--symlink usr/bin /bin`, and the same for `/sbin`, `/lib`,
`/lib64`), or `/bin/sh`, the dynamic loader, and every coreutils binary fail to resolve. The
capability probe does the same thing — otherwise it would misreport a perfectly working sandbox as a
namespace failure.

If you port this to a distribution without merged `/usr`, that is the code to look at first.

## Failing closed

A safe profile cannot run without a real sandbox. When the backend is unavailable, `doctor` reports
the exact missing kernel or package capability, says
`a safe profile cannot run without a real sandbox; release cannot pass degraded`, and exits `3`.
Release gates do not pass in a degraded mode. A policy-only "sandbox" is not a sandbox and is not
offered as a fallback.
