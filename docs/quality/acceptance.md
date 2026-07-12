# Quality and acceptance gates

## Release command contract

The implementation must provide these stable root commands:

```text
pnpm format:check       verify formatting without rewriting
pnpm lint               static correctness and security rules
pnpm typecheck          all TypeScript project references
pnpm test               deterministic unit/property/contract tests
pnpm test:integration   real local process/storage/Git/MCP integration
pnpm test:security      adversarial policy/sandbox/secret/TUI suite
pnpm test:pty           PTY frames, input, signals, restoration, SSH smoke
pnpm test:e2e           deterministic fake-model golden paths
pnpm test:live          credentialed DashScope golden path
pnpm test:performance   transcript, diff, repository, team, storage loads
pnpm test:migrations    supported database/config migration matrix
pnpm architecture       dependency and forbidden-I/O checks
pnpm build              clean production build and package
pnpm check              every deterministic release gate above
```

Commands must use non-zero exit codes for failure, print actionable diagnostics, and avoid hidden interactive prompts. `test:live` fails closed with a concise missing-key message when `DASHSCOPE_API_KEY` is absent.

## Per-capability proof

For each matrix row, evidence records:

```text
Capability ID:
Implementation entry points:
User-visible CLI/TUI path:
Tests and exact commands:
Normal-path result:
Failure-path result:
Security-path result:
Recovery-path result:
Trace/session fixture:
Known limitations:
Checkpoint commit:
```

The matrix evidence codes freeze applicability before implementation. The implementing agent cannot add a new not-applicable classification during final audit. A change requires an ADR proving the original user-visible behavior is still fully satisfied and updating tests before implementation of that row.

## Determinism and flake policy

- Unit, property, contract, integration, security, PTY frame, migration, and fake-model E2E tests must be deterministic.
- Use injected clocks, IDs, random seeds, provider streams, failure schedules, and bounded process timeouts.
- Retry is not a test strategy. A quarantine requires a documented external defect, owner, expiry, and cannot cover a required release gate.
- Preserve the seed and smallest counterexample for property failures.
- Golden snapshots must be semantic, normalized, reviewable, and small enough to diagnose.

## TUI performance and correctness gate

On the recorded target host, the spike and final TUI must handle:

- 10,000 completed transcript rows;
- a 50,000-character incremental response;
- incomplete streaming Markdown and code fences;
- a 2,000-line unified diff;
- multiline CJK, emoji, combining characters, and bracketed paste;
- 80x24 and 160x50 resize sequences;
- continuous tool output and concurrent background notifications.

Record p50/p95 input-to-frame latency, frame duration, CPU, and peak RSS. The default target is p95 input echo below 100 ms, p95 active-frame work below 50 ms, and peak RSS below 512 MiB for this fixture. If the host makes a threshold unreasonable, an ADR must justify a stricter or equivalent user-perceived bound before feature implementation, not after failure.

Terminal mode, cursor, echo, alternate-screen state, and child process groups must be restored after normal exit, Ctrl-C, SIGTERM, suspend/resume, provider failure, uncaught error, and forced child cancellation. SSH smoke is a reproducible loopback/containerized sshd fixture when the target does not expose a safe test daemon; it must not mutate production SSH configuration.

## Reliability gate

Inject failure at every durable boundary:

- before and after model request persistence;
- during stream normalization;
- before tool intent, after process start, during output, and after completion;
- before/after approval and hook outcome;
- during SQLite transaction, migration, snapshot, backup, and projection update;
- during task claim, inbox write, worktree create/remove, Cron fire, MCP refresh, and memory consolidation;
- during TUI render and SSH/PTY disconnect.

Recovery must yield a valid state, attributable error, cleaned resources, and no duplicate known-complete side effect.

## Security gate

Run the attack suite in all four modes. At minimum cover:

- malicious README/instruction asking for environment, SSH keys, cloud credentials, or upload;
- `../`, absolute path, Unicode separator, case, hardlink, and symlink escape;
- shell indirection, command substitution, aliases, interpreters, package scripts, and Git hooks;
- MCP description/schema/output injection and OAuth redirect/state abuse;
- hook input mutation attempting policy escalation;
- child/teammate/background/Cron authority escalation;
- ANSI/OSC 52, terminal title, hyperlink, cursor, and fake-dialog output;
- the same control/link attacks originating from model, repository, hook, MCP, web, and Markdown content, not only tool stdout;
- fork bombs, output floods, disk/memory/process exhaustion, and infinite model loops;
- secret values in logs, errors, traces, snapshots, exports, support bundles, and Git history.

`yolo` intentionally allows host access, but UI trust separation, secret redaction, audit, budget, cancellation, and terminal sanitization still apply.

## Live-model gate

The live suite uses a disposable fixture repository and a strict budget. It must prove:

1. streamed text and reasoning summary;
2. single and multiple tool calls with fragmented arguments;
3. file edit, shell test, Git diff, and final verification;
4. usage normalization;
5. retryable and non-retryable error classification where safely inducible;
6. interruption and resume from a durable boundary;
7. no credential in any persisted artifact;
8. no repeated completed side effect.

Additional budgeted live smokes must prove that the real model can drive one subagent delegation, one team handoff, one MCP tool call, and one long-context/compaction continuation through the normalized protocol. Deterministic tests remain exhaustive; these live smokes detect provider behavior gaps without turning every failure injection into paid traffic.

The suite logs request IDs and redacted evidence, never request authorization headers or complete sensitive prompts.

## Clean-host gate

From a fresh clone on the recorded Linux platform:

1. bootstrap documented prerequisites;
2. install with the frozen lockfile;
3. run `pnpm check`;
4. build and install the CLI;
5. run doctor and a deterministic task;
6. run the credentialed live task when key is present;
7. resume/export the session;
8. uninstall and confirm only documented state remains.

## Completion audit

Search for and manually resolve at least:

```text
TODO FIXME HACK XXX not implemented unsupported placeholder mock-only skip quarantine
```

Some legitimate occurrences may exist in tests or documentation, but each must be reviewed. Also inspect empty handlers, unconditional success, ignored promises, broad `any`, unsafe casts, disabled lint, skipped tests, catches without action, and capability rows without evidence.
