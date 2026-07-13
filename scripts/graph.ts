/**
 * THE dependency graph. Single source of truth.
 *
 * `scripts/gen-packages.ts` generates manifests and TS project references from it, and
 * `scripts/architecture.ts` enforces it against the real import graph. Because both read this
 * file, a manifest can never quietly disagree with the enforced boundary.
 *
 * Required direction (task.md):
 *
 *   protocol
 *     -> config / storage / provider-core / tools-core / policy
 *     -> domain capability packages
 *     -> runtime
 *     -> cli / tui
 *
 * `A -> B` means B may depend on A; A must not depend on B.
 */

export const LAYERS = {
  /** Layer 0. Pure data, schemas, versions. Opens no host capability whatsoever. */
  protocol: ['protocol'],

  /** Layer 1. Foundation services that layer 2 builds on. */
  foundation: ['config', 'storage', 'provider-core', 'tools-core', 'policy'],

  /** Layer 2. Domain capabilities. May depend on layers 0-1 and on each other only as declared. */
  domain: [
    'provider-dashscope',
    'secret-store',
    'sandbox-linux',
    'network',
    'tool-worker',
    'tools-builtin',
    'hooks',
    'instructions',
    'skills',
    'context',
    'memory',
    'tasks',
    'background',
    'scheduler',
    'agents',
    'teams',
    'worktrees',
    'mcp',
    'telemetry',
    'tui-kit',
  ],

  /** Layer 3. Coordinates interfaces and state machines. Performs no direct host I/O. */
  runtime: ['runtime'],

  /** Layer 4. Clients. No package may import an app. */
  apps: ['daemon', 'remote-worker', 'cli', 'tui'],

  /** Test-only. May depend on anything; nothing in production code may depend on it. */
  testkit: ['testkit'],
} as const;

export type PackageName = (typeof LAYERS)[keyof typeof LAYERS][number] | 'testkit';

/**
 * The ONLY packages permitted to open a host capability, and exactly which one.
 * `scripts/architecture.ts` fails the build if any other package imports these modules.
 * This is boundary #5 in task.md ("Legal I/O owners are explicit").
 */
export const IO_OWNERS: Record<string, { modules: string[]; why: string }> = {
  storage: {
    modules: ['node:fs', 'node:fs/promises', 'node:path', 'better-sqlite3'],
    why: 'owns the SQLite event store and its files',
  },
  'provider-dashscope': {
    modules: ['node:http', 'node:https', 'undici'],
    why: 'owns model-endpoint traffic; the only reader of DASHSCOPE_API_KEY',
  },
  'sandbox-linux': {
    modules: ['node:child_process', 'node:fs', 'node:fs/promises', 'node:path', 'node:os'],
    why: 'owns process/filesystem isolation; the only package that may construct a sandboxed process',
  },
  'tool-worker': {
    modules: ['node:fs', 'node:fs/promises', 'node:path', 'node:child_process', 'node:os'],
    why: 'the sandboxed worker; the ONLY place model-initiated file/shell/Git I/O executes',
  },
  network: {
    modules: ['node:http', 'node:https', 'node:net', 'undici'],
    why: 'the approved outbound connection broker for web fetch, hooks, and MCP',
  },
  'secret-store': {
    modules: ['node:fs', 'node:fs/promises', 'node:path', 'node:crypto', 'node:child_process'],
    why: 'owns Linux secret backends (libsecret / encrypted 0600 file)',
  },
  mcp: {
    modules: ['node:child_process', 'node:net'],
    why: 'owns MCP stdio/socket transports; outbound HTTP still goes through network',
  },
  telemetry: {
    modules: ['node:fs', 'node:fs/promises', 'node:path'],
    why: 'owns local redacted observability output',
  },
  hooks: {
    modules: ['node:child_process'],
    why: 'controlled command-hook executor; HTTP hooks go through network',
  },
  worktrees: {
    modules: ['node:child_process', 'node:fs', 'node:fs/promises', 'node:path'],
    why: 'owns git worktree lifecycle',
  },
  config: {
    modules: ['node:fs', 'node:fs/promises', 'node:path', 'node:os'],
    why: 'reads layered configuration files and reports provenance',
  },
  instructions: {
    modules: ['node:fs', 'node:fs/promises', 'node:path'],
    why: 'reads repository instruction files',
  },
  skills: {
    modules: ['node:fs', 'node:fs/promises', 'node:path'],
    why: 'reads SKILL.md metadata/bodies and canonicalizes (realpath) every skill root and resource',
  },
  memory: {
    modules: ['node:fs', 'node:fs/promises', 'node:path'],
    why: 'reads and writes Markdown memory files',
  },
  testkit: {
    modules: ['node:fs', 'node:fs/promises', 'node:path', 'node:child_process', 'node:os'],
    why: 'test fixtures build disposable repositories; never on a production path',
  },
};

/** Packages that must never touch a host capability, no matter what. */
export const PURE_PACKAGES = [
  'protocol',
  'provider-core',
  'tools-core',
  'policy',
  'runtime',
  'tui-kit',
];

export const PACKAGE_DEPS: Record<PackageName, PackageName[]> = {
  // Layer 0
  protocol: [],

  // Layer 1
  config: ['protocol'],
  storage: ['protocol'],
  'provider-core': ['protocol'],
  'tools-core': ['protocol'],
  policy: ['protocol'],

  // Layer 2
  'secret-store': ['protocol', 'config'],
  'provider-dashscope': ['protocol', 'provider-core', 'secret-store'],
  'sandbox-linux': ['protocol', 'policy'],
  network: ['protocol', 'policy', 'config'],
  'tool-worker': ['protocol', 'tools-core', 'policy', 'sandbox-linux'],
  'tools-builtin': ['protocol', 'tools-core', 'policy', 'tool-worker'],
  // NOTE(hooks impl): `config` has no src/index.ts yet, so it is not buildable/importable. Per the
  // hooks build brief, drop `config` for now (hooks does not consume config in this checkpoint) and
  // keep `network` — HTTP hooks route through the network broker, which hooks depends on
  // STRUCTURALLY (an injected NetworkBroker port, no direct import), so this is safe today. Restore
  // 'config' here once packages/config/src/index.ts exists.
  // hooks imports only protocol + policy. Its integration with config (hook configuration) and
  // network (HTTP-hook egress) is via INJECTED ports (see packages/hooks/src/ports.ts), not a
  // package dependency — which keeps the hook engine decoupled and testable without those packages.
  hooks: ['protocol', 'policy'],
  instructions: ['protocol', 'config'],
  // `skills` is a leaf domain package on purpose. It needs protocol (Clock/IdSource, UntrustedText),
  // config (the project config dir layout the source table is anchored on), and policy (Authority +
  // `intersect`, so a forked skill's authority can only ever narrow). It deliberately does NOT
  // depend on `instructions`: prompt modes (IN-09) live next to the prompt sections they modify, and
  // skills must not be able to reach into prompt assembly.
  skills: ['protocol', 'config', 'policy'],
  context: ['protocol', 'provider-core', 'storage'],
  memory: ['protocol', 'config', 'storage'],
  tasks: ['protocol', 'storage'],
  telemetry: ['protocol', 'config'],
  worktrees: ['protocol', 'policy', 'storage', 'config'],
  background: ['protocol', 'storage', 'policy', 'tools-core'],
  scheduler: ['protocol', 'storage', 'policy', 'config'],
  agents: ['protocol', 'policy', 'storage', 'provider-core', 'tools-core'],
  teams: ['protocol', 'policy', 'storage', 'tasks', 'agents'],
  mcp: ['protocol', 'policy', 'config', 'network', 'secret-store', 'tools-core'],
  'tui-kit': ['protocol'],

  // Layer 3
  runtime: [
    'protocol',
    'config',
    'storage',
    'provider-core',
    'tools-core',
    'policy',
    'hooks',
    'instructions',
    'context',
    'memory',
    'tasks',
    'background',
    'scheduler',
    'agents',
    'teams',
    'worktrees',
    'mcp',
    'telemetry',
  ],

  // Layer 4 (apps)
  //
  // The daemon depends on `cli` on purpose. `apps/cli/src/wiring.ts` IS the composition root —
  // `createHarnessRuntime` is where provider, policy, sandboxed tool worker and event store are
  // assembled. The daemon runs the same turns the CLI runs, so it reuses that composition instead
  // of forking it. A second wiring would be a second place for a security property to drift, and a
  // property proved for the CLI would then say nothing about the daemon. Apps are still terminal:
  // no PACKAGE may import an app (architecture rule 2), and this edge is app -> app, acyclic.
  daemon: [
    'protocol',
    'runtime',
    'storage',
    'config',
    'telemetry',
    'provider-dashscope',
    'tools-builtin',
    'sandbox-linux',
    'cli',
  ],
  'remote-worker': [
    'protocol',
    'runtime',
    'config',
    'telemetry',
    'provider-dashscope',
    'tools-builtin',
    'sandbox-linux',
  ],
  // `cli` is THE composition root, so it is the app that reaches the widest. Every entry below is a
  // subsystem it must actually construct: a package with no app importing it is a package no user
  // can reach, and the capability matrix cannot honestly be verified against it.
  cli: [
    'protocol',
    'runtime',
    'config',
    'storage',
    'provider-dashscope',
    'tools-builtin',
    'tools-core',
    'tool-worker',
    'policy',
    'provider-core',
    'sandbox-linux',
    // Composed into the turn path by `wiring.ts` / `main.ts`.
    'telemetry',
    'instructions',
    'hooks',
    'skills',
    'memory',
    'mcp',
    // Token budgeting, offload, prune, and compaction, wired into the turn path via a
    // `ContextManager` the engine calls before every model round (`context.ts`).
    'context',
    // Durable work: the task graph (`tasks.ts`), the background lifecycle (`background.ts`), and the
    // Cron scheduler + supervisor (`scheduler.ts`). Each is constructed against the real event store
    // so a task/job/background result survives a process restart by being reconstructed from the log.
    'tasks',
    'background',
    'scheduler',
    // The multi-agent TEAM subsystem (`team.ts`): a lead creates dependent tasks, launches REAL
    // sandboxed teammates each in its OWN git worktree, routes plan/permission approvals over a
    // durable protocol bus, resolves concurrent claiming, receives results, and shuts down cleanly.
    // `teams` provides the inbox/protocol/recovery, `agents` the authority-intersection ceiling for a
    // teammate, `worktrees` the real per-teammate isolation. (`teams` already re-uses `tasks`.)
    'teams',
    'agents',
    'worktrees',
    // NOT declared: `network` and `secret-store`. They back MCP's HTTP/SSE transports and OAuth
    // token storage, which this app does not construct — only `stdio` servers are launchable from a
    // config file today. Declaring a dependency the app does not import would be a claim in the
    // graph that the code does not honour.
  ],
  tui: ['protocol', 'runtime', 'config', 'tui-kit', 'telemetry'],

  // Test-only.
  //
  // Depends on `protocol` ALONE, deliberately. testkit is a devDependency of every other package,
  // so anything testkit depends on would gain a workspace cycle (config -> testkit -> config).
  // Keeping it at layer 0 makes that impossible by construction.
  //
  // This costs nothing: the deterministic primitives testkit exposes (ManualClock, IdSource) are
  // already defined in `protocol` as interfaces, and fakes for provider/tool contracts are typed
  // structurally against those interfaces rather than importing the implementing packages.
  testkit: ['protocol'],
};
