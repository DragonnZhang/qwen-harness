# Getting started

From a clean Linux host to a finished coding task.

## 1. Prerequisites

The harness targets Linux and nothing else. On any other platform `doctor` reports
`✗ not Linux — this product targets Linux only` and exits non-zero.

| Requirement | Why it is required | Check |
|---|---|---|
| **Node.js 24.x** (frozen: v24.16.0) | the runtime; the sandboxed tool worker is itself a Node process | `node --version` |
| **pnpm 11.x** (frozen: 11.9.0) | workspace manager; the build-script approvals live in `pnpm-workspace.yaml` | `pnpm --version` |
| **`bubblewrap`** (`/usr/bin/bwrap`) | the real sandbox backend (ADR 0003). Without it, no tool call runs. | `bwrap --version` |
| **unprivileged user namespaces enabled** | bubblewrap remaps uids without being setuid | `cat /proc/sys/user/max_user_namespaces` |
| **`build-essential`** (`cc`, `g++`, `make`) | `better-sqlite3` and `node-pty` have **no prebuilt binary** for this platform and compile from source during install | `cc --version` |
| **`prlimit`** (optional) | applies CPU/file-size/fd rlimits inside the sandbox. Missing is survivable; `doctor` says so. | `prlimit --version` |

On Ubuntu/Debian:

```sh
sudo apt-get update
sudo apt-get install -y bubblewrap build-essential util-linux
```

If unprivileged user namespaces are disabled, enable them:

```sh
sudo sysctl -w user.max_user_namespaces=10000
# on kernels that use the older knob:
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

## 2. Install and build

```sh
git clone https://github.com/DragonnZhang/qwen-harness.git
cd qwen-harness
pnpm install          # compiles better-sqlite3 and node-pty from source — this needs build-essential
pnpm build
```

`pnpm build` runs `tsc --build` across the workspace. The CLI entry point lands at
`apps/cli/dist/bin.js`.

The workspace packages are `private`, so nothing is installed onto your `PATH`. Invoke the CLI by
path, or give yourself a shorthand — the rest of this guide writes `qwen-harness` for brevity:

```sh
alias qwen-harness='node /path/to/qwen-harness/apps/cli/dist/bin.js'
```

## 3. Provide the credential

The harness reads the model key from an environment variable. Configuration files store the
**name** of that variable, never a value — a config file that contained a key would put the secret
into every export, log, and support archive.

Load it without leaving it in your shell history:

```sh
read -rsp 'DashScope API key: ' DASHSCOPE_API_KEY && printf '\n'
export DASHSCOPE_API_KEY
```

`DASHSCOPE_API_KEY` is the default variable name. To read the key from a differently-named variable,
set `apiKeyEnv` (see the [configuration reference](configuration.md)) — but note that in the current
CLI only `doctor` reports that setting; the provider always reads `DASHSCOPE_API_KEY`.

## 4. Run `doctor`

`doctor` is the first thing to run on any new host. It reports the platform, probes the sandbox,
resolves your configuration with provenance, and reports whether the credential is **present** — it
never reads or prints the value.

```sh
node apps/cli/dist/bin.js doctor
```

A healthy host (exit code `0`):

```text
qwen-harness doctor

platform: linux x64, node v24.16.0
sandbox: ✓ bubblewrap (bubblewrap 0.11.1)
  · bwrap-binary: /usr/bin/bwrap
  · prlimit-binary: /usr/bin/prlimit
  · bwrap-version: bubblewrap 0.11.1
  · user-namespaces: user.max_user_namespaces=7530
  · runtime-probe: bwrap created a namespace and ran a probe process
config:
  model = qwen3.7-max  (from builtin)
  baseUrl = https://dashscope.aliyuncs.com/compatible-mode/v1  (from builtin)
  apiKeyEnv = DASHSCOPE_API_KEY  (from builtin)
  permissionProfile = ask  (from builtin)
credential: DASHSCOPE_API_KEY is ✓ present (value never read or printed here)
```

### What `doctor` says when something is missing

`doctor` exits `3` when anything blocks a safe, non-degraded run. The message is written to be
actionable, not merely truthful.

- **bubblewrap not installed**

  ```text
  sandbox: ✗ unavailable — bubblewrap is not installed; `apt-get install bubblewrap` (PK-01 prerequisite)
    a safe profile cannot run without a real sandbox; release cannot pass degraded
    ✗ bwrap-binary: not found in /usr/bin/bwrap, /usr/local/bin/bwrap, /bin/bwrap
  ```

- **user namespaces disabled**

  ```text
  sandbox: ✗ unavailable — user.max_user_namespaces is 0; enable it with `sysctl -w user.max_user_namespaces=10000`
  ```

  or, on a kernel using the other knob:

  ```text
  kernel.unprivileged_userns_clone is 0; enable it with `sysctl -w kernel.unprivileged_userns_clone=1`
  ```

- **bwrap present but cannot create a namespace** (a hardened container, a seccomp policy):

  ```text
  ✗ runtime-probe: bwrap failed to create a namespace (ENOENT); the host may forbid unprivileged user namespaces
  ```

  This probe *actually runs* bwrap. A binary that exists but cannot unshare is not a usable backend,
  and the only honest way to know is to try.

- **credential absent**

  ```text
  credential: DASHSCOPE_API_KEY is ✗ absent (value never read or printed here)
    the live model gate cannot run without it; deterministic work is unaffected
  ```

- **`prlimit` missing** — not fatal, and reported as such:

  ```text
  · prlimit-binary: not found; rlimits will be skipped (deadline + group-kill still apply)
  ```

## 5. Your first task

Work inside the repository you want changed. The harness keeps its state under that directory, so a
run is self-contained and inspectable.

Start in `plan`, which cannot mutate anything — mutating tools are not merely blocked, they are never
offered to the model:

```sh
cd ~/src/my-project
node /path/to/qwen-harness/apps/cli/dist/bin.js run --profile plan "what does src/server.ts do, and where is the retry logic?"
```

Then let it actually change code. The default profile, `ask`, prompts you before every side effect,
showing the exact action:

```sh
node /path/to/qwen-harness/apps/cli/dist/bin.js run "add a unit test for parseConfig in src/config.ts"
```

```text
  permission required  (risk: MEDIUM)
  tool:   write_file
  action: write /home/dev/src/my-project/src/config.test.ts
  why:    ask: every side effect prompts with its exact normalized parameters
  approve? [y]es once / [s]ession / [N]o: y
```

`y` approves that exact action once; `s` approves for the session; anything else — including just
pressing Enter — denies. Nothing is ever auto-approved.

You will see the assistant's final text on stdout, and a status line on stderr:

```text
[completed: natural-completion]  session thr_m4x8c2a0001
```

If you would rather not be interrupted for ordinary edits, use `auto-accept-edits`: it auto-allows a
dedicated file tool writing an ordinary file **inside the workspace**, and still asks for everything
else — shell, network, external paths, executables, package manifests, `.git`:

```sh
node /path/to/qwen-harness/apps/cli/dist/bin.js run --profile auto-accept-edits "add a unit test for parseConfig in src/config.ts"
```

> **Scripting?** `--json` suppresses the prompt — a machine caller has nobody to ask. An action that
> needs approval then leaves the turn in state `awaiting-approval`, durably, exiting `3`. Answer it
> later with `qwen-harness resume <id>`. See [Approvals](cli.md#approvals).

## 6. Continue the work

Every run is durable. List, continue, branch, and export sessions:

```sh
qwen-harness sessions                          # thr_…  turns=2  (unnamed)
qwen-harness resume thr_m4x8c2a0001 "now run the test and fix any failure" --profile auto-accept-edits
qwen-harness fork   thr_m4x8c2a0001            # branch a new line of work from the same history
qwen-harness export thr_m4x8c2a0001 > session.jsonl
```

See [Sessions](sessions.md) for what is stored, where, and what fork actually copies.
