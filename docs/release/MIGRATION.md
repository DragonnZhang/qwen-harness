# Migration notes

What changes on disk when you install, upgrade or roll back, and what the harness will and will not
do to your files.

## The rule

**Your configuration is yours.** The installer migrates its *schema* forward so an older document
keeps working, and it never deletes, downgrades or rewrites the *meaning* of a setting to suit the
binary it is installing. When those two goals conflict — a rollback to a version that cannot
understand the config on disk — the harness stops and tells you, rather than guessing.

## What the installer touches

| Path                                              | On install | On upgrade | On rollback | On uninstall |
| ------------------------------------------------- | ---------- | ---------- | ----------- | ------------ |
| `$PREFIX/lib/qwen-harness/versions/<version>/`    | created    | created    | —           | **removed**  |
| `$PREFIX/lib/qwen-harness/current` (symlink)      | created    | repointed  | repointed   | **removed**  |
| `$PREFIX/bin/qwen-harness`                        | created    | —          | —           | **removed**  |
| `$PREFIX/share/**/completions`                    | created    | —          | —           | **removed**  |
| `$XDG_CONFIG_HOME/qwen-harness/config.json`       | migrated   | migrated   | checked     | **kept**     |
| `$XDG_CONFIG_HOME/qwen-harness/config.json.bak-*` | written    | written    | —           | **kept**     |
| `~/.qwen-harness/` (sessions, state)              | untouched  | untouched  | untouched   | **kept**     |

Uninstall removes exactly what the installer created and nothing else — including leaving a `bin/`
directory alone if anything else lives in it. Your config and your session history survive it,
because losing a month of sessions to a `--reinstall` is not a thing this tool will ever do to you.

## Config schema migration

Every config document carries a `version`. On install and upgrade the shipped
`qwen-harness-migrate-config` runs the product's **own** migration chain (`@qwen-harness/config`) —
not a second copy of it — and writes a backup at `config.json.bak-v<from>` before changing anything.

### v0 → v1

v0 is the unversioned pre-release shape. The migration:

| v0 field    | v1 field            | Note                                   |
| ----------- | ------------------- | -------------------------------------- |
| `endpoint`  | `baseUrl`           | renamed                                |
| `keyEnv`    | `apiKeyEnv`         | renamed                                |
| `profile`   | `permissionProfile` | renamed                                |
| `reasoning` | `reasoningEffort`   | renamed                                |
| `apiKey`    | — **dropped**       | see below                              |

**A raw `apiKey` value is dropped, not carried forward.** A secret in a config file is already a
leaked secret, and we cannot invent an environment-variable *name* from a *value*. If you had one,
set `apiKeyEnv` to the NAME of the variable holding your key (the default is `DASHSCOPE_API_KEY`)
and rotate the key that was in the file. The migration says so in its output.

## Rolling back past the config's floor

This is the case worth understanding before you need it.

An upgrade may migrate your config to a newer schema. If you then roll back, the older binary meets
a document from the future. It **refuses to touch it** and exits with a clear message:

```
config: ✗ …/config.json is at schema version 2, newer than this build understands (max 1).
        This build will not downgrade it: the keys it cannot interpret may be the ones
        holding this host to a tighter policy. Roll FORWARD, or restore the config
        backup taken by the newer install (…/config.json.bak-v*).
```

The rollback itself **succeeds** — the binary is swapped back — but `qwen-harness` will not start
against a config it cannot read. You have two honest options:

1. **Roll forward again** (`packaging/install.sh rollback` a second time returns you to the newer
   version), or
2. **Restore the backup** the newer install wrote: `cp config.json.bak-v1 config.json`.

Why not just downgrade the document? Because a config is also a *policy* document. Silently dropping
the keys an old build does not recognise could drop the `deny` entry an administrator added last
week, and the harness would come up **more** permissive than the operator intended, with no error.
Refusing is the only safe answer; a tool that quietly widens your permissions to make an install
succeed has picked the wrong thing to optimise.

## Upgrading

```bash
pnpm release                                    # build + verify the artifact
packaging/install.sh upgrade dist/release/qwen-harness-<version>.tgz --prefix ~/.local
```

The new version is unpacked **alongside** the running one and a single symlink is moved. The old
version stays on disk as the rollback target, so an interrupted upgrade cannot leave a half-written
binary on your `PATH`, and going back is a symlink move rather than a restore.

```bash
packaging/install.sh status   --prefix ~/.local   # what is active, what rollback would do
packaging/install.sh rollback --prefix ~/.local   # go back one version
packaging/install.sh verify   --prefix ~/.local   # re-check the active install against SHA256SUMS
```
