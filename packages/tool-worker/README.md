# @qwen-harness/tool-worker

The capability-scoped RPC boundary and the sandboxed handlers.

`handlers.ts` is the **only** place in the product where model-initiated filesystem, shell, and Git
I/O actually executes, and it runs exclusively inside the bubblewrap-sandboxed worker process
(`worker-main.ts`). Everything else — runtime, policy, provider, TUI — coordinates. This executes.

## The RPC carries handles, not paths

The runtime says `{handle: 'workspace', relative: 'a.ts'}`. It **cannot** say
`/home/user/project/a.ts`, and it cannot say `/etc/passwd` — the type does not permit an absolute
host path to cross this boundary at all.

The sandbox is the boundary that must not be bypassed. The capability handle is the boundary that
makes a bypass *unrepresentable*. A confused-deputy bug in the runtime cannot ask the worker to
touch something outside the workspace, because there is no way to phrase the request.

## Path resolution, and why each check exists

`resolveScoped` refuses, in order:

1. **An absolute `relative`.** `path.join(root, '/etc/passwd')` yields `/etc/passwd`. Rejected.
2. **Traversal, after normalization.** `../../../etc/passwd` and its dot-segment variants.
3. **Symlink escape, after canonicalization.** A symlink *inside* the workspace pointing at
   `/etc/passwd` is textually contained, so a naive prefix check passes. Every existing ancestor is
   canonicalized — not just the leaf — because a symlinked *parent directory* escapes too.
4. **TOCTOU.** Between the containment check and the open, an attacker with workspace write access
   can swap a file for a symlink. We open with `O_NOFOLLOW` and confirm the file descriptor we hold
   is the file we vetted, by comparing device + inode.
5. **Pre-existing hardlinks.** A hardlink to a file outside the workspace is indistinguishable from
   a normal file by path alone — canonicalization does not help, because there is no link to
   resolve. Only the link count reveals it. Safe profiles refuse them (defaults.md).

Tested against a **real** filesystem with real symlinks and real hardlinks. A path-escape test
against a mocked `fs` would prove nothing: the bugs live precisely in how the kernel resolves the
things we are defending against.

## Shell

- `spawn` with `detached: true` puts the child in its own **process group**, so cancellation kills
  the whole tree. Killing only the leader is the classic bug — `sh -c 'sleep 100 & wait'` leaves an
  orphan that outlives the turn.
- stdout and stderr stay **separate**. Interleaving them loses the distinction between a result and
  its diagnostics, and lets stderr noise corrupt parseable output.
- An output flood is stopped **at the source**, not trimmed at the end: a process printing gigabytes
  would otherwise exhaust memory before we ever got to truncate it.
- The child environment is an allowlist that **excludes the provider credential**. The sandbox already
  strips the parent environment, but the worker never relies on a single control.

## Git

Every `git` invocation passes `-c core.hooksPath=/dev/null` and neutralizes global/system config.
A repository's Git hooks are attacker-controlled content — a malicious repo can ship a
`.git/hooks/post-checkout` and wait for a tool to trigger it. `git status` must never execute code
the repository chose.

## The client, and how a tool call actually runs

`ToolWorkerClient` lives in the runtime process but performs no tool I/O itself. For each request
it spawns a **fresh bubblewrap-sandboxed worker** — one process per tool call. No state survives
between calls, so a compromise in one execution cannot bleed into the next.

The worker ships as a **single self-contained bundle** (`dist/worker.bundle.mjs`, zod inlined). It
has to be: inside the sandbox there is no `node_modules` to import from, so a multi-file worker with
external dependencies could not run. The client binds exactly that one file, read-only, and nothing
else beyond the workspace, the private scratch dir, and the read-only OS under `/usr`.

The request frame is written to the scratch dir (a file, not argv/env — a write's content can
exceed `ARG_MAX`) and the worker reads it from the sandbox-internal path `/qh/scratch/request.json`.
The response comes back on stdout as one typed frame.

`test/integration/sandboxed-tools.test.ts` runs the whole path against the real sandbox: read with
pagination, write that lands on the host, edit with stale-file rejection, shell with separated
stdout/stderr, a read-only grant refusing a write, and a `../../../etc/passwd` escape refused — all
through a real bwrap process, not a mock.
