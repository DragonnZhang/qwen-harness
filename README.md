# qwen-harness

A standalone coding-agent harness: a headless runtime, a real Linux sandbox, a durable session log,
and a deny-by-default permission engine, backed by `qwen3.7-max` through Alibaba Cloud Model Studio
(DashScope).

It is a TypeScript/Node pnpm monorepo. There is no dependency on any other coding agent, and it
wraps none of them.

## Honest scope

Read this before you install anything.

- **Linux only.** `doctor` refuses to call any other platform healthy. The recorded target is Ubuntu
  26.10 on x86_64.
- **One model backend.** DashScope `qwen3.7-max` over the OpenAI-compatible endpoint. No second
  provider, no local model.
- **The headless CLI is the working surface.** `doctor`, `run`, `resume`, `sessions`, `fork`,
  `export`, with real interactive approvals. It is small and it works. A daemon shares the same
  composition and adds a single-writer lease plus socket-mediated approvals.
- **The TUI renders a demo.** The terminal UI is real, tested code — rendering model, sanitization
  boundary, approval dialog, keybindings — that has not yet been connected to the runtime. The remote
  worker has no launchable entry point.
- **Much of the domain layer is not reachable from a command.** MCP, memory, repository instructions,
  hooks, subagents, teams, background work, cron, and worktrees are implemented and tested as
  packages that no application imports yet. They are catalogued honestly in
  [`docs/guide/library-surface.md`](docs/guide/library-surface.md) rather than advertised.

## 60-second quickstart

```sh
# prerequisites: Node 24, pnpm 11, and:
sudo apt-get install -y bubblewrap build-essential util-linux

git clone https://github.com/DragonnZhang/qwen-harness.git
cd qwen-harness
pnpm install     # better-sqlite3 and node-pty compile from source — hence build-essential
pnpm build

# the key is read from an environment variable; config files store the NAME, never a value
read -rsp 'DashScope API key: ' DASHSCOPE_API_KEY && printf '\n'
export DASHSCOPE_API_KEY

node apps/cli/dist/bin.js doctor          # platform, sandbox probes, config provenance, credential presence

cd ~/src/my-project
node /path/to/qwen-harness/apps/cli/dist/bin.js run --profile auto-accept-edits "add a test for parseConfig"
```

`doctor` is the first thing to run on a new host: it probes bubblewrap by *actually running it*,
reports which configuration source won each value, and tells you whether the credential variable is
present — without ever reading it.

## Documentation

Start at **[`docs/guide/`](docs/guide/README.md)**.

| | |
|---|---|
| [Getting started](docs/guide/getting-started.md) | prerequisites, install, `doctor`, first task |
| [The CLI](docs/guide/cli.md) | every command, flag, exit code, and the JSON output |
| [Permissions and approvals](docs/guide/permissions.md) | the four profiles, deny-by-default, protected paths, grants |
| [The sandbox](docs/guide/sandbox.md) | what bubblewrap blocks — and what it does not |
| [Sessions](docs/guide/sessions.md) | resume, fork, export, budgets, the side-effect ledger |
| [The TUI](docs/guide/tui.md) | keybindings, the sanitization boundary, and its honest state |
| [Configuration reference](docs/guide/configuration.md) | every key: type, default, precedence, effect |
| [Troubleshooting](docs/guide/troubleshooting.md) | real failures with the real messages |
| [Operator guide](docs/guide/operations.md) | managed policy, redaction, telemetry, upgrades, credential exposure |
| [Library surface and gaps](docs/guide/library-surface.md) | what exists but is not yet reachable |

## The invariants

Each of these is enforced in code, and each is the reason something else in this product is
deliberately narrow.

- **Deny by default.** A side effect happens because something affirmatively allowed it — a profile,
  a rule, or a human approving that exact action. The managed ceiling is intersected *last*, so
  nothing downstream can loosen it.
- **Repository content cannot grant authority.** A project-scoped rule may `deny` or `ask`. It may
  never `allow`. The repo you are working on is attacker-controlled in the threat model.
- **The credential never leaves the provider boundary.** Configuration stores the environment
  variable's *name*; exactly one package may read its value, and the build fails if another package
  so much as names it. Sandboxed tools get an environment allowlist that excludes it.
- **A path is denied by not binding it.** The sandbox starts in an empty mount namespace. `~/.ssh`,
  `/etc`, and the Docker socket are not blocked by a rule a process might outwit — they do not exist
  inside it.
- **Untrusted text cannot own your terminal.** Model, tool, MCP, and repository text pass an
  allowlist sanitizer before display; only trusted chrome may emit control sequences.
- **The side-effect ledger never guesses.** An interrupted action is recorded as `indeterminate` and
  refused, because assuming failure double-writes and assuming success silently skips work.

## Security

The product offers explicit approval profiles and a real Linux isolation backend. It **does not**
claim that user approval alone makes untrusted code safe, and it does not market permission prompts
as a security boundary. In `yolo` you deliberately grant maximum authority the managed ceiling
allows. No local coding agent can make arbitrary untrusted native execution risk-free — for genuinely
hostile code, use a disposable VM.

The full model is in [`docs/security/threat-model.md`](docs/security/threat-model.md).

Do not put an API key in a configuration file: the schema rejects anything shaped like a key value
and accepts only a variable name. Any credential that reached a chat, a log, or a file should be
rotated. `pnpm secrets:scan` checks the working tree and never prints what it finds.

## Development

```sh
pnpm check              # format, lint, typecheck, architecture, build, and every test lane
pnpm test               # unit
pnpm test:security      # sandbox-escape and adversarial suites
pnpm test:pty           # the TUI under a real pseudo-terminal
pnpm secrets:scan       # credential scan of the working tree
pnpm architecture       # package-boundary and credential-isolation gates
```

The specification is frozen and authoritative:
[`docs/product/capability-matrix.md`](docs/product/capability-matrix.md),
[`docs/product/defaults.md`](docs/product/defaults.md),
[`docs/security/threat-model.md`](docs/security/threat-model.md),
[`docs/architecture/design.md`](docs/architecture/design.md), and the ADRs in
[`docs/decisions/`](docs/decisions/). [`task.md`](task.md) is the implementation objective;
[`AGENTS.md`](AGENTS.md) holds the engineering rules.

No open-source license is granted by this repository. Choose one explicitly before making it public.
