# qwen-harness user guide

This guide documents the harness **as it is built today**. Every command, flag, config key, file
path, and error string here was checked against the source. Where a capability exists as a library
but no application exposes it yet, this guide says so instead of implying you can use it — see
[Library surface and current gaps](library-surface.md).

## Honest scope

- **Linux only.** `doctor` fails on any other platform (`✗ not Linux — this product targets Linux
  only`). The recorded target is Ubuntu 26.10 on x86_64; see
  [`docs/execution/checkpoints/00-preflight-and-contract-probes.md`](../execution/checkpoints/00-preflight-and-contract-probes.md).
- **One model backend.** DashScope (`qwen3.7-max`, OpenAI-compatible endpoint). There is no second
  provider and no offline model.
- **Two working surfaces: the headless CLI** (`qwen-harness`) **and the daemon**
  (`qwen-harness-daemon`), which share one composition — the same policy engine, sandboxed worker,
  and event store. The TUI binary renders a scripted demo transcript and is not yet connected to the
  runtime; the remote worker has no launchable entry point.
- **Approvals are real, and nothing is ever auto-approved.** The CLI prompts on the terminal; the
  daemon turns an approval into a socket round trip. With no channel to ask on (`--json`, closed
  stdin), the turn suspends durably in `awaiting-approval` rather than being allowed or dropped. See
  [Permissions and approvals](permissions.md).

## Read in this order

1. [Getting started](getting-started.md) — prerequisites, install, `doctor`, your first task.
2. [The CLI](cli.md) — every command, every flag, every exit code, and the JSON output shape.
3. [Permissions and approvals](permissions.md) — the four profiles, the deny-by-default engine,
   protected paths, and grants.
4. [The sandbox](sandbox.md) — what bubblewrap actually blocks, and what it does not.
5. [Sessions: resume, fork, export](sessions.md) — the durable event log and the side-effect ledger.
6. [The TUI](tui.md) — keybindings and the honest state of the terminal UI.
7. [Configuration reference](configuration.md) — every key, its type, default, scope, and effect.
8. [Troubleshooting](troubleshooting.md) — real failures with the real messages.
9. [Operator guide](operations.md) — managed policy, redaction, telemetry, upgrades, credential
   exposure.
10. [Library surface and current gaps](library-surface.md) — what is implemented but not yet
    reachable from a command.

## The invariants this product will not trade away

These are not slogans; each one is enforced in code and is the reason several things below are
deliberately narrow.

- **Deny by default.** A side effect is not permitted because nothing forbade it. It is permitted
  because a profile, a rule, or a human approval affirmatively allowed it — and the managed ceiling
  is intersected *last*, so nothing downstream can loosen it.
- **Repository content cannot grant authority.** A file in the repo you are working on is
  attacker-controlled in the threat model. Project-scoped policy rules may `deny` or `ask`; they may
  never `allow`.
- **The credential never leaves the provider boundary.** Configuration stores the *name* of the
  environment variable (`apiKeyEnv`), never a key value. Exactly one package reads the variable, and
  the build fails if any other package so much as names it. Sandboxed tools get an allowlisted
  environment that does not contain it.
- **Untrusted text is sanitized before it is displayed.** Model, tool, MCP, web, and repository text
  cannot emit terminal control sequences; they can never style trusted UI chrome.
- **The side-effect ledger never guesses.** An action interrupted mid-flight is recorded as
  `indeterminate`, and the system refuses to replay it. It does not assume failure (which would
  double-write) and it does not assume success (which would silently skip work).
