# ADR 0002: Frozen toolchain and dependency versions

Status: accepted
Date: 2026-07-12
Checkpoint: 00

## Context

`docs/execution/implementation-protocol.md` checkpoint 00 requires freezing exact Node, pnpm,
TypeScript, Ink/React, SQLite, test, schema, and build versions before product breadth begins.
Versions were resolved against the registry on the target host on 2026-07-12.

## Decision

| Concern         | Package        | Version            | Rationale                                                         |
| --------------- | -------------- | ------------------ | ----------------------------------------------------------------- |
| Runtime         | Node.js        | 24.16.0            | Installed active LTS on the target; satisfies Ink `engines: >=22` |
| Package manager | pnpm           | 11.9.0             | Workspace + `onlyBuiltDependencies` support                       |
| Language        | TypeScript     | **5.9.3**          | See below                                                         |
| TUI             | ink            | 7.1.0              | Proven under PTY at checkpoint 00                                 |
| TUI             | react          | 19.2.7             | Ink 7 peer requirement (`>=19.2.0`)                               |
| Storage         | better-sqlite3 | 12.11.1            | Synchronous SQLite, WAL verified on host                          |
| Schemas         | zod            | 4.4.3              | Runtime validation at untrusted boundaries                        |
| Tests           | vitest         | 4.1.10             | Unit/property/integration runner                                  |
| PTY             | node-pty       | 1.1.0              | Compiled from source on target (no prebuild)                      |
| Lint            | eslint         | 10.7.0             | With typescript-eslint                                            |
| Format          | prettier       | 3.9.5              |                                                                   |
| Build           | esbuild        | pinned in lockfile | Bundling for shipped CLI/TUI                                      |

### TypeScript 5.9.3, not 7.0.2

The registry `latest` tag for TypeScript is **7.0.2** (the native port), with `7.1.0-dev` on
`next`. We deliberately pin **5.9.3**, the mature 5.x line.

Reasons:

1. The architecture gate in `task.md` mandates enforcement via **TypeScript project references**
   (`tsc --build`) across ~25 packages. The 5.x line has years of production use behind that
   exact code path.
2. `pnpm lint` requires typescript-eslint with full type-aware rules over the same project graph.
   Type-aware linting is the mechanism for several _security_ rules we depend on (no unsafe
   `any`, no floating promises, restricted `process.env` access to the provider boundary).
   Compatibility of that toolchain with the native port is not something we should be
   discovering while also building the product.
3. This choice is invisible to the product's external behavior and is reversible: nothing in the
   source depends on a 5.x-only feature.

This is a build-toolchain decision, not a product-scope decision. It weakens no capability-matrix
row.

## Consequences

- `packageManager` is pinned in the root `package.json` and the lockfile is committed.
- `node-pty` and `better-sqlite3` require compilation on a clean host, so the bootstrap must
  install a C/C++ toolchain (`build-essential`) and declare them in `onlyBuiltDependencies`.
  `PK-01` (clean-host bootstrap) must report this prerequisite explicitly.
- Revisiting TypeScript 7 is a mechanical, isolated change once typescript-eslint support for it
  is established; it would require re-running `pnpm check` only.
