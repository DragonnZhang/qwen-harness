# Checkpoint 09 — Packaging and release hardening

Status: **PARTIAL — PK-01, PK-02, PK-04 pass; the checkpoint gate is BLOCKED** (see §7)
Date: 2026-07-13
Host: the recorded target from checkpoint 00 (Ubuntu 26.10, x86_64, kernel 7.0.0-22-generic)
Base commit: `7689deb`

Scope of this checkpoint entry: capability-matrix rows **PK-01**, **PK-02**, **PK-04**, and the
checkpoint gate `pnpm check` from a clean clone. PK-03 (managed policy precedence) and the
remaining product-completeness rows are not covered here.

Every claim below is followed by the command that produced it. Nothing is asserted that was not run.

---

## 1. PK-01 — clean Linux host bootstrap

> _Clean Linux host bootstrap installs pinned Node active LTS/pnpm and required sandbox/terminal
> dependencies or reports exact unavailable prerequisites._

`scripts/bootstrap.sh`. Modes: `--check` (detect, change nothing), `--dry-run` (print the exact
commands, run none), default (install). Exit codes: `0` ready, `1` usage, `2` unmet prerequisites,
`3` unsupported platform.

The design point worth recording: **the sandbox is detected functionally, not nominally.** `bwrap`
being on `PATH` proves nothing — this host has `kernel.apparmor_restrict_unprivileged_userns=1`
(the Ubuntu 24.04+ default), under which an unconfined process *without* `CAP_SYS_ADMIN` is refused
a user namespace even though the binary is installed. So the script creates a real namespace and
reports the kernel's actual answer.

### 1.1 The recorded host passes

```
$ bash scripts/bootstrap.sh --check ; echo "EXIT=$?"

platform
  ✓ linux x86_64                 ubuntu 26.10 · kernel 7.0.0-22-generic
  ✓ package manager              apt
  · privilege                    root — system packages installable directly

system prerequisites
  ✓ cc / c++ / make / python3 / git / curl / bwrap / infocmp    (all present)
  ✓ terminfo(xterm-256color)     present

sandbox (bubblewrap + user namespaces)
  · user.max_user_namespaces     7530
  · unprivileged_userns_clone    1
  · apparmor_restrict_userns     1
  ✓ bwrap --unshare-all          created a real namespace and executed inside it

runtime (pinned: node 24.16.0, pnpm 11.9.0)
  ✓ node                         v24.16.0 (pinned)
  ✓ pnpm                         11.9.0 (pinned)

result (--check: nothing was changed)
  ✓ host is ready.  node v24.16.0 · pnpm 11.9.0 · bubblewrap sandbox functional
EXIT=0
```

### 1.2 A host missing the toolchain and the sandbox — exit 2, exact names, exact remedies

Run with a constructed `PATH` containing neither a C toolchain nor `bwrap`:

```
$ env -i HOME=$HOME TERM=$TERM PATH=/tmp/qh-shim/bin bash scripts/bootstrap.sh --check ; echo "EXIT=$?"

  ✗ 7 unmet prerequisite(s). This host cannot run qwen-harness yet.

      cc: absent — better-sqlite3 and node-pty have NO prebuilt binary for this platform and compile from source
        fix: apt-get install -y build-essential
      c++: absent — node-pty is C++ and is compiled by node-gyp on this host
        fix: apt-get install -y build-essential
      make: absent — node-gyp drives make to build the native addons
        fix: apt-get install -y build-essential
      python3: absent — node-gyp requires python3 to configure the native builds
        fix: apt-get install -y python3
      git: absent — the harness shells out to git for worktrees, diffs and session provenance
        fix: apt-get install -y git
      bwrap: absent — bubblewrap IS the sandbox backend (ADR 0003); no safe profile can run without it
        fix: apt-get install -y bubblewrap
      infocmp: absent — the Ink TUI needs a terminfo database; without it TERM cannot be resolved
        fix: apt-get install -y ncurses-bin
EXIT=2
```

### 1.3 A `bwrap` that exists but the kernel refuses — exit 2, with the correct sysctl

With a `bwrap` on `PATH` that fails the way a kernel-refused one does:

```
  ✗ unprivileged user namespaces bwrap could not create one: bwrap: setting up uid map: Permission denied
        fix: sysctl -w kernel.apparmor_restrict_unprivileged_userns=0  — or install an AppArmor
             profile for bwrap (Ubuntu 24.04+ restricts unconfined unprivileged userns)
EXIT=2
```

The remedy is selected from the sysctls that are *actually* set on the host, not guessed: with
`max_user_namespaces=7530` and `unprivileged_userns_clone=1` and `apparmor_restrict=1`, the AppArmor
restriction is the only remaining explanation, and that is what it names.

### 1.4 The install path, really executed

Not a dry run. With `node` and `pnpm` removed from `PATH`, into a temp prefix:

```
$ env -i HOME=$HOME TERM=$TERM PATH=/tmp/qh-shim3/bin \
    bash scripts/bootstrap.sh --prefix /tmp/qh-node-prefix

  install
    fetching https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz
    verifying sha256 against the release SHASUMS256.txt
node-v24.16.0-linux-x64.tar.xz: OK
    installed node v24.16.0 into /tmp/qh-node-prefix
Preparing pnpm@11.9.0 for immediate activation...

  result
  ✓ host is ready.  node v24.16.0 · pnpm 11.9.0 · bubblewrap sandbox functional

real 0m34.889s
```

The tarball is verified against the release's own `SHASUMS256.txt` **before** extraction; a mismatch
refuses to install. Nothing outside the prefix was written.

**Idempotence** — re-running with `node` now present installs nothing and exits 0:

```
runtime (pinned: node 24.16.0, pnpm 11.9.0)
  ✓ node                         v24.16.0 (pinned)
  ✓ pnpm                         11.9.0 (pinned)
result
  ✓ host is ready.
EXIT=0
```

### 1.5 The apt package names are real

The privileged step was not executed against this host's system directories. Instead its exact
command was run in apt's simulate mode, which proves every package name resolves on Ubuntu 26.10:

```
$ apt-get install -s -y --no-install-recommends build-essential python3 git curl bubblewrap ncurses-bin
bubblewrap is already the newest version (0.11.1-1ubuntu0.1).
ncurses-bin is already the newest version (6.6+20251231-1).
0 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.
EXIT=0
```

**Honest limitation:** the apt *install* branch was verified by simulation and by the fact that every
package it names is already present and resolvable. It was not executed against a host that was
genuinely missing them, because no container runtime (`docker`, `podman`, `systemd-nspawn`,
`debootstrap`) is available on the recorded host, and installing one — or removing `build-essential`
to create the condition — would modify system directories. The *detection* path for every one of
those cases was executed for real (§1.2, §1.3), and the Node/pnpm install path was executed for real
(§1.4).

Automated coverage: `packaging/test/bootstrap.test.ts` (10 tests).

---

## 2. PK-02 — versioned CLI package

> _Build produces a versioned CLI package with lockfile, integrity, install/uninstall, config
> migration, upgrade/rollback, and shell completion._

### 2.1 Build

```
$ pnpm release:package

qwen-harness release package
  version        0.1.0
  commit         5bf9ba800bde0f23cb6ee1160937fbbb98d7ca9e
  source date    2026-07-13T10:08:37.000Z  (SOURCE_DATE_EPOCH=1783937317)

  · tsc --build
  · esbuild lib/cli.js            (external: better-sqlite3)
  · esbuild lib/migrate-config.js (config migration, from @qwen-harness/config)
  · vendor node_modules/better-sqlite3@12.11.1
  · vendor node_modules/bindings@1.5.0
  · vendor node_modules/file-uri-to-path@1.0.0
  · completions bash/zsh/fish     (6 commands from `help`: doctor, run, sessions, resume, fork, export)

  ✓ dist/release/qwen-harness-0.1.0.tgz
    40 files · 1.25 MiB
    sha256 db0a06e38823b90accc8b023932c247354bc7521fc044e335eaf3e33f742cafc
```

The CLI's only runtime native dependency is `better-sqlite3` (`node-pty` belongs to the TUI). It is
vendored pre-compiled, with its two require-time dependencies, so **install needs no compiler, no
registry and no network**. Everything else is bundled to JavaScript.

**Lockfile and integrity.** The package carries:

| File                     | What it is                                                          |
| ------------------------ | ------------------------------------------------------------------- |
| `qwen-harness.lock.json` | the shipped closure, **derived from the real `pnpm-lock.yaml`**, with the integrity hash pnpm resolved for each package |
| `SHA256SUMS`             | a digest of every one of the 40 files in the package                |
| `MANIFEST.json`          | the same digests plus provenance: commit, `SOURCE_DATE_EPOCH`, platform, node ABI, toolchain |
| `<tgz>.sha256`           | a detached digest of the tarball itself                             |

**Shell completion is generated from the binary's own `help` output**, not hand-maintained — so a
completion for a command that does not exist is impossible, and a new command appears in bash, zsh
and fish automatically. `packaging/test/completions.test.ts` pins the parser (including that it does
not invent a command out of `resume`'s wrapped continuation line).

### 2.2 install → run → upgrade → rollback → uninstall, executed

`packaging/test/lifecycle.test.ts` builds the real tarball and drives the real installer against a
temp prefix. Not mocked: real sha256 verification, real symlinks, real `node` executing the bundled
CLI.

```
$ pnpm test:packaging

 ✓ packaging/test/lifecycle.test.ts (17 tests)
 ✓ packaging/test/bootstrap.test.ts (10 tests)
 ✓ packaging/test/support-bundle.test.ts (12 tests)
 ✓ packaging/test/sbom.test.ts (12 tests)
 ✓ packaging/test/completions.test.ts (7 tests)

 Test Files  5 passed (5)
      Tests  57 passed (57)
   Duration  97.33s
```

What those 17 lifecycle tests actually prove:

| Property                                    | How it is proven                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| install verifies integrity                  | `SHA256SUMS verified: 39 file(s) match`, plus "no unlisted files"           |
| **the installed binary runs**               | `$PREFIX/bin/qwen-harness help` and `doctor` execute — exercising the vendored native addon |
| completions land and are valid              | bash/zsh/fish installed; `bash -n` parses the bash one; every command in `help` appears in all three |
| tamper detection                            | flipping one byte in `lib/cli.js` makes `verify` exit **3**                  |
| a corrupt package installs **nothing**      | repacked tarball with a hijacked `cli.js` → exit **3**, no `bin/` symlink created |
| re-install is idempotent                    | prefix inventory is byte-identical before and after                          |
| upgrade keeps the old version               | both versions on disk; `status` reports active + previous                    |
| rollback restores and still runs            | `rolled back: 0.1.0-next -> 0.1.0`; the rolled-back binary executes          |
| rollback with no target fails cleanly       | exit **4**, "no previous version"                                            |
| **uninstall leaves nothing behind**         | full recursive inventory of the prefix is `[]` afterwards                    |
| uninstall respects a shared prefix          | a neighbour's `bin/someone-elses-tool` survives, and so does `bin/`          |

### 2.3 Config migration uses the product's own machinery

The package ships `qwen-harness-migrate-config`, an esbuild bundle of a thin CLI over
`@qwen-harness/config`'s existing `migrateConfig` + `ConfigDocSchema`. **There is no second migration
engine.** The installer runs it on install, upgrade and rollback.

Proven end-to-end in the lifecycle suite: a real v0 (unversioned) document with `endpoint` / `keyEnv`
/ `profile` is migrated to v1 (`baseUrl` / `apiKeyEnv` / `permissionProfile`), a `config.json.bak-v0`
is written, and the installer reports `schema v0 -> v1`.

And the case that matters on a **rollback**: a config at schema version 99 (written by a newer build)
is **refused, not downgraded** — the install still succeeds, the operator is told, and the file is
left byte-identical. Silently dropping keys an old build cannot interpret could drop the `deny` entry
an administrator added, bringing the harness up *more* permissive than intended. See
`docs/release/MIGRATION.md`.

---

## 3. PK-04 — release artifacts

> _Release artifacts, changelog, migration notes, support bundle, SBOM/dependency audit, and
> reproducible verification are generated without secrets._

```
$ pnpm release
```

### 3.1 Reproducible verification — demonstrated, not asserted

`scripts/release.ts` builds the package **twice** and compares the digests. Every timestamp comes
from `SOURCE_DATE_EPOCH` (defaulting to the HEAD commit's own time); the tar is sorted, uid/gid-zeroed
and gzipped with `-n`.

```
── reproducibility ───────────────────────────────────────────────────────────

  ✓ two independent builds of this commit produced byte-identical tarballs
    sha256 db0a06e38823b90accc8b023932c247354bc7521fc044e335eaf3e33f742cafc
```

### 3.2 SBOM — generated from the real lockfile

```
SBOM  ·  CycloneDX 1.6, generated from pnpm-lock.yaml
  349 components (8 runtime-reachable, 341 build/test only)
  349/349 carry a registry integrity hash
  ✓ dist/release/sbom.cdx.json
```

`packaging/test/sbom.test.ts` checks it against facts that are independently true: the frozen
versions from ADR 0002 (`typescript@5.9.3`, `vitest@4.1.10`, `zod@4.4.3`, `better-sqlite3@12.11.1`,
`prettier@3.9.5`), that >95% of components carry a real integrity hash, that runtime and dev scopes
are correctly separated (`better-sqlite3` and `zod` ship; `vitest` and `prettier` do not), and that
the component count equals the number of `packages:` keys in the raw YAML text — so a parser that
silently dropped a section would be caught.

### 3.3 Dependency audit

```
dependency audit  ·  pnpm audit
  critical 0 · high 0 · moderate 0 · low 0 · info 0
```

The audit fails the release on any high or critical advisory, and **fails closed on a network error**
— "we could not check" is never recorded as "there is nothing to find".

**It found a real vulnerability on its first run**, in `yaml@2.8.1` — a dependency added in this very
checkpoint to parse the lockfile (GHSA: stack overflow via deeply nested collections, `<2.8.3`).
Bumped to `yaml@2.8.3`; the audit is now clean at every severity. The gate caught its own author.

### 3.4 Support bundle — scrubbed, and proven so with the canary

`scripts/support-bundle.ts` collects host, environment, sandbox, config, `doctor` and state-dir
diagnostics.

Three properties, in order of importance:

1. **Environment VALUES are never collected.** `environment.txt` contains variable *names* only, plus
   a presence boolean for `DASHSCOPE_API_KEY`. There is no allowlist of "safe" variables to get wrong.
2. **Every collected byte is scrubbed at a single choke point** — so a future collector cannot forget
   to. The scrubber also redacts the *literal values* of secret-named environment variables, which is
   the only way to catch an opaque token (a UUID-shaped bearer token matches no credential *shape*).
3. **The assembled bundle is re-scanned, and the write is aborted if anything survives.**
   `SupportBundleLeakError`. A scrubber with a bug fails loudly instead of shipping the secret it
   missed.

`packaging/test/support-bundle.test.ts` (12 tests) plants the **testkit canaries** —
`CANARY_API_KEY`, `CANARY_GITHUB_TOKEN`, `CANARY_AWS_KEY`, `CANARY_PRIVATE_KEY`, byte-for-byte as
realistic as live credentials — into a user config, a project config, a log file and the environment,
generates the bundle, **extracts the written tarball**, and greps the real bytes:

```
✓ no canary reaches the bundle, and no environment VALUE is collected at all
✓ the written tarball contains no canary either
✓ removes every canary shape
✓ redacts the same shape more than once in one document   (the shared-/g-regex lastIndex bug)
✓ scrubbing is idempotent
✓ redacts a secret-shaped value that no pattern would catch, using the env literal
✓ redacts the base64 encoding of an environment secret
```

The tests assert the bundle is non-empty too — otherwise "no secret found" would be trivially true.

A real bundle was generated on this host:

```
$ pnpm support-bundle
  · host.txt / environment.txt / sandbox.txt / config.txt / doctor.txt / state.txt
  ✓ dist/release/support-bundle-2026-07-13T10-20-46-573Z.tar.gz
    scrubbed, re-scanned, and safe to attach to an issue.
```

### 3.5 Changelog and migration notes

`docs/release/CHANGELOG.md` and `docs/release/MIGRATION.md`. These are **not generated** —
`scripts/release.ts` verifies that the version being built has a changelog section and refuses to
build one that does not. A generated changelog is a git log with extra steps.

### 3.6 Secret scan

```
$ pnpm exec tsx scripts/secret-scan.ts
✓ PASS: no credential material in the working tree.
```

---

## 4. FINDING — `pnpm build` never built the whole product

**This is the finding the clean-clone gate exists to produce, and it was real.**

The root `build` script was `tsc --build`. Two packages need an *additional* esbuild bundling step
declared in their own `build` script:

- `packages/tool-worker` → `dist/worker.bundle.mjs` (the file bubblewrap actually executes)
- `apps/tui` → `dist/tui.bundle.mjs`

`tsc --build` never runs a package's `build` script, so neither bundle was ever produced by
`pnpm check`. On a developer machine it survived from an earlier manual build and everything passed.
From a **clean clone** the tool worker did not exist:

```
HarnessError: tool worker produced no response (exit 1):
  bwrap: Can't find source path /tmp/cc-baseline/repo/packages/tool-worker/dist/worker.bundle.mjs:
  No such file or directory
```

**13 integration tests failed** across `packages/tool-worker`, `apps/cli` and `apps/daemon` — the
entire sandboxed-tool surface. The product could not have run at all on a fresh install.

Fix (root `package.json`, in scope):

```diff
- "build": "tsc --build",
+ "build": "tsc --build && pnpm -r --if-present run build",
```

This runs every package's own declared build in topological order, so a package that adds a bundling
step in future is covered automatically rather than silently skipped. Verified: the 13 failures
became 0.

---

## 5. Clean-clone gate

The checkpoint gate is **`pnpm check` passes from a clean clone on the recorded host**.

Procedure: `git clone` into a temp dir, `pnpm install --frozen-lockfile`, `pnpm check`.

| Run | Tree                                        | Result                                                  | `check` wall clock |
| --- | ------------------------------------------- | ------------------------------------------------------- | ------------------ |
| 1   | `7689deb` as committed                      | **FAIL** — 13 integration tests (§4, missing worker bundle) | 700 s          |
| 2   | `7689deb` + the §4 build fix                | **FAIL** — `test:performance` finds no test files (§6)  | 1059 s             |
| 3   | + this checkpoint's work, first attempt     | **FAIL** — `lint` (§5.1)                                | 200 s              |
| 4   | + the §5.1 fix — **final**                  | **FAIL** — `test:performance` only (§6)                 | 959 s              |

`pnpm install --frozen-lockfile`: 10–55 s depending on how warm the pnpm store is (10 s here; the
store had already built the native addons). On a genuinely cold store it compiles `better-sqlite3`
and `node-pty` from source, which is why `build-essential` is a real clean-host prerequisite —
exactly as ADR 0002 and PK-01 record.

Run 4, every stage in order:

| Stage              | Result                              |
| ------------------ | ----------------------------------- |
| `format:check`     | PASS                                |
| `lint`             | PASS                                |
| `typecheck`        | PASS                                |
| `architecture`     | PASS (7 boundaries, 211 files)      |
| `build`            | PASS                                |
| `test` (unit)      | PASS — 1080                         |
| `test:integration` | PASS — 185 (+1 skipped)             |
| `test:security`    | PASS — 129                          |
| `test:migrations`  | PASS — 9                            |
| `test:pty`         | PASS — 1                            |
| `test:e2e`         | PASS — 4                            |
| `test:performance` | **FAIL — no test files** (§6)       |
| `test:packaging`   | not reached by `check`; run directly in the same clone: **PASS — 57** |
| `secrets:scan`     | not reached by `check`; run directly in the same clone: **PASS**      |

Every stage of the gate passes except the empty `performance` project.

### 5.1 FINDING — `pnpm lint` failed on a tree that had never been built

Run 3 exposed a second clean-clone-only failure, this one in my own work.

`pnpm check` runs `lint` **before** `build`. `scripts/migrate-config.ts` imports
`@qwen-harness/config`, whose `types` field points at `dist/index.d.ts` — which does not exist in a
clone that has never been built. TypeScript could not resolve the import, every value from it became
the `error` type, and the type-aware security rules (`no-unsafe-assignment`, `no-unsafe-call`,
`no-unsafe-member-access`) fired on ~40 lines.

This did not reproduce in a working tree, because `dist/` was already there.

The workspace packages avoid this with **project references**: TypeScript redirects module resolution
from a referenced project's *output* `.d.ts` to its *source*, so it needs no build. `scripts/` had no
tsconfig at all — it was typed through typescript-eslint's `allowDefaultProject`, which also caps at
8 files and had just been pushed to 9 by this checkpoint's new scripts. Past that cap files silently
degrade to an untyped parse, which turns `no-unsafe-*` **off** exactly where it is load-bearing.

Fix: a real `scripts/tsconfig.json` (`noEmit`, never built, absent from the root reference graph)
that references `packages/config`, and `projectService: true` in `eslint.config.js` in place of the
`allowDefaultProject` escape hatch.

Verified the only way that counts — `pnpm lint` on a fresh clone with no `dist/` anywhere:

```
$ ls packages/config/dist
packages/config/dist ABSENT (never built)
$ pnpm lint
$ echo $?
0
```

---

## 6. Blocking finding — the `performance` gate has no tests

```
$ pnpm test:performance
No test files found, exiting with code 1
projects: performance
include: packages/*/test/performance/**/*.test.ts, apps/*/test/performance/**/*.test.ts
```

There are **zero performance test files anywhere in the repository** — not at `7689deb`, not in any
working tree. `pnpm check` composes `pnpm test:performance`, and `vitest` exits 1 when a project
matches no files. So `pnpm check` **fails at the performance step**, on a clean clone and on the
working tree alike.

This gate was **not weakened** to make the checkpoint pass. `vitest` exiting non-zero on an empty
project is correct behaviour — a gate that silently runs nothing is worse than a gate that is red —
and `--passWithNoTests` would have converted a real hole into a green tick.

What is missing, per `docs/quality/acceptance.md`:

- line 17: `pnpm test:performance` → "transcript, diff, repository, team, storage loads"
- lines 54–66 (TUI performance gate): p95 input echo < 100 ms, p95 active-frame work < 50 ms, peak
  RSS < 512 MiB — the thresholds checkpoint 00 already measured in a spike (0.49 ms p95, 481 MiB) but
  which were never turned into a committed test.

These belong to the TUI and domain-package owners, not to packaging. Checkpoint 09's gate cannot be
certified until they exist.

---

## 7. Gate

| Requirement                     | Result                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| PK-01 clean-host bootstrap      | **PASS** — detection paths and the Node install path executed; apt install branch simulated (§1.5) |
| PK-02 versioned CLI package     | **PASS** — 57 packaging tests; install→run→upgrade→rollback→uninstall executed for real            |
| PK-04 release artifacts         | **PASS** — reproducible tarball, SBOM from the lockfile, clean audit, canary-proven support bundle |
| `pnpm check` from a clean clone | **FAIL** — empty `performance` project (§6). Every other stage passes (§5).                        |

**Checkpoint 09 does not pass.** PK-01, PK-02 and PK-04 are complete and evidenced. The checkpoint
gate is blocked on one thing: a `performance` project that matches no test files, which is outside
packaging's scope to write.

Recording that plainly is the point. Making it green was one `--passWithNoTests` away, and that flag
would have converted a real hole in the product's evidence — the TUI latency and RSS thresholds in
`docs/quality/acceptance.md`, measured in a checkpoint-00 spike and never committed as a test — into
a tick that meant nothing. Three of the four failures found by this gate (§4, §5.1, and the `yaml`
advisory in §3.3) were real bugs that only a clean clone could surface; a gate that is allowed to
pass while running nothing would not have found them either.
