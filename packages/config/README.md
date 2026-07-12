# @qwen-harness/config

Layered configuration with **provenance**. Every effective value carries the one source that
produced it, so `doctor` can explain _why_ each winning value is what it is (PS-07, PK-03, OB-03).

A declared I/O owner (`scripts/graph.ts`): `load.ts` may read config files and the environment; the
rest of the package is pure and testable without a filesystem. Config depends only on `protocol`.

## Two merge strategies (this is the whole design)

Different kinds of setting must merge differently, and conflating them is a security bug.

### `override` — ordinary product values

Last-write-wins by scope precedence, highest wins (defaults.md, "Configuration precedence"):

```
cli / session override
  > approved per-key environment override
  > local project settings   (.qwen-harness/config.local.json)
  > shared project settings  (.qwen-harness/config.json)
  > user settings            ($XDG_CONFIG_HOME/qwen-harness/config.json)
  > built-in defaults
```

The single highest scope that sets a key owns it. `model`, `baseUrl`, `apiKeyEnv`,
`reasoningEffort`, `transport`, budgets, and tool-output limits all resolve this way. The `managed`
scope does **not** participate here — it can never out-vote an ordinary value, only cap authority.

### `deny-merge` — security deny lists

`deny` takes the **union across every scope**. A higher scope can _add_ a deny but can **never
remove** one a lower scope contributed. There is deliberately no "allow" that subtracts from the
union, so it only ever grows.

## Why security is deny-first

If deny lists used last-write-wins like ordinary values, then a higher-precedence source — a
project file committed to a repository you just cloned, or a per-key env override — could silently
_re-enable_ something the user or the administrator had denied. Repository content is untrusted
(SC-02); a cloned `.qwen-harness/config.json` must not be able to lift a deny the user set in their
own settings. Union-of-denies makes that impossible by construction: adding scopes can only ever
make the system more restrictive, never less. Doctor still attributes every deny entry to the scope
that contributed it, so a surprising denial is always explainable.

## The managed ceiling only tightens

Managed policy is an immutable upper bound (defaults.md: "cannot be relaxed by any lower source").
It is modelled as three tighten-only ceiling keys — `maxProfile`, `maxIsolation`, `networkAllowed`
— resolved as the **strictest value across all scopes, managed included**. The authority values they
bound (`permissionProfile`, `isolation`, `network`) are resolved by ordinary precedence and then
**clamped** to the ceiling as the final step. A lower source can make authority more restrictive;
it can never widen it past managed, because the clamp runs after everything else and nothing
downstream can loosen it.

When a clamp changes a value, provenance points at the ceiling source — so `doctor` says "profile
is `ask` because the managed policy caps it", not merely "profile is `ask`".

## API keys are stored by NAME, never by value

`apiKeyEnv` holds the _name_ of the environment variable that contains the model key (e.g.
`DASHSCOPE_API_KEY`), never the key itself. The schema rejects anything that looks like a raw key.
Config never reads a secret value; it only names the variable the provider will read (SC threat
model, PV-12).

## Schema versioning

Documents carry a `version` and are migrated forward before validation (`migrations.ts`). A v0
(unversioned pre-release) document migrates to v1 deterministically — renaming legacy keys and
dropping any legacy raw `apiKey`. A document from a **newer** build than this one is a typed
`UnknownConfigVersionError`, never a silent downgrade.

## Files

| Scope           | Path                                                     |
| --------------- | -------------------------------------------------------- |
| managed         | `/etc/qwen-harness/managed.json`                         |
| user            | `$XDG_CONFIG_HOME/qwen-harness/config.json` (`~/.config` default) |
| shared-project  | `<projectRoot>/.qwen-harness/config.json`                |
| local-project   | `<projectRoot>/.qwen-harness/config.local.json`          |
| env             | allowlisted `QWEN_HARNESS_*` variables only              |

A missing file contributes nothing. A present-but-broken file is a `ConfigFileError` that names the
path and the stage that failed (parse, migration, or schema).
