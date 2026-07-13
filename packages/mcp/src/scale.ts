import { sanitize, type SafeText, untrusted } from '@qwen-harness/protocol';

import type { McpTool } from './protocol-types.ts';

/**
 * Making MCP usable at scale (MC-10): large-output offload, tool search / lazy schema loading,
 * monitor tasks, a doctor surface, and per-server logs. These are the pieces that keep a chatty
 * server from destroying the context budget or hiding a failure.
 *
 * The numeric limits are the frozen defaults (defaults.md, "Tool and output defaults").
 */

/** A single MCP tool result larger than this is offloaded to a durable ref instead of inlined. */
export const MCP_DURABLE_LIMIT_CHARS = 500_000;
/** The bounded, model-facing preview budget (~25,000 tokens). Head+tail, never a silent middle cut. */
export const MCP_INLINE_LIMIT_CHARS = 100_000;

/** Where offloaded output goes. Injected — `mcp` does not own a filesystem for durable blobs. */
export interface OutputSink {
  /** Persist the full content and return a redacted, retrievable reference (TL-10). */
  put(content: string): Promise<string>;
}

export interface OffloadResult {
  /** Bounded, sanitized text safe to place in the model context. */
  readonly modelText: string;
  /** Set when the full output was offloaded; the preview above then stands in for it. */
  readonly outputRef: string | null;
  readonly truncated: boolean;
}

/**
 * Sanitize a tool's combined text output and bound it for the model. Over the durable limit and
 * with a sink available, the full text is offloaded and the model sees a head+tail preview plus a
 * reference; otherwise it is truncated in place with an explicit marker.
 */
export async function offloadLargeOutput(
  rawText: string,
  sink: OutputSink | null,
): Promise<OffloadResult> {
  const safe = sanitize(untrusted(rawText), {
    origin: 'mcp',
    maxLength: MCP_DURABLE_LIMIT_CHARS,
  });
  const full = safe.text as string;

  if (rawText.length > MCP_DURABLE_LIMIT_CHARS && sink !== null) {
    const outputRef = await sink.put(rawText);
    return { modelText: boundedPreview(full), outputRef, truncated: true };
  }
  if (full.length > MCP_INLINE_LIMIT_CHARS) {
    return { modelText: boundedPreview(full), outputRef: null, truncated: true };
  }
  return { modelText: full, outputRef: null, truncated: safe.truncated };
}

/** A head+tail preview: the model sees both ends and an explicit note about the elided middle. */
function boundedPreview(text: string): string {
  if (text.length <= MCP_INLINE_LIMIT_CHARS) return text;
  const half = Math.floor(MCP_INLINE_LIMIT_CHARS / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const elided = text.length - head.length - tail.length;
  return `${head}\n… [${elided} characters elided — retrieve the full output by reference] …\n${tail}`;
}

// -----------------------------------------------------------------------------------------------
// Tool search / lazy schema loading
// -----------------------------------------------------------------------------------------------

export interface ToolSearchHit {
  readonly name: string;
  readonly description: SafeText;
  readonly score: number;
}

/**
 * Rank a server's tools against a query using name + description, so a large catalog can be
 * searched instead of loaded whole. Descriptions are sanitized before they are returned — a search
 * result is displayed, and the text came from an untrusted server.
 */
export function searchTools(tools: readonly McpTool[], query: string, limit = 20): ToolSearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const hits: ToolSearchHit[] = [];
  for (const tool of tools) {
    const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (tool.name.toLowerCase().includes(term)) score += 2;
      else if (haystack.includes(term)) score += 1;
    }
    if (terms.length === 0 || score > 0) {
      hits.push({
        name: tool.name,
        description: sanitize(untrusted(tool.description ?? ''), { origin: 'mcp', maxLength: 512 })
          .text,
        score,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score || cmp(a.name, b.name)).slice(0, limit);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// -----------------------------------------------------------------------------------------------
// Per-server logs + doctor
// -----------------------------------------------------------------------------------------------

export interface ServerLogEntry {
  readonly at: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: SafeText;
}

/** A bounded ring buffer of a server's log lines. Every line is sanitized on the way in (MC-10). */
export class ServerLog {
  readonly #entries: ServerLogEntry[] = [];
  readonly #max: number;

  constructor(max = 500) {
    this.#max = max;
  }

  append(level: ServerLogEntry['level'], message: string, at: number): void {
    this.#entries.push({
      at,
      level,
      message: sanitize(untrusted(message), { origin: 'mcp', maxLength: 2_048 }).text,
    });
    if (this.#entries.length > this.#max) this.#entries.shift();
  }

  get entries(): readonly ServerLogEntry[] {
    return this.#entries;
  }
}

export type ServerHealth = 'connecting' | 'ready' | 'degraded' | 'disconnected' | 'failed';

/** One row of the `doctor` MCP surface (OB-03/MC-10). */
export interface ServerDoctorRow {
  readonly server: string;
  readonly transport: string;
  readonly health: ServerHealth;
  readonly toolCount: number;
  readonly lastError: string | null;
  readonly recentLog: readonly ServerLogEntry[];
}

// -----------------------------------------------------------------------------------------------
// Monitor tasks — a long-running MCP watch (MC-10 / BG-03 "MCP monitor")
// -----------------------------------------------------------------------------------------------

export interface MonitorTask {
  readonly id: string;
  stop(): void;
}

/**
 * Run a callback on every server notification matching `method`, returning a handle the background
 * system can stop. The notification data is untrusted, so `onEvent` receives it already sanitized.
 */
export function monitorNotifications(
  bus: { on(method: string, handler: (data: unknown) => void): () => void },
  method: string,
  id: string,
  onEvent: (data: unknown) => void,
): MonitorTask {
  const off = bus.on(method, onEvent);
  return { id, stop: off };
}
