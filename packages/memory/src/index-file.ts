/**
 * `MEMORY.md` — the always-loaded memory index (MM-01).
 *
 * Startup loads only the FIRST part of `MEMORY.md`: the first 200 lines OR the first 25 KiB,
 * whichever comes first (defaults.md, "Memory defaults"). Topic files are never loaded here — they
 * load on demand through retrieval (MM-02). The cap is a hard budget so a runaway index can never
 * blow the startup context: a 300-line index is truncated to 200 lines, and a 40 KiB index is
 * truncated at the 25 KiB boundary even if that is only a handful of lines.
 */

/** The frozen index caps (defaults.md). */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

/** The canonical file name of the memory index within a scope directory. */
export const MEMORY_INDEX_FILENAME = 'MEMORY.md';

export interface LoadedIndex {
  /** The loaded prefix — at most the first 200 lines and 25 KiB. */
  readonly content: string;
  /** True if the source was larger than the cap and was cut. */
  readonly truncated: boolean;
  /** How many lines were loaded. */
  readonly lines: number;
  /** UTF-8 byte length of {@link content}. */
  readonly bytes: number;
  /** Which cap stopped the load, or `null` when the whole file fit. */
  readonly stoppedBy: 'lines' | 'bytes' | null;
}

/**
 * Load at most the first {@link MEMORY_INDEX_MAX_LINES} lines or {@link MEMORY_INDEX_MAX_BYTES}
 * bytes of a `MEMORY.md`, whichever boundary is reached first.
 *
 * Bytes are measured as UTF-8, because the budget protects the model's context (measured in real
 * serialized bytes), not JavaScript UTF-16 code units. Each line is re-joined with its `\n` so the
 * accumulated byte count matches what is actually emitted.
 */
export function loadMemoryIndex(
  text: string,
  caps: { maxLines?: number; maxBytes?: number } = {},
): LoadedIndex {
  const maxLines = caps.maxLines ?? MEMORY_INDEX_MAX_LINES;
  const maxBytes = caps.maxBytes ?? MEMORY_INDEX_MAX_BYTES;

  const sourceLines = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  let stoppedBy: 'lines' | 'bytes' | null = null;

  for (let i = 0; i < sourceLines.length; i++) {
    if (kept.length >= maxLines) {
      stoppedBy = 'lines';
      break;
    }
    const line = sourceLines[i] ?? '';
    // The `\n` separator counts against the budget for every line except a possible last one; we
    // add it uniformly here and correct the final trailing newline when we assemble the string.
    const addition = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + addition > maxBytes) {
      stoppedBy = 'bytes';
      break;
    }
    kept.push(line);
    bytes += addition;
  }

  const cutByLines = stoppedBy === 'lines';
  const cutByBytes = stoppedBy === 'bytes';
  const truncated = cutByLines || cutByBytes;
  const content = kept.join('\n');

  return {
    content,
    truncated,
    lines: kept.length,
    bytes: Buffer.byteLength(content, 'utf8'),
    stoppedBy,
  };
}
