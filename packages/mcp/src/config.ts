import { z } from 'zod';

/**
 * MCP server config resolution (MC-05).
 *
 * Two rules, both frozen in defaults.md ("Configuration precedence"):
 *
 *   1. Managed-exclusive policy resolves FIRST and is a ceiling. When exclusive, only the servers
 *      the administrator allows can run — no lower source can add one. A managed deny always wins.
 *   2. Otherwise precedence is `connector < plugin < user < approved-project < local`: a
 *      higher-ranked source overrides a same-named server from a lower one.
 *
 * On top of that, a PROJECT-scoped server is never silently trusted (MC-05, SC-02). It appears in
 * the resolution with `trusted: false` and `active: false` until the user explicitly trusts it —
 * repository content cannot enable an MCP server by itself. Every resolved server carries its
 * provenance so `doctor` can explain why it is (or is not) running.
 */

export const MCP_CONFIG_SOURCES = [
  'connector',
  'plugin',
  'user',
  'approved-project',
  'local',
] as const;
export type McpConfigSource = (typeof MCP_CONFIG_SOURCES)[number];

/** Higher wins. `connector` is weakest, `local` strongest. */
export const MCP_SOURCE_RANK: Record<McpConfigSource, number> = {
  connector: 0,
  plugin: 1,
  user: 2,
  'approved-project': 3,
  local: 4,
};

/** Sources that come from repository/project material and therefore require explicit trust. */
const PROJECT_SOURCES: ReadonlySet<McpConfigSource> = new Set(['approved-project', 'local']);

export const TransportConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    autoRestart: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    /** Separate GET endpoint for the server→client SSE stream. Defaults to `url`. */
    sseUrl: z.string().url().optional(),
    /** Static headers sent on every request (e.g. a pre-provisioned bearer token). */
    headers: z.record(z.string(), z.string()).optional(),
    /** Whether to open a standalone SSE stream for server-initiated messages. Default true. */
    openServerStream: z.boolean().optional(),
  }),
  z.object({ type: z.literal('sse'), url: z.string().url() }),
  z.object({ type: z.literal('websocket'), url: z.string().url() }),
  z.object({ type: z.literal('ide-sse'), sseUrl: z.string().url(), postUrl: z.string().url() }),
]);
export type TransportConfig = z.infer<typeof TransportConfigSchema>;

export const McpServerConfigSchema = z.object({
  name: z.string().min(1).max(128),
  transport: TransportConfigSchema,
  enabled: z.boolean().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** One source's contribution: the servers it declares. */
export interface McpConfigLayer {
  readonly source: McpConfigSource;
  readonly servers: readonly McpServerConfig[];
}

export interface ManagedMcpPolicy {
  /** When true, ONLY `allowedServers` may run, whatever any lower source says. */
  readonly exclusive: boolean;
  readonly allowedServers: readonly string[];
  /** Always-denied server names; a managed deny dominates every source. */
  readonly deniedServers: readonly string[];
}

export const NO_MANAGED_MCP: ManagedMcpPolicy = {
  exclusive: false,
  allowedServers: [],
  deniedServers: [],
};

export interface ResolvedMcpServer {
  readonly config: McpServerConfig;
  /** The source whose value won. */
  readonly source: McpConfigSource;
  /** Lower sources that were overridden, weakest-first, for `doctor`. */
  readonly overriddenBy: readonly McpConfigSource[];
  /** A project server is trusted only if the user explicitly trusted it. */
  readonly trusted: boolean;
  /** Whether the server will actually be connected: trusted, enabled, and within the ceiling. */
  readonly active: boolean;
  /** Human-readable reason it is inactive, when it is. */
  readonly inactiveReason: string | null;
}

export interface ResolveMcpOptions {
  readonly layers: readonly McpConfigLayer[];
  readonly managed?: ManagedMcpPolicy;
  /** Server names the user has explicitly trusted (from an out-of-band trust prompt). */
  readonly trustedServers?: ReadonlySet<string>;
}

/**
 * Resolve every configured server to its winning value, trust status, and activation, deterministic
 * for a given input. Servers are returned sorted by name.
 */
export function resolveMcpServers(opts: ResolveMcpOptions): ResolvedMcpServer[] {
  const managed = opts.managed ?? NO_MANAGED_MCP;
  const trusted = opts.trustedServers ?? new Set<string>();
  const denied = new Set(managed.deniedServers);
  const exclusiveAllow = new Set(managed.allowedServers);

  // Collect the contributing source per server name, keeping the strongest and the losers.
  const byName = new Map<
    string,
    { winner: McpConfigLayer; config: McpServerConfig; losers: McpConfigSource[] }
  >();
  for (const layer of [...opts.layers].sort(
    (a, b) => MCP_SOURCE_RANK[a.source] - MCP_SOURCE_RANK[b.source],
  )) {
    for (const server of layer.servers) {
      const existing = byName.get(server.name);
      if (existing === undefined) {
        byName.set(server.name, { winner: layer, config: server, losers: [] });
      } else {
        // Layers are ascending, so this one outranks the stored winner: demote the old one.
        existing.losers.push(existing.winner.source);
        existing.winner = layer;
        existing.config = server;
      }
    }
  }

  const out: ResolvedMcpServer[] = [];
  for (const [name, entry] of byName) {
    const source = entry.winner.source;
    const isProject = PROJECT_SOURCES.has(source);
    const isTrusted = !isProject || trusted.has(name);
    let active = true;
    let reason: string | null = null;

    if (denied.has(name)) {
      active = false;
      reason = 'denied by managed policy';
    } else if (managed.exclusive && !exclusiveAllow.has(name)) {
      active = false;
      reason = 'managed policy is exclusive and does not list this server';
    } else if (!isTrusted) {
      active = false;
      reason = 'project server is not trusted (explicit trust required)';
    } else if (entry.config.enabled === false) {
      active = false;
      reason = 'disabled in config';
    }

    out.push({
      config: entry.config,
      source,
      overriddenBy: entry.losers,
      trusted: isTrusted,
      active,
      inactiveReason: reason,
    });
  }
  return out.sort((a, b) =>
    a.config.name < b.config.name ? -1 : a.config.name > b.config.name ? 1 : 0,
  );
}
