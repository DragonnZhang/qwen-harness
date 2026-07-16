# The CLI

The headless CLI is the harness's real user surface today. It is deliberately small: six commands,
three flags, four exit codes. Everything it does is a read or a write over a durable event log, or a
single agent turn against the model.

Binary: `qwen-harness` (`apps/cli/dist/bin.js`). Source of truth: `apps/cli/src/main.ts`.

## Commands

```text
qwen-harness <command>

  doctor                 report environment, config provenance, sandbox, credential presence
  run <prompt>           run one turn in the current workspace and print the result
  sessions               list the sessions in this workspace
  resume <id> [prompt]   continue a session; with no prompt, resume a pending
                         approval and finish the SAME turn
  fork <id>              create a new session forked from an existing one
  export <id>            print a session as portable JSONL

  flags: --profile <plan|ask|auto-accept-edits|yolo>  --model <name>  --json
```

`qwen-harness`, `qwen-harness help`, and `qwen-harness --help` all print exactly that.

### `doctor`

Reports platform, sandbox capability (with every probe), resolved configuration with its
provenance, and whether the credential env var is **present**. It never reads or prints the key's
value. Exits `0` when nothing blocks a safe, non-degraded run, `3` otherwise. See
[Getting started](getting-started.md#4-run-doctor) for annotated output and every failure message.

`doctor` is the **only** command that reads your configuration files. See
[Configuration](configuration.md#what-actually-consumes-configuration-today).

### `run <prompt>`

Runs one agent turn in the current working directory, then exits. The prompt is every positional
argument, joined by spaces.

```sh
qwen-harness run "fix the failing test in src/parser.test.ts" --profile auto-accept-edits
```

- Creates a new session (`thr_…`) and appends a `thread-created` event.
- The workspace root is your current directory. State goes to `./.qwen-harness/sessions.sqlite`.
- Tool calls run through `schema → semantic → policy → sandboxed worker`. There is no second path.
- An empty prompt is a usage error: `run: a prompt is required (e.g. `qwen-harness run "fix the failing test"`)`.

On a clean end, stdout is the assistant's final text (or `(no text output)`), and stderr carries the
status line:

```text
[completed: natural-completion]  session thr_m4x8c2a0001
```

On a non-clean end, the underlying provider failure the engine recorded is surfaced too, so you see
*why*, not just "failed":

```text
[failed: provider-error]  session thr_m4x8c2a0001
detail: <the model-request-failed message>
```

### `resume <id> [prompt]`

Two different things, depending on whether the session is waiting for an approval.

**With a prompt — another turn.** The model conversation is rebuilt **from the local event log**:
assistant messages, tool calls, and tool outputs replayed straight out of storage and paired by their
exact call IDs. No remote conversation handle is trusted or required.

```sh
qwen-harness resume thr_m4x8c2a0001 "now update the docs to match"
```

**With no prompt — answer a pending approval.** If the session is `awaiting-approval`, `resume`
re-presents the pending action and finishes the **same turn**. An approval is not a new message; it is
the continuation of a turn that was suspended mid-flight.

```sh
qwen-harness resume thr_m4x8c2a0001
```

The two are not interchangeable, and the CLI says so rather than guessing:

```text
resume: this session is waiting for an approval (write /repo/src/foo.ts). Answer it first with `resume thr_…` — an approval continues the same turn and is not a new message.
resume: a prompt is required (this session has no pending approval)
resume: a session id is required
resume: no such session <id>
```

All of these are exit `1`.

`--profile` applies to the resumed turn; the profile is not inherited from the original session.

### `sessions`

Lists every session in this workspace, with turn count, name, fork lineage, and whether it is
blocked on an approval:

```text
thr_m4x8c2a0001  turns=3  (unnamed)  [awaiting approval: write /repo/hello.txt]
thr_m4x8c2a0007  turns=3  (unnamed) (forked from thr_m4x8c2a0001)
```

With no sessions: `no sessions in this workspace`.

### `fork <id>`

Creates a **new** session whose history is a copy of an existing one, with recorded lineage. The
original is never modified — two lines of work can diverge from a shared past.

```text
forked thr_m4x8c2a0001 -> thr_m4x8c2a0007 (14 events copied)
```

Fork copies the `turn-started` and `item-appended` events (re-minting turn and item ids so the new
thread has its own identity). It does **not** copy the side-effect ledger: the fork starts with no
record of prior host side effects. See [Sessions](sessions.md#fork).

### `export <id>`

Prints the session as portable JSONL on stdout — a header line then one JSON event per line. The
format is stable and independent of the internal tables.

```sh
qwen-harness export thr_m4x8c2a0001 > session.jsonl
```

Unknown id: `export: no such session: <id>` (exit `1`).

### `task` — durable tasks and legacy todos

Two separate systems that are never conflated (WK-02). The DURABLE dependency graph is the preferred
API:

```sh
qwen-harness task create "build the parser" --active "Building the parser"   # -> {id: 1, ...}
qwen-harness task create "write docs" --blocked-by 1                          # depends on task 1
qwen-harness task list --json          # every task with status/owner/blockedBy
qwen-harness task get 1 --json
qwen-harness task claim 1              # atomic — a second claimant is rejected, not silently shared
qwen-harness task update 1 --status completed   # unblocks its dependents
```

Legacy turn-local `TodoWrite` semantics remain usable and stay SEPARATE from the durable graph — a
bulk `task todo` write never mutates a durable task:

```sh
# A turn-local checklist, given as a JSON array; it produces a projection and touches no durable task.
qwen-harness task todo '[{"content":"read code","activeForm":"Reading code"}]'
```

### `skills` — two-level skill loading

Lists the skills discovered from `SKILL.md` frontmatter. Sources are searched in this precedence
(highest first, IN-03): **managed** (`/etc/qwen-harness/skills`) → **project** (`.qwen-harness/skills`)
→ **additional directories** → **user** (`~/.config/qwen-harness/skills`) → **plugin** → **MCP** →
**bundled**. When two sources declare the same name the higher one wins and the lower is shadowed
(never silently both); a **managed** name is RESERVED — nothing can shadow it. The catalog reads
frontmatter ONLY; a skill's body is loaded only when it is invoked (IN-01). An invalid frontmatter is
reported, never silently dropped (IN-04).

```sh
qwen-harness skills --json                        # {skills:[{name,source}], errors:[...]}
qwen-harness run --skill review-pr "check my diff" # loads the skill body and prepends it to the prompt
```

### `memory` — long-term memory

```sh
qwen-harness memory                                       # list stored memories with provenance
qwen-harness memory add --name pnpm-usage --description "Build/test with pnpm" "Run pnpm build then test."
qwen-harness memory add --name build-lesson --description "CI note" --scope auto "use pnpm, never npm"
qwen-harness memory consolidate                           # dedup + conflict-resolve, delete superseded files
```

Retrieval is automatic and budgeted (5 files / 50 KiB per turn, MM-02); `consolidate` keeps the newer
of any same-named pair and removes the loser (MM-04). A memory containing a secret is refused (MM-03).

**Scopes (MM-05).** `--scope` selects where a memory lives; a plain CLI run reads and writes three of
the five frozen scopes:

| Scope | Where it lives | Shared with |
| --- | --- | --- |
| `project` | `<repo>/.qwen-harness/memory` | everyone who clones the repo |
| `user` | `$XDG_DATA_HOME/qwen-harness/memory` | you, across every repo |
| `auto` | `$XDG_STATE_HOME/qwen-harness/auto/<canonical-repo>` | **every `git worktree` of one repo** |
| `team` | `<repo>/.qwen-harness/team-memory` | a configured team (not a plain CLI run) |
| `session` | *(nothing on disk)* | the current run only — survives compaction, never persisted |

The load-bearing distinction is `auto`: it is keyed by the **canonical repository** (the shared git
common dir), so a lesson recorded in one worktree is visible from its siblings. Prove it end to end —
write from the main worktree, read from a linked one:

```sh
git worktree add ../wt-feature                            # a linked worktree of this repo
qwen-harness memory add --name build-lesson --description "CI note" --scope auto "use pnpm, never npm"
( cd ../wt-feature && qwen-harness memory --json )        # the sibling worktree lists build-lesson
```

An unrelated repository resolves to a different canonical key and does **not** see it — the sharing is
scoped to the repo, not the machine.

### `trace` — the local telemetry trace

Prints the redacted JSONL trace (requires `telemetry.enabled`, OB-02). See
[Observability](operations.md#telemetry).

```sh
qwen-harness trace            # human-readable: timestamp, level, category, message, fields
qwen-harness trace --json     # one JSON record per line
```

### `mcp` — configured MCP servers

```sh
qwen-harness mcp                     # list configured servers and their tools
qwen-harness mcp trust <server>      # trust a server (recorded in your home dir, never by a repo)
```

**Precedence and trust (MC-05).** When the same server name is configured in more than one place, the
strongest source wins, in this order (weakest → strongest):

```
connector  <  plugin  <  user  <  approved-project  <  local
```

On top of that, a **managed** administrator policy is an absolute ceiling: a managed *deny* keeps a
server off no matter who configured or trusted it, and a managed *exclusive* allow-list keeps every
unlisted server off. And a server that comes from the **repository** (`approved-project` or `local`)
is **never trusted automatically** — it is listed but stays inactive, with a reason, until you run
`mcp trust <server>` (recorded in your home directory, so a cloned repo can never trust its own
server). A `connector`/`plugin`/`user` server, by contrast, is trusted without a prompt. Every server
carries provenance so `doctor` can explain why it is — or is not — running.

### `background` and `cron`

`background` manages detached tool jobs (list/output/stop); `cron` manages five-field scheduled jobs
(add/list/remove) whose authority is the intersection of their creation-time ceiling and current
managed policy (PS-08). Both are durable and survive a supervisor restart.

## Flags

Flags may be written `--key value` or `--key=value`. `--json` is a boolean and never swallows the
next token, so `run --json "the prompt"` keeps its prompt.

| Flag | Values | Default | Effect |
|---|---|---|---|
| `--profile` | `plan`, `ask`, `auto-accept-edits`, `yolo` — plus the aliases `default` and `manual` (→ `ask`), `acceptEdits` (→ `auto-accept-edits`), `bypassPermissions` (→ `yolo`) | `ask` | The permission profile for this turn. An unknown value is a usage error: `run: unknown profile "<value>"`. |
| `--model` | any model name | `qwen3.7-max` | The model sent to DashScope. |
| `--prompt-mode` | `minimal`, `default`, `proactive`, `coordinator` (see below) | `default` | The prompt mode for this turn. An unknown value is a usage error: `run: unknown prompt mode "<value>"`. |
| `--worktree` | a slug (`[a-z0-9][a-z0-9_-]*`) | off | Run this session in a fresh git worktree of the repo (GT-02): every tool resolves against the worktree, not the main checkout. Distinct from a teammate's cwd override. The worktree persists after the run; remove it with `git worktree remove`. A non-git directory is a usage error. |
| `--json` | boolean | off | Print one machine-readable JSON object to stdout instead of prose. |

`--profile` and `--model` apply to `run` and `resume` only. `sessions`, `fork`, and `export` are
pure reads over the log and never call the model.

> There is no `--cwd`, no `--config`, no `--verbose`, and no `--yes`. There is deliberately no flag
> that auto-approves: an approval is a human decision, and a switch that manufactures one would make
> every approval in the audit log a lie. Use `--profile` to choose your authority up front.

### Prompt modes (`--prompt-mode`)

A prompt mode selects which behavioral guidance and which tools the model sees. The full table —
each mode's activation, prompt delta, tool availability, policy inheritance, cache behavior, and
observable capabilities — is frozen in [`docs/product/defaults.md`](../product/defaults.md); this is
the operator summary.

| Mode | Tools the model sees | Guidance it adds |
|---|---|---|
| `minimal` | all held | Identity, protocol, tool schemas, current policy, and safety only — no proactive behavior. |
| `default` | all held | The standard workflow guidance. Adding no `--prompt-mode` flag is exactly this. |
| `proactive` | all held | May create tasks, use background work, and continue obvious next steps within the current authority. |
| `coordinator` | **held minus every mutating tool** | The lead plans, delegates, reviews, merges, and verifies; it does not mutate the workspace directly. `write_file`, `edit_file`, and `run_shell` are simply not offered. |

A mode is **prompt text and tool visibility — never authority.** No mode raises or lowers your
permission profile or isolation: a `coordinator` run under `--profile yolo` is still a `yolo` run,
only with fewer tools. The `coordinator` restriction is enforced by the execution pipeline itself, not
just described in the prompt — a coordinator that attempts a write is refused with a failed
tool-result, and no file is written.

```bash
# Plan-and-delegate: the lead cannot edit files directly.
qwen-harness run --profile auto-accept-edits --prompt-mode coordinator "refactor the parser"
```

The fifth mode in `defaults.md`, `agent-defined`, is only meaningful for a subagent that carries a
validated definition (its own granted-tools list and prompt sections). A direct `run` has no such
definition, so `--prompt-mode agent-defined` is rejected rather than silently degraded to "no tools".

## Approvals

Under `ask` (the default) and `auto-accept-edits`, a side effect that policy does not auto-allow
prompts on the terminal, showing the **exact normalized action** policy judged — not the tool name,
not a paraphrase:

```text
  permission required  (risk: MEDIUM)
  tool:   write_file
  action: write /repo/hello.txt
  why:    ask: every side effect prompts with its exact normalized parameters
  approve? [y]es once / [s]ession / [N]o:
```

- `y` / `yes` / `once` → approve this exact action, once.
- `s` / `session` → approve for the rest of the session.
- anything else, including an empty line → **deny**. Deny by default; the capital `N` is the default
  for a reason.

The action text came from the model, so it is sanitized before it reaches your terminal: a tool
argument cannot repaint the screen to forge a dialog you then confirm.

**Silence is never consent.** If there is no input channel — `--json`, a closed stdin, EOF, or a
cancelled turn — the approval is *deferred*: the turn stops in state `awaiting-approval` and is
recorded durably. Nothing auto-approves, and nothing is silently dropped.

```sh
qwen-harness run --profile ask --json "create hello.txt containing hi" </dev/null
# {"threadId":"thr_…","turnId":"trn_…","state":"awaiting-approval","reason":null,"finalText":"",
#  "detail":null,"pendingApproval":{"callId":"call_…","toolName":"write_file",
#  "action":"write /repo/hello.txt","risk":"medium"}}
# exit 3

qwen-harness sessions
# thr_…  turns=1  (unnamed)  [awaiting approval: write /repo/hello.txt]

qwen-harness resume thr_…      # re-presents the action; answering finishes the SAME turn
```

An unanswered approval is **not a failure**. It is a turn that is still alive and resumable, which is
why it exits `3` (blocked) rather than `2`.

## JSON output (`--json`)

`run` and `resume` with `--json` print exactly one object:

```json
{
  "threadId": "thr_m4x8c2a0001",
  "turnId": "trn_m4x8c2a0005",
  "state": "completed",
  "reason": "natural-completion",
  "finalText": "I added a test for parseConfig and it passes.",
  "detail": null,
  "pendingApproval": null
}
```

| Field | Meaning |
|---|---|
| `threadId` | The session id. Pass it to `resume`, `fork`, or `export`. |
| `turnId` | The turn this result belongs to. |
| `state` | `completed`, `cancelled`, `failed`, `blocked`, `budget-exhausted`, or `awaiting-approval`. |
| `reason` | The termination reason, e.g. `natural-completion`, `user-cancelled`, `time-limit`, `model-call-limit`, `tool-call-limit`, `no-progress`, `repeated-identical-calls`, `internal-error`. `null` if none was recorded. |
| `finalText` | The assistant's final text. |
| `detail` | The last recorded `model-request-failed` message when the turn did not complete; `null` otherwise. |
| `pendingApproval` | When `state` is `awaiting-approval`: `{callId, toolName, action, risk}`. `null` otherwise. |

Note that `--json` deliberately suppresses the interactive prompt — a machine caller has nobody to
ask. A batch script must therefore either pick a profile that does not prompt for what it needs, or
handle `awaiting-approval` by routing it to a human:

```sh
for task in "$@"; do
  result=$(qwen-harness run --profile auto-accept-edits --json "$task" </dev/null)
  state=$(printf '%s' "$result" | jq -r .state)
  case "$state" in
    completed) ;;
    awaiting-approval)
      printf 'needs a human: %s\n' "$(printf '%s' "$result" | jq -r '.pendingApproval.action')" >&2
      exit 3 ;;
    *) printf '%s\n' "$result" >&2; exit 1 ;;
  esac
done
```

`sessions`, `fork`, and `export` ignore `--json`; `export` is already machine-readable.

## Exit codes

| Code | Meaning |
|---|---:|
| `0` | success (`run`/`resume`: the turn reached `completed`) |
| `1` | usage error — unknown command, missing prompt, missing/unknown session id, an approval answered as if it were a new message |
| `2` | runtime failure — the turn ended in any other non-`completed` state, or an unexpected error |
| `3` | blocked / credential — `doctor` found a blocking problem; the run failed for a missing or rejected credential; **or the turn is `awaiting-approval`** |

Exit `3` is distinct on purpose: a missing key and an unanswered approval are both *actionable*
states, not failures. Exit `2` means the turn is over and went wrong; exit `3` means the turn is
waiting for you.

```text
run: No DashScope API key found (env:DASHSCOPE_API_KEY). Set DASHSCOPE_API_KEY in the environment, then retry. The harness stores the variable name, never its value.
```

## What the model can actually do

Eight built-in tools, defined once each and offered to the model only in the profiles that permit
them:

| Tool | Action | Available in |
|---|---|---|
| `read_file` | read a UTF-8 workspace file, paged (`offsetLine`, `limitLines` ≤ 50,000, default 2,000) | every profile |
| `list_dir` | list a workspace directory, optionally glob-filtered | every profile |
| `search` | regex search across workspace files (`maxMatches` ≤ 10,000, default 200) | every profile |
| `git_status` | working-tree status as a safe porcelain projection | every profile |
| `git_diff` | unified diff of unstaged (or staged) changes | every profile |
| `write_file` | create or overwrite a workspace file with exact content | `ask`, `auto-accept-edits`, `yolo` |
| `edit_file` | replace an exact unique snippet; rejects the edit if the file changed under it (`expectedDigest`) | `ask`, `auto-accept-edits`, `yolo` |
| `run_shell` | run a program in the sandbox — an explicit `command` + `argv`, **not** a shell string | `ask`, `auto-accept-edits`, `yolo` |

Notes that matter:

- **All paths are workspace-relative.** An absolute path is rejected at the schema layer, before
  anything else runs; the worker re-checks after canonicalization.
- **`run_shell` is not a shell.** There is no `sh -c`, so there is no shell metacharacter
  injection surface. It runs one program with an explicit argv vector inside the sandbox.
- **Git writes have no tool.** `git_status` and `git_diff` are read-only projections. The policy
  engine models a `git-write` action, but no built-in tool produces one — the agent cannot commit,
  push, or rewrite history. It can only change files, which you then commit yourself.
- **There is no `web_fetch` and no MCP tool in the CLI.** The network broker and the MCP client exist
  as libraries but no application wires them in. See [Library surface](library-surface.md).
