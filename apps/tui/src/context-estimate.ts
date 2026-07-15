import type { Item } from '@qwen-harness/protocol';

const CHARS_PER_TOKEN = 4;

/**
 * How much context the current transcript occupies, for the status line (CX-01: "measured serialized
 * size / token estimates"). Returns null before anything is in the transcript — the indicator stays
 * hidden until there is context to report — and otherwise the serialized transcript size expressed in
 * ~4-char tokens. The full budgeting math (window, reserve, utilization fraction) lives in and is
 * exercised by `@qwen-harness/context`; this is the single number the TUI actually surfaces so a user
 * can see the context filling up.
 */
export function estimateContextTokens(items: readonly Item[]): number | null {
  if (items.length === 0) return null;
  return Math.ceil(JSON.stringify(items).length / CHARS_PER_TOKEN);
}
