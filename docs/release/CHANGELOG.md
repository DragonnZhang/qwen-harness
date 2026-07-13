# Changelog

All notable changes to `qwen-harness`. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`scripts/release.ts` refuses to cut a release whose version has no section here. That is deliberate:
an artifact nobody can read a description of is an artifact nobody should install.

## 0.1.0

First packaged release. The harness runs a real coding loop against DashScope `qwen3.7-max` with a
bubblewrap sandbox, a durable session store, and a deny-first policy ceiling.

### Added

- **Clean-host bootstrap** (`scripts/bootstrap.sh`, PK-01). Takes a clean Linux host to a working
  install: pinned Node 24.16.0 and pnpm 11.9.0, plus the C/C++ toolchain, bubblewrap and terminfo
  that the product genuinely requires. Detects the sandbox **functionally** — it creates a real user
  namespace rather than checking that `bwrap` is on `PATH` — and fails closed with the exact missing
  prerequisite and the exact command that fixes it. `--check` and `--dry-run` change nothing.
- **Versioned CLI package** (`scripts/package-cli.ts`, `packaging/install.sh`, PK-02). A
  self-contained `qwen-harness-<version>.tgz` with a lockfile, a per-file `SHA256SUMS`, a provenance
  `MANIFEST.json` and a detached tarball digest. `install.sh` gives install, upgrade, rollback,
  uninstall and verify against a prefix, with bash/zsh/fish completions generated from the CLI's own
  `help` output.
- **Config migration on install** (`qwen-harness-migrate-config`). Runs the product's own
  `@qwen-harness/config` migration chain on install, upgrade and rollback. A config written by a
  newer build is **refused, not downgraded** — see `docs/release/MIGRATION.md`.
- **Release artifacts** (`scripts/release.ts`, `scripts/sbom.ts`, PK-04). CycloneDX 1.6 SBOM
  generated from the real `pnpm-lock.yaml` (with the integrity hashes pnpm resolved), a `pnpm audit`
  report that fails the release on a high or critical advisory, and a **reproducibility proof**: the
  package is built twice and the two tarballs must be byte-identical.
- **Support bundle** (`scripts/support-bundle.ts`, PK-04). Scrubbed diagnostics an operator can
  attach to an issue. Environment **values are never collected** — only names, plus a presence
  boolean for the credential — and every collected byte is scrubbed and then **re-scanned**; the
  bundle is not written if anything credential-shaped survives.

### Fixed

- **`pnpm build` did not build the whole product.** The root `build` script ran only `tsc --build`,
  which never invoked the two packages that additionally bundle with esbuild
  (`packages/tool-worker` -> `dist/worker.bundle.mjs`, `apps/tui` -> `dist/tui.bundle.mjs`). On a
  developer machine the bundle survived from an earlier manual build, so this was invisible; from a
  **clean clone** the tool worker did not exist and 13 integration tests failed with
  `bwrap: Can't find source path .../worker.bundle.mjs`. The root script now runs every package's
  declared build (`tsc --build && pnpm -r --if-present run build`). Found by the checkpoint-09
  clean-clone gate — which is exactly what that gate is for.

### Known limitations

- The package is **platform-specific by construction**: it vendors a `better-sqlite3` addon compiled
  for `linux-x64` and the Node ABI recorded in `MANIFEST.json`. Installing it on another platform is
  refused rather than attempted.
- Nothing is published to a registry. `pnpm release` builds and verifies locally; publishing is a
  separate, deliberate act.
