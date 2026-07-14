# Installing, upgrading, and packaging qwen-harness

This is the operator's guide to getting `qwen-harness` onto a Linux host and keeping it current. Every
command below is real and runnable; the packaging behavior it documents is exercised by
`packaging/test/` and by the fresh-install golden path (`evals/e2e/fresh-install.test.ts`).

> qwen-harness is **Linux-only** by design (it uses bubblewrap for the sandbox). See
> [sandbox.md](sandbox.md) for why.

## 1. Bootstrap a clean host (PK-01)

`scripts/bootstrap.sh` takes a bare Linux host to a working toolchain — the pinned Node LTS and pnpm,
plus the sandbox and terminal prerequisites — or it tells you exactly what is missing and stops.

```bash
# Detect only — change nothing, exit 0 iff the host is ready:
pnpm bootstrap -- --check

# Show the exact commands it WOULD run, run none of them:
pnpm bootstrap -- --dry-run

# Actually install prerequisites (may need sudo for system packages):
pnpm bootstrap -- --allow-sudo
```

Exit codes: `0` ready · `1` usage error · `2` a prerequisite is unmet · `3` unsupported platform. When
a prerequisite is missing it is named with its remedy — e.g. a kernel that refuses unprivileged user
namespaces prints the exact `sysctl`, and a missing C toolchain (required because `better-sqlite3` and
`node-pty` compile from source on this platform) prints the package to install. The bootstrap **fails
closed**: it never claims success while a control the sandbox depends on is absent.

Prerequisites it checks: bubblewrap (`bwrap`) present and functional, unprivileged user namespaces
enabled, a C/C++ toolchain (`cc`/`g++`/`make`), Node active LTS, and pnpm. See
[getting-started.md](getting-started.md) for the recorded target host.

## 2. Build a versioned CLI package (PK-02)

```bash
pnpm release:package        # builds dist, then a versioned tarball under ./release/
```

The tarball carries a lockfile, an integrity manifest (`SHA256SUMS`), a `MANIFEST.json`, the vendored
`better_sqlite3.node`, and **generated** shell completions. Completions are generated from the CLI's
own `help` output, never hand-written — so a subcommand appears in completion the moment it exists and
can never drift (`packaging/test/completions.test.ts` asserts the two agree). Two builds of the same
commit produce a **byte-identical** tarball (reproducible).

## 3. Install, verify, upgrade, roll back, uninstall (PK-02)

`packaging/install.sh` manages the lifecycle into a prefix you choose (default `$HOME/.local`). It never
touches system directories.

```bash
PREFIX=$HOME/.local

packaging/install.sh install    <tarball>   # install; runs config migration
packaging/install.sh status                 # what is installed, which version
packaging/install.sh verify                 # re-check integrity against SHA256SUMS
packaging/install.sh upgrade    <tarball>   # install a newer version, keeping the old for rollback
packaging/install.sh rollback               # revert to the previously-installed version
packaging/install.sh uninstall              # remove everything this installer put down
```

Guarantees, each covered by `packaging/test/lifecycle.test.ts`:

- **Integrity is enforced.** A tarball whose contents do not match its `SHA256SUMS` is refused (exit 3);
  a tampered file is caught by `verify`.
- **Config migration runs on install/upgrade** through the same `@qwen-harness/config` migration chain
  the runtime uses — there is no second migrator to drift.
- **Rollback is real** — `upgrade` keeps the prior version so `rollback` restores it; rolling back with
  nothing to roll back to fails cleanly.
- **Uninstall leaves no residue.** After `uninstall` the prefix inventory is empty; your user config
  (documented owned state) is left intact.

After installing, `PATH` includes `$PREFIX/bin`, so `qwen-harness doctor` and `qwen-harness run` work.
See [cli.md](cli.md) for the command surface and [getting-started.md](getting-started.md) for a first task.

## 4. Release artifacts (PK-04)

```bash
pnpm release            # changelog + migration notes + reproducible verification bundle
pnpm release:sbom       # CycloneDX SBOM + dependency audit, from the real pnpm-lock.yaml
pnpm support-bundle     # a scrubbed diagnostics bundle for an operator to send you
```

- The **SBOM** is generated from the real lockfile (not hand-written) at CycloneDX 1.6, with the frozen
  ADR-0002 versions and integrity hashes; the **dependency audit** fails on any advisory.
- The **support bundle is scrubbed of secrets** — proven with the testkit canary in
  `packaging/test/support-bundle.test.ts`: `assemble()` throws rather than return a leaky bundle, and no
  credential value is ever collected. See [operations.md](operations.md) for what a bundle contains and
  the credential-exposure runbook.
- Changelog and migration notes live in [docs/release/](../release/README.md).

## 5. What to do when something is wrong

- Bootstrap reports an unmet prerequisite → follow the exact remedy it prints; re-run `--check`.
- `verify` fails → the install is corrupt or tampered; reinstall from a fresh tarball.
- `qwen-harness doctor` reports a degradation → see [troubleshooting.md](troubleshooting.md).
- A suspected credential exposure → [operations.md](operations.md#credential-exposure).
