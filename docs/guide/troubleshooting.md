# Troubleshooting

Real failures, with the real messages. Every string here is produced by the code.

## `doctor` says the sandbox is unavailable

```text
sandbox: ✗ unavailable — bubblewrap is not installed; `apt-get install bubblewrap` (PK-01 prerequisite)
  a safe profile cannot run without a real sandbox; release cannot pass degraded
  ✗ bwrap-binary: not found in /usr/bin/bwrap, /usr/local/bin/bwrap, /bin/bwrap
```

Install it: `sudo apt-get install -y bubblewrap`. There is no policy-only fallback — a deny-string
list is not a sandbox, and offering one as a fallback would be the dangerous kind of convenience.

```text
sandbox: ✗ unavailable — user.max_user_namespaces is 0; enable it with `sysctl -w user.max_user_namespaces=10000`
```

Or, on a kernel using the older knob:

```text
kernel.unprivileged_userns_clone is 0; enable it with `sysctl -w kernel.unprivileged_userns_clone=1`
```

```text
✗ runtime-probe: bwrap failed to create a namespace (ENOENT); the host may forbid unprivileged user namespaces
```

bwrap exists but cannot unshare. Common causes: you are inside a container that forbids nested user
namespaces, an AppArmor/seccomp profile blocks `clone(CLONE_NEWUSER)`, or the kernel was built
without `CONFIG_USER_NS`. A hardened container is the usual culprit; run the harness on the host, or
grant the container the ability to create user namespaces.

If the failure looks like a *missing loader or missing `/bin/sh`* rather than a namespace refusal,
you are probably on a distribution without merged `/usr`. See
[the sandbox guide](sandbox.md#host-requirements-and-the-known-caveats).

## `prlimit` is missing

```text
· prlimit-binary: not found; rlimits will be skipped (deadline + group-kill still apply)
```

Not fatal. CPU/file-size/fd caps will not be applied inside the sandbox; the wall-clock deadline and
whole-process-group teardown still bound a runaway. Install `util-linux` to get them back.

## The credential is missing

```text
credential: DASHSCOPE_API_KEY is ✗ absent (value never read or printed here)
  the live model gate cannot run without it; deterministic work is unaffected
```

and, from a `run` (exit code **3**):

```text
run: No DashScope API key found (env:DASHSCOPE_API_KEY). Set DASHSCOPE_API_KEY in the environment, then retry. The harness stores the variable name, never its value.
```

Export the variable in the shell you run from:

```sh
read -rsp 'DashScope API key: ' DASHSCOPE_API_KEY && printf '\n'
export DASHSCOPE_API_KEY
```

An **empty or whitespace-only** variable counts as absent, on purpose: `export DASHSCOPE_API_KEY=`
would otherwise turn a clear "you have no key" into an opaque 401 from the server.

Note that this failure is thrown **before** the request body is built and before any socket opens.

## The run stopped with `awaiting-approval` (exit 3)

```text
this turn is waiting for an approval: write /repo/hello.txt

[awaiting-approval]  session thr_m4x8c2a0001
answer it with: qwen-harness resume thr_m4x8c2a0001
```

This is not a failure. Policy needed a human decision and there was nobody to ask — you passed
`--json`, or stdin was closed or piped from `/dev/null`, or the turn was cancelled while the prompt
was up. The harness will not invent consent, so it suspended the turn and wrote it down.

Answer it, and the **same turn** continues from where it stopped:

```sh
qwen-harness sessions          # shows [awaiting approval: …]
qwen-harness resume thr_m4x8c2a0001
```

If you meant to send a new instruction instead, note that the CLI will stop you rather than guess:

```text
resume: this session is waiting for an approval (write /repo/hello.txt). Answer it first with `resume thr_…` — an approval continues the same turn and is not a new message.
```

To avoid the prompt for ordinary edits in the first place, use `--profile auto-accept-edits`, which
auto-allows in-workspace file writes and still asks for shell, network, external paths, executables,
package manifests, and `.git` writes.

## A tool call was denied

```text
denied: 'file-write' is unavailable in plan: plan exposes read, search and analysis only
denied: action is not canonical (/repo/../etc/passwd: contains a '..' segment)
```

A `plan` denial is **sealed**: no flag, rule, or retry will loosen it within that turn. Re-run with a
profile that permits mutation.

A *non-canonical action* denial is not negotiable either — the engine denies a path with `.` or `..`
segments outright rather than asking about it, because a non-canonical path is either a bug or an
attack, and neither is something to prompt a human about. Note that the model is asked for
workspace-relative paths and an absolute path is rejected at the schema layer before policy even
sees it.

## The turn stopped early

Check `state` and `reason` in `--json`:

| `reason` | What happened |
|---|---|
| `no-progress` | three rounds with no progress — the model stopped doing anything useful |
| `repeated-identical-calls` | the same tool call with the same arguments three times — a loop |
| `tool-call-limit`, `model-call-limit`, `time-limit`, `turn-limit` | a budget was hit; see [Budgets](sessions.md#budgets-and-cancellation) |
| `retry-limit` | the provider kept failing |
| `provider-error` | the model request failed; the `detail` field carries the message the engine recorded |
| `user-cancelled` | you interrupted it |

No budget is ever silently raised. If a task genuinely needs more, raise it deliberately and expect a
warning.

## A side effect is stuck `indeterminate`

Symptom: a tool call comes back as

```text
(skipped: outcome is indeterminate after interruption; requires inspection, never blind replay)
```

This means a previous run was interrupted (crash, kill, power loss) between "started this side
effect" and "recorded its outcome". The harness **does not guess**. Assuming it failed and retrying
is how you get a double-write; assuming it succeeded silently skips work that may never have
happened. So it refuses and asks for a human.

**What to do:** look at the workspace and decide whether the action actually took effect (did the
file get written? does the change look complete?). Then continue in a **fresh session**, or fork the
thread — a fork does not copy the side-effect ledger, so it starts clean.

**Known gap:** there is no `qwen-harness` command to list or clear indeterminate side effects today.
The storage layer implements both (`listIndeterminate`, `recoverInterrupted`), but no app calls them.
Until that is wired, the ledger is inspectable directly:

```sh
sqlite3 .qwen-harness/sessions.sqlite \
  "select id, normalized_action, state from side_effects where state in ('in-flight','indeterminate');"
```

Deleting a row is a deliberate assertion that you have checked the host and know the truth. Do not do
it to make an error go away.

## A config file is rejected

The error always names the file and the stage:

```text
config file /home/dev/.config/qwen-harness/config.json: parse failed (…)
config file /home/dev/src/app/.qwen-harness/config.json: schema failed (…)
config file /etc/qwen-harness/managed.json: migration failed (…)
```

Unknown keys are rejected on purpose: a typo should be a visible error, not a silently ignored
setting that makes `doctor` explain a value you never set.

## A config file is from a newer build

```text
config schema version 2 is newer than this build understands (max 1); upgrade the harness rather than editing the version down
```

Do exactly what it says. Editing the version number down does not make an old build understand new
keys; it makes it *misread* them. Upgrade the harness, or (if you must roll back) restore the config
file from before the newer build touched it.

## An export will not import

```text
export is format version 3, this build understands up to 1
export claims 42 events but contains 41
unrecognized export format: something-else
empty export: missing header line
```

The truncated-export case (`claims N but contains M`) usually means the file was cut off — a full
disk, a killed pipe, a partial copy. Re-export it.

## `pnpm install` fails compiling native modules

`better-sqlite3` and `node-pty` have **no prebuilt binary** for this platform and Node version; they
compile from source. Install a toolchain:

```sh
sudo apt-get install -y build-essential
```

This is why `build-essential` is a documented prerequisite rather than a footnote.

## A second daemon refuses to start

```text
daemon: thread is locked by a live daemon (pid 4711); attach to it instead of starting a second one
```

Exit code `3`. This is the **single-writer lease** working as designed: exactly one runtime holds the
writer lease for a workspace. The second daemon does not win a race, retry, or open a second SQLite
writer — it refuses, and tells you where the live one is.

A **stale** lease (the holder died) is handled automatically: the lease file's pid is probed for
liveness, and a dead holder's lock is reclaimed. A lock held by a live process is never stolen, and a
daemon only ever releases a lease it still owns. So this message means a daemon really is running —
check with `ps -p 4711`.

The lease and socket live beside the session store:

```text
<workspace>/.qwen-harness/daemon.lease
<workspace>/.qwen-harness/daemon.sock
```

If you are certain the holder is gone and the pid check disagrees (a pid was recycled), remove the
lease file — but confirm first. Two writers on one event log is exactly the corruption the lease
exists to prevent.

Note that the CLI's `run`/`resume` do **not** take the daemon lease; two concurrent `qwen-harness run`
invocations in one directory will both write to the same SQLite file. WAL mode and a 5-second busy
timeout keep that safe at the row level, but the two turns know nothing about each other. Don't.
