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

## Flags

Flags may be written `--key value` or `--key=value`. `--json` is a boolean and never swallows the
next token, so `run --json "the prompt"` keeps its prompt.

| Flag | Values | Default | Effect |
|---|---|---|---|
| `--profile` | `plan`, `ask`, `auto-accept-edits`, `yolo` — plus the aliases `default` and `manual` (→ `ask`), `acceptEdits` (→ `auto-accept-edits`), `bypassPermissions` (→ `yolo`) | `ask` | The permission profile for this turn. An unknown value is a usage error: `run: unknown profile "<value>"`. |
| `--model` | any model name | `qwen3.7-max` | The model sent to DashScope. |
| `--json` | boolean | off | Print one machine-readable JSON object to stdout instead of prose. |

`--profile` and `--model` apply to `run` and `resume` only. `sessions`, `fork`, and `export` are
pure reads over the log and never call the model.

> There is no `--cwd`, no `--config`, no `--verbose`, and no `--yes`. There is deliberately no flag
> that auto-approves: an approval is a human decision, and a switch that manufactures one would make
> every approval in the audit log a lie. Use `--profile` to choose your authority up front.

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
