# Releasing qwen-harness

Everything here is a command you run. Nothing in this process publishes to a registry: `pnpm release`
builds and *verifies* artifacts locally, and publishing is a deliberate, separate act that this
repository does not automate.

## 0. Prerequisites

```bash
scripts/bootstrap.sh --check
```

Exits 0 only if the host can actually run the product: pinned Node (>= 22; 24.16.0 is the frozen
LTS) and pnpm, a C/C++ toolchain (`better-sqlite3` and `node-pty` have **no prebuilt binary** for
this platform and compile from source), and a **functional** bubblewrap sandbox — it creates a real
user namespace rather than checking that `bwrap` exists, because on Ubuntu 24.04+ those are different
questions.

Anything missing is named exactly, with the command that fixes it. `--dry-run` prints what it would
do; the default installs it.

## 1. Cut the release

```bash
pnpm check          # every gate, from a clean tree
pnpm release        # build, verify, and prove reproducible
```

`pnpm release` will **refuse to build from a dirty working tree** — a release is a claim about a
commit, and an artifact whose manifest says `commit: abc123` while containing uncommitted bytes is a
lie that nobody can reproduce. (`--allow-dirty` produces a clearly-marked development artifact with
`dirty: true` in its manifest.)

It also refuses to build a version with no `## <version>` section in `CHANGELOG.md`.

### What it produces, in `dist/release/`

| Artifact                           | What it is                                                     |
| ---------------------------------- | -------------------------------------------------------------- |
| `qwen-harness-<version>.tgz`       | the installable CLI package                                    |
| `qwen-harness-<version>.tgz.sha256`| detached digest of the tarball                                  |
| `sbom.cdx.json`                    | CycloneDX 1.6 SBOM, generated from `pnpm-lock.yaml`            |
| `audit.json`                       | `pnpm audit`; the release fails on any high/critical advisory  |
| `RELEASE.txt`                      | the artifact index with every digest                            |

### Reproducibility is proven, not claimed

The package is built **twice** and the two tarballs must be byte-identical. Every timestamp comes
from `SOURCE_DATE_EPOCH` (defaulting to the HEAD commit's own time); the tar is sorted, uid/gid-zeroed
and gzipped with `-n`. If someone embeds a wall clock in the build, the release fails here rather than
being discovered by a user who cannot reproduce our artifact and has to decide whether to trust it.

Anyone can check our work:

```bash
git checkout <commit>
pnpm install --frozen-lockfile
pnpm release:package
sha256sum dist/release/qwen-harness-<version>.tgz   # must equal RELEASE.txt
```

## 2. Install

```bash
packaging/install.sh install dist/release/qwen-harness-0.1.0.tgz --prefix ~/.local
```

No network, no registry, no compiler: the one native dependency (`better-sqlite3`) is vendored
pre-compiled. The installer verifies the detached digest, then every file against the package's own
`SHA256SUMS`, and refuses to link anything into place if either fails. It also refuses a package
containing a file that `SHA256SUMS` does not list.

The layout is a versioned store with a symlinked `current`, which is what makes upgrade and rollback
safe:

```
~/.local/lib/qwen-harness/versions/0.1.0/
~/.local/lib/qwen-harness/current  -> versions/0.1.0
~/.local/bin/qwen-harness          -> ../lib/qwen-harness/current/bin/qwen-harness
```

Completions for bash, zsh and fish are installed under `~/.local/share`. They are **generated from
the binary's own `help` output** at build time, so they cannot drift from the commands that exist.

## 3. Operate

```bash
packaging/install.sh status    --prefix ~/.local   # active version, rollback target
packaging/install.sh verify    --prefix ~/.local   # re-check the install against SHA256SUMS
packaging/install.sh upgrade   <tarball> --prefix ~/.local
packaging/install.sh rollback  --prefix ~/.local
packaging/install.sh uninstall --prefix ~/.local
```

An upgrade unpacks the new version **alongside** the running one and moves a single symlink, so an
interrupted upgrade cannot leave a half-written binary on your `PATH`, and rollback is a symlink move
rather than a restore-from-backup.

Uninstall removes exactly what the installer created and **nothing else** — it leaves your config,
your session history, and any directory it did not create (a shared `~/.local/bin` keeps its other
tools). See `MIGRATION.md` for what happens to your config on each transition, including the one case
that needs a human decision: rolling back past a config the older binary cannot understand.

## 4. When a user reports a bug

```bash
pnpm support-bundle
```

Produces `dist/release/support-bundle-<timestamp>.tar.gz`: host, environment, sandbox probe, config,
`doctor` output and state-directory inventory.

**It is safe to attach to an issue**, and that is a tested property, not an intention:

- Environment **values are never collected** — names only, plus a presence boolean for the credential.
- Every collected byte is scrubbed at a single choke point, including the *literal values* of
  secret-named environment variables (the only way to catch an opaque token that matches no
  credential *shape*).
- The assembled bundle is **re-scanned**, and the write is aborted if anything credential-shaped
  survived. A scrubber with a bug fails loudly instead of shipping the secret it missed.

`packaging/test/support-bundle.test.ts` proves this by planting the testkit canaries — credential
material as realistic as the real thing — in a config, a log and the environment, then extracting the
written tarball and grepping the bytes.

## 5. Gates

`pnpm check` composes every gate, including `pnpm test:packaging` (57 tests), which builds the real
tarball and drives install → run → upgrade → rollback → uninstall against a temp prefix. If the thing
we ship does not work, that suite fails; it is not a simulation of the install, it is the install.
