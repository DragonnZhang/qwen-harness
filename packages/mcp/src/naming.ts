import { sanitize, type SafeText, untrusted } from '@qwen-harness/protocol';

/**
 * Tool naming and trust (MC-03).
 *
 * A server's tools become `mcp__<server>__<tool>` so they never collide with built-ins and their
 * origin is legible in any log. Three things are handled deterministically here:
 *
 *   - normalization: invalid characters are replaced, not passed through, so a hostile tool name
 *     cannot inject `__` boundaries or shell/terminal metacharacters into the namespaced id;
 *   - collisions: if two normalized names land on the same string, the later one (in a stable,
 *     sorted order) gets a numeric suffix — always the same result for the same input set;
 *   - built-in precedence: a built-in name always wins; an MCP tool that would shadow one is
 *     suffixed instead. There is no way for a server to REPLACE a built-in tool.
 *
 * Server-authored text (descriptions, titles) is UNTRUSTED. It crosses the sanitizer before it is
 * ever returned for display, so an ANSI/OSC payload in a description cannot forge TUI chrome
 * (TL-14). A hostile input schema is handled upstream by the zod boundary — it cannot crash us.
 */

export const MCP_NAME_PREFIX = 'mcp__';
const SEGMENT_SEP = '__';
/** Only these survive in a normalized segment; everything else becomes `_`. */
const SAFE_SEGMENT = /[^a-zA-Z0-9-]+/g;

/** Normalize one segment (a server id or a tool name). Never empty; bounded length. */
export function normalizeSegment(raw: string): string {
  const cleaned = raw.replace(SAFE_SEGMENT, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const bounded = cleaned.slice(0, 64);
  return bounded.length > 0 ? bounded : 'unnamed';
}

/** The namespaced id for a tool. `mcp__filesystem__read_file`. */
export function toolName(server: string, tool: string): string {
  return `${MCP_NAME_PREFIX}${normalizeSegment(server)}${SEGMENT_SEP}${normalizeSegment(tool)}`;
}

export interface RawMcpToolRef {
  readonly server: string;
  readonly tool: string;
}

export interface NamedMcpTool {
  readonly server: string;
  readonly tool: string;
  /** The final, collision-free, built-in-safe name. */
  readonly name: string;
  /** True if this name was disambiguated away from a collision or a built-in. */
  readonly renamed: boolean;
}

/**
 * Assign final names to a set of MCP tools, deterministically resolving collisions and yielding to
 * built-ins. Input order does not matter: the result is sorted by (server, tool) first, so the same
 * set always produces the same assignment.
 */
export function assignToolNames(
  tools: readonly RawMcpToolRef[],
  builtinNames: ReadonlySet<string> = new Set(),
): NamedMcpTool[] {
  const sorted = [...tools].sort((a, b) =>
    a.server === b.server ? cmp(a.tool, b.tool) : cmp(a.server, b.server),
  );
  const taken = new Set<string>(builtinNames);
  const out: NamedMcpTool[] = [];
  for (const ref of sorted) {
    const base = toolName(ref.server, ref.tool);
    let name = base;
    let n = 1;
    let renamed = false;
    // A built-in with this name, or a previously-assigned MCP tool, forces a numeric suffix.
    while (taken.has(name)) {
      n += 1;
      name = `${base}_${n}`;
      renamed = true;
    }
    taken.add(name);
    out.push({ server: ref.server, tool: ref.tool, name, renamed });
  }
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sanitize server-authored text before display. A tool description, a server's `instructions`, or
 * a resource name are all untrusted (`origin: 'mcp'`), and this is the ONLY door they pass through
 * on the way to a TUI, a log, or an export.
 */
export function sanitizeMcpText(raw: string, maxLength = 4_096): SafeText {
  return sanitize(untrusted(raw), { origin: 'mcp', maxLength }).text;
}
