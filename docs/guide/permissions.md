# Permissions and approvals

Permission and isolation are **separate axes**. A profile decides what prompts and what is
available; isolation decides what the sandbox lets a tool touch. You can tighten either
independently, and neither can exceed the managed ceiling.

Source of truth: `packages/policy/src/` (the engine is pure — no filesystem, no clock, no
environment; `pnpm architecture` fails the build if that ever changes).

## The four profiles

| Profile | The model may… | Prompt behavior | Isolation the CLI uses |
|---|---|---|---|
| `plan` | read, search, inspect, reason | mutating tools are **not offered at all** | `read-only` |
| `ask` | everything | every side effect asks, with its exact normalized parameters | `workspace-write` |
| `auto-accept-edits` | everything | a dedicated file tool writing an ordinary file **inside** the workspace auto-allows; everything else asks | `workspace-write` |
| `yolo` | everything | no interactive prompts | `workspace-write` (see the note below) |

Compatibility aliases accepted by `--profile` and by the `permissionProfile` config key: `default`
and `manual` → `ask`; `acceptEdits` → `auto-accept-edits`; `bypassPermissions` → `yolo`.

**`plan` is not "ask, but stricter".** In `plan` a mutation is *unavailable*, and the deny is
**sealed**: no rule, grant, hook, MCP server, subagent, or shell interpreter downstream can turn it
back on. There is no code path from a sealed deny back to an allow. That is what makes "plan cannot
be smuggled through shell" a structural property rather than a promise.

**What `auto-accept-edits` will still ask about** — deliberately, and this is the point of the
profile:

- shell commands, *including* `mkdir`, `mv`, and `cp`. This product keeps them in the ask path.
- network access, MCP side effects, Git writes (destructive or not).
- any path outside the workspace root.
- a file that would become executable (a `#!` shebang counts), package manifests, Git hooks, and
  every protected path below.

**About `yolo`.** It means *maximum authority the managed ceiling allows* — not "no rules". Managed
hard denies, redaction, audit, budgets, cancellation, and terminal sanitization all remain active.
In the current CLI, `yolo` also still runs every tool call inside the bubblewrap sandbox with
`workspace-write` isolation: the CLI never passes `disabled` isolation to the worker. So today
`yolo` removes prompting (the CLI has none to remove) and removes the protected-path *ask*, but it
does not hand a tool the bare host. Do not rely on that as a security boundary — rely on not using
`yolo` on a repository you do not trust.

## How a decision is made

Every tool call — built-in, MCP, foreground, background — goes through one pipeline:

```text
schema → semantic → policy → (approval) → sandboxed worker
```

There is deliberately no shortcut. A second, simpler path would be a second place to forget a check.

Inside the policy stage, the **order is the security property**:

| # | Stage | What it can do |
|---|---|---|
| 0 | input validation | a non-canonical action (`.`/`..`, non-absolute, non-NFC) is **denied**, never asked about |
| 1 | profile | what this profile makes available at all |
| 2 | protected paths | overrides the profile; can **seal** a verdict against later loosening |
| 3 | rules | deny-first merge; a repository-scoped rule may never `allow` |
| 4 | grants | an exact human approval (or a validated narrow rule) can turn `ask` → `allow` |
| 5 | hooks | a hook may **restrict**; a hook `allow` is recorded and ignored |
| 6 | managed policy | the immutable ceiling, intersected **last** — nothing runs after it |
| 7 | user passthrough | a direct `!command` skips the model-approval gate, and nothing else |

Two mechanisms carry the invariants:

- **`sealed`** — no later stage may loosen this verdict. Set by `plan` and by protected paths.
- **`exactGrantOnly`** — only a digest-bound grant may loosen it: a human approving *this exact
  action*. A broad allow-rule cannot reach it.

Every stage appends to a trace, so a decision can always be explained: which rule, grant, or ceiling
won, and why. A decision nobody can audit is a decision nobody can trust.

### Why a project file cannot grant permission

Policy rules carry a scope: `project`, `user`, `local`, or `session`. Only `user`, `local`, and
`session` may `allow`. A `project` rule lives in the repository, which in the malicious-repo threat
model is attacker-controlled — so it may `deny` or `ask` and nothing else. A project `allow` is not
silently ignored; it is recorded in the trace as downgraded, with the note *"scope 'project' may not
allow; repository content cannot add authority"*.

The same asymmetry runs through configuration: `deny` lists take the **union** across every scope, so
a higher-precedence file can add a deny but can never remove one.

## Protected paths

These are protected regardless of profile. Credential classes are protected for **reads** too, not
only writes — exfiltration is the threat, and reading `~/.aws/credentials` is the attack.

| Class | Patterns | Applies to |
|---|---|---|
| `git-internal` | `**/.git`, `**/.git/**` | write |
| `credential-file` | `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/*.p12`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/_netrc`, `**/.git-credentials`, `**/.git/credentials`, `**/.config/git/credentials` | read + write |
| `user-credential-store` | `~/.ssh/**`, `~/.aws/**`, `~/.config/gcloud/**`, `~/.kube/**`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`, `~/.config/containers/auth.json`, `~/.local/share/keyrings/**`, `~/.gnupg/**` | read + write |
| `system-path` | `/etc/**`, `/proc/**`, `/sys/**`, `/dev/**`, `/boot/**`, `/root/**` | read + write |
| `daemon-socket` | `/var/run/docker.sock`, `/run/docker.sock`, `/run/containerd/**`, `/run/podman/**`, `/run/crio/**`, `/run/user/*/podman/**`, `/run/systemd/private` | read + write |
| `metadata-endpoint` | `169.254.169.254`, `100.100.100.100` (Alibaba Cloud), `metadata.google.internal`, `metadata.goog`, `fd00:ec2::254`, and the whole `169.254.0.0/16` link-local block | network |

Behavior per profile:

| Profile | Protected path |
|---|---|
| `plan` | deny (sealed) |
| `ask` | requires an **exact** grant for that specific action |
| `auto-accept-edits` | requires an **exact** grant |
| `yolo` | reachable unless managed policy denies it |

Two carve-outs, both deliberate:

- **`system-path` is exempt inside the workspace root.** Opening a workspace is a deliberate human
  act, and a repository legitimately lives at `/root/qwen-harness` on the recorded target host.
  Without the carve-out, every ordinary edit in that repo would classify as a protected `/root`
  write and `auto-accept-edits` would prompt for all of them — which trains people to click through
  prompts, the exact failure this list exists to prevent. The carve-out is narrow: only
  `system-path`. A `.env`, a `*.pem`, or a `.git/**` write **inside** the workspace stays protected.
- **The dedicated Git tools are the documented exception to `.git/**`.** `git_status` and `git_diff`
  expose a safe projection (status, diff), never arbitrary `.git` file content, so they do not trip
  the rule.

A container or daemon socket is root-equivalent: it can mount the host and escape any sandbox. That
is why it is denied even to `yolo` under the recommended managed policy.

## Grants (approvals)

An approval is a **grant**, and a grant binds to the action's digest — the canonical, complete
parameters. Approving "write `config.json`" does not authorize writing *different bytes* to
`config.json` later: the content digest is part of the identity.

| Scope | Meaning |
|---|---|
| `once` | consumed on first use (`already-used` afterwards) |
| `session` | valid for the session, subject to expiry |
| `rule` | a narrow validated rule, the one scope that is not digest-bound — and it may **never** satisfy an `exactGrantOnly` verdict |

A grant is rejected — visibly, in the trace — when it is `expired`, `revoked`, `already-used`, does
not match (`no-match`), or is a `rule` grant reaching for a protected path
(`scope-not-allowed-here`). A grant can never authorize a **denied** action; grants are only
consulted when the verdict is `ask`.

## Answering an approval

The CLI prompts on the terminal, showing the exact normalized action — never the tool name alone,
never a paraphrase:

```text
  permission required  (risk: MEDIUM)
  tool:   write_file
  action: write /repo/hello.txt
  why:    ask: every side effect prompts with its exact normalized parameters
  approve? [y]es once / [s]ession / [N]o:
```

`y` approves this exact action once. `s` approves it for the session. **Anything else — including an
empty line — denies.** Deny by default is not only the engine's rule; it is the prompt's rule too.

The action text originated with the model, so it is sanitized before it reaches your terminal. A tool
argument cannot emit escape sequences to repaint the screen and forge a dialog you then confirm.

### Silence is never consent

When there is no channel to ask on — `--json`, a closed stdin, EOF, or a cancelled turn — the
approval is **deferred**, not decided. The turn stops in state `awaiting-approval`, durably, and can
be answered later:

```sh
qwen-harness sessions
# thr_…  turns=1  (unnamed)  [awaiting approval: write /repo/hello.txt]
qwen-harness resume thr_…      # re-presents the action; answering finishes the SAME turn
```

An approval **continues the suspended turn**; it is not a new message. Passing a prompt to `resume`
while an approval is pending is a usage error rather than a guess about what you meant.

Nothing auto-approves. There is no `--yes` flag, and there will not be one: a switch that
manufactures human consent makes every approval in the audit log a lie.

### The TUI dialog

The TUI has an `ApprovalDialog` offering `[1] allow once`, `[2] allow this session`, `[3] deny`, with
Esc denying. The TUI binary is still a demo and never receives an approval to show, so you will not
meet it yet. See [the TUI guide](tui.md).

## The managed ceiling

Managed policy can only ever **remove** authority. There is no managed `allow`: an administrator who
wants to permit something simply does not deny it. Adding a managed `allow` would create a way for a
ceiling to *raise* a floor, and every bypass in this class of system starts there.

The ceiling is intersected **last** — after the profile, after rules, after grants, after hooks — so
"managed hard deny dominates every allow" is a structural property of the evaluator, not a rule
somebody has to remember to check. A managed `ask` outranks even `yolo`'s no-prompt promise.

See the [operator guide](operations.md#managed-policy) for what to deploy, and for the important
limitation that the CLI does not yet load managed policy into the running engine.
