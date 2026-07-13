# Operator guide

For whoever deploys this on a machine other people use.

Read [Library surface and current gaps](library-surface.md) alongside this page. Several controls
described here are implemented and tested as libraries but **not yet loaded by the shipped CLI**, and
an operator who assumes otherwise will believe they have a boundary they do not have. Each is called
out explicitly.

## Managed policy

### What it is

Managed policy is an **immutable deny-first ceiling**. It can only ever *remove* authority. There is
no managed `allow` — an administrator who wants to permit something simply does not deny it. Adding a
managed `allow` would create a way for a ceiling to raise a floor, and every bypass in this class of
system starts there.

The ceiling is intersected **last** in the policy pipeline — after the profile, after repository and
user rules, after grants, after hooks. Nothing runs after it. That ordering is what makes "managed
hard deny dominates every allow or hook outcome" a structural property of the evaluator rather than a
rule somebody must remember to check. A managed `ask` outranks even `yolo`'s no-prompt promise.

### The file

`/etc/qwen-harness/managed.json`. Root-owned, mode `0644`. It is an ordinary config document; the
keys that matter to an administrator are the ceiling and the deny list:

```json
{
  "version": 1,
  "maxProfile": "auto-accept-edits",
  "maxIsolation": "workspace-write",
  "networkAllowed": false,
  "deny": ["**/secrets/**", "**/*.tfstate"]
}
```

How it behaves when a user setting conflicts with it:

| The user sets | Managed says | Effective | Why |
|---|---|---|---|
| `permissionProfile: "yolo"` | `maxProfile: "auto-accept-edits"` | **`auto-accept-edits`** | authority is clamped to the ceiling *after* ordinary resolution |
| `isolation: "disabled"` | `maxIsolation: "workspace-write"` | **`workspace-write`** | same clamp, strictest wins |
| `network: true` | `networkAllowed: false` | **`false`** | network is an AND; a ceiling can force it off, and nothing can turn a denied network back on |
| `deny: []` (trying to clear) | `deny: ["**/secrets/**"]` | **`["**/secrets/**"]`** | deny lists **union** across every scope; a higher scope can add a deny, never drop one |
| `maxProfile: "yolo"` in a project file | `maxProfile: "ask"` | **`ask`** | ceilings resolve tighten-only across *all* scopes; a lower scope may tighten further but never relax |

And `doctor` will tell the user *which* source did it — every effective value carries provenance, so
the answer to "why can't I use yolo here" is a file path, not a shrug.

The `managed` scope never contributes an ordinary product value. It cannot set your `model` or your
`baseUrl`. It is a ceiling, not a preference file.

### What an administrator should actually deny

The recommended managed policy hard-denies the things no approval, no profile, and no `yolo` should
ever reach:

- **credential stores and daemon sockets** — `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`,
  `~/.docker/config.json`, `~/.config/gh/hosts.yml`, GnuPG, keyrings, and the Docker/containerd/
  podman/CRI-O sockets. A container socket is root-equivalent: it can mount the host and escape any
  sandbox.
- **the cloud instance-metadata endpoint** — `169.254.169.254`, `100.100.100.100` (Alibaba Cloud),
  `metadata.google.internal`, and the whole `169.254.0.0/16` link-local block. It hands out instance
  credentials to anything that can make an HTTP request.

### ⚠ The gap you must know about

**The CLI does not load managed policy into the running policy engine.**

`doctor` reads `/etc/qwen-harness/managed.json`, resolves it, applies the ceiling, and reports the
result with provenance — that all works. But `qwen-harness run` constructs its policy engine with
`NO_MANAGED_RESTRICTIONS` and an empty rule list. Today, a managed file **constrains what `doctor`
reports, and does not constrain what a `run` does**.

Until that composition step lands, do not treat `managed.json` as an enforcement boundary on a shared
host. If you need a hard boundary right now, enforce it below the harness: a dedicated unprivileged
user, filesystem permissions, and a network egress policy.

## The daemon

The daemon is the **single writer** for the workspace it owns. It takes the lease *before* it opens
the event store, so a second daemon cannot start against the same state and two SQLite writers can
never interleave a thread's turns.

```sh
node apps/daemon/dist/bin.js --workspace /srv/repo --profile ask
# daemon listening on /srv/repo/.qwen-harness/daemon.sock (pid 4711)
```

| Flag | Default |
|---|---|
| `--workspace` | the current directory |
| `--socket` | `<workspace>/.qwen-harness/daemon.sock` |
| `--lease` | `<workspace>/.qwen-harness/daemon.lease` |
| `--state` | `<workspace>/.qwen-harness/sessions.sqlite` |
| `--profile` | `ask` |
| `--model` | `qwen3.7-max` |

It runs the **same** composition the CLI does — the real policy engine, the real sandboxed worker, the
real event store — and adds exactly two things: it streams durable events to attached clients, and it
turns an approval into a socket round trip. Any number of clients may attach and watch; none of them
writes. When a client answers an approval, the **same turn** resumes. When no client is attached to
answer, the turn suspends in `awaiting-approval` and the durable log keeps it. Nothing is
auto-approved — including when every client detaches mid-prompt, which settles as *deferred*.

A second daemon against a live lease exits `3` and says who holds it:

```text
daemon: thread is locked by a live daemon (pid 4711); attach to it instead of starting a second one
```

A stale lease (holder dead) is reclaimed automatically after a pid-liveness probe. A lease held by a
live process is never stolen.

Note that `qwen-harness run` does **not** take the lease — it opens the store directly. Do not run
the CLI and a daemon against one workspace at the same time.

## The audit trail

The durable audit trail is the **event log**: `<workspace>/.qwen-harness/sessions.sqlite`.

Every host side effect has an actor, a correlation id, a policy decision, a sandbox identity, and a
durable result state (threat-model invariant 5). Every policy decision carries a full trace — which
stage, which rule, which grant, which ceiling won, and why — so a decision can always be explained
after the fact.

Export a thread for archival or review:

```sh
qwen-harness export <thread-id> > audit-thread.jsonl
```

The log is **append-only**. There is no pruning, no vacuum, no rotation, and no age or size cap:
`.qwen-harness/sessions.sqlite` grows for the life of the workspace. **There is no retention policy
implemented.** If you need one, it is currently a matter of archiving and deleting the file, which
destroys the sessions in it. Plan for that on a long-lived shared host.

## Redaction

Redaction happens at the **storage boundary, before the transaction** — not on the way out. Anything
that reaches a persisted event has already been scrubbed.

What is redacted (`packages/storage/src/redaction.ts`), replaced with `[REDACTED]`:

| Pattern | Matches |
|---|---|
| the live key | the exact `DASHSCOPE_API_KEY` value, plus its base64, base64url, percent-encoded, and `base64("Bearer …")` forms |
| `sk-…` tokens | 16+ chars |
| GitHub tokens | `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + 20+ chars |
| AWS access key ids | `AKIA…` |
| authorization headers | `Bearer …`, `Basic …` |
| private keys | `-----BEGIN … PRIVATE KEY-----` blocks |
| URL userinfo | `scheme://user:pass@host` |
| API keys in query strings | `?api_key=`, `access_token=`, `token=` |
| sensitive **key names** | `authorization`, `api_key`, `apikey`, `access_token`, `refresh_token`, `client_secret`, `password`, `secret`, `token`, `cookie`, `set-cookie` — the value is replaced wholesale |

Verify the working tree is clean of credential material at any time:

```sh
pnpm secrets:scan
```

With `DASHSCOPE_API_KEY` exported, the scanner additionally hunts for the *live* key's literal,
base64, base64url, and URL-encoded forms — and it never prints what it finds. The location is the
whole report.

## Telemetry

**Telemetry is opt-in and defaults to `false`.**

```json
{ "telemetry": { "enabled": true } }
```

or `QWEN_HARNESS_TELEMETRY=1`.

What it would emit: structured trace records (`ts`, `level`, `category` such as `provider.request` /
`tool.execute` / `policy.decision`, `message`, `fields`, `correlationId`), with a redaction function
applied to both the message and the fields before anything is written, and a file sink that appends
JSONL.

**⚠ Nothing emits telemetry today.** The `telemetry` package is not imported by a single line of
source anywhere in the product — no tracer is constructed, no sink is given a path, no span is
recorded. Turning the flag on currently does nothing. It is honest to say the switch exists and the
plumbing behind it does not.

## Support bundle

**There is no support-bundle feature.** No command, no function, no archive format. If you need to
send diagnostics, the honest set is:

```sh
qwen-harness doctor > doctor.txt              # never contains a secret value
qwen-harness export <thread-id> > thread.jsonl # redacted at write time
```

Review both before sending them anywhere. `doctor` reports credential *presence* only, and never
reads the value.

## Upgrade and rollback

The harness is a workspace build; upgrading is `git pull && pnpm install && pnpm build`.

Two compatibility surfaces to keep in mind:

1. **Config schema.** A config file written by a newer build is refused by an older one with
   `config schema version N is newer than this build understands (max M); upgrade the harness rather
   than editing the version down`. **Rolling back the binary does not roll back a config file that
   has already been migrated.** Keep a copy of `managed.json` and user config before a major upgrade.
2. **Storage schema.** The event store versions itself with SQLite's `user_version` and applies
   ordered, append-only migrations forward (currently up to version 2). Note a real asymmetry: **there
   is no guard against a database from a *newer* build.** An older binary opening a newer database
   silently applies nothing and proceeds — where the config layer would refuse. Treat
   `.qwen-harness/sessions.sqlite` as forward-only, and back it up before downgrading.

Session **exports** are the portable, version-checked artifact (`formatVersion`), and are the right
thing to keep across an upgrade you are unsure about.

## Suspected credential exposure

Treat any credential that reached a file, a log, a chat, or a terminal transcript as **already
leaked**. Encryption at rest and "it was only in a private repo" are not mitigations; rotation is.

1. **Rotate the key at the provider immediately.** Do this first, before investigating. Investigation
   takes time; rotation takes a minute.
2. **Find out where it went.** Run `pnpm secrets:scan` with the *old* key still exported — that
   activates the live-key rules, which hunt for its literal, base64, base64url, and URL-encoded forms
   across the working tree. The scanner prints file and line only, never the value.
3. **Check committed history too** — `pnpm secrets:scan` covers the working tree only. Committed
   content is covered by `scripts/check-spec.sh`.
4. **Check the event stores.** They are redacted at write time, so a key should never be in one — but
   if the key was rotated *in*, an old store may contain the old key's redacted form only. Confirm.
5. **Re-export the key into your shell** using the `read -rsp` idiom so it does not land in shell
   history, and never put it in a config file: `apiKeyEnv` takes a variable *name*, and the schema
   rejects anything that looks like a value.

The structural defences that make this rare: exactly one package may read the credential (the build
fails if another names the variable), configuration stores only the variable's name, sandboxed tools
get an environment allowlist that excludes it, and every persisted event is redacted before it is
written. Rotation is still the answer when they fail.
