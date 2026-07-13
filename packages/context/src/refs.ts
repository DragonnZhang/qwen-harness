/**
 * Durable context references (part of CX-02, and TL-10 in spirit).
 *
 * When a large tool result is offloaded, it is replaced in the working context by a `ContextRef`: a
 * bounded preview plus an opaque reference to where the full payload lives. The actual blob store is
 * `storage`'s concern — this module only PRODUCES the reference and the bounded preview, so it stays
 * a pure computation. The preview keeps a head and a tail (the two ends carry the most signal: what
 * the result was and how it ended) with an explicit elision marker in between.
 */

import { defaultTokenEstimator, type TokenEstimator } from './budget.ts';

export type ContextRefKind = 'tool-result' | 'transcript';

export interface ContextRef {
  /** Opaque durable reference id. `storage` maps this to the full payload. */
  readonly ref: string;
  readonly kind: ContextRefKind;
  /** Size of the full (pre-offload) payload in characters. */
  readonly chars: number;
  /** Estimated tokens of the full payload — what offloading it reclaims. */
  readonly estimatedTokens: number;
  /** Bounded head+tail preview safe to keep inline. */
  readonly preview: string;
  /** True when the payload was larger than the preview budget and had to be elided. */
  readonly previewTruncated: boolean;
}

export interface RefPreviewOptions {
  /** Characters kept from the start. Default 512. */
  readonly headChars?: number;
  /** Characters kept from the end. Default 512. */
  readonly tailChars?: number;
  readonly estimate?: TokenEstimator;
}

const DEFAULT_HEAD = 512;
const DEFAULT_TAIL = 512;

/** A bounded head+tail preview of `text`, eliding the middle with a byte-count marker. */
export function boundedPreview(
  text: string,
  options: RefPreviewOptions = {},
): { preview: string; truncated: boolean } {
  const head = options.headChars ?? DEFAULT_HEAD;
  const tail = options.tailChars ?? DEFAULT_TAIL;
  if (text.length <= head + tail) return { preview: text, truncated: false };
  const elided = text.length - head - tail;
  return {
    preview: `${text.slice(0, head)}\n…[offloaded ${elided} chars]…\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Build a `ContextRef` for `text` under the given opaque `refId`. */
export function makeContextRef(
  refId: string,
  text: string,
  kind: ContextRefKind,
  options: RefPreviewOptions = {},
): ContextRef {
  const estimate = options.estimate ?? defaultTokenEstimator;
  const { preview, truncated } = boundedPreview(text, options);
  return {
    ref: refId,
    kind,
    chars: text.length,
    estimatedTokens: estimate(text),
    preview,
    previewTruncated: truncated,
  };
}

/** How an offloaded tool result reads inline: the preview plus a pointer to fetch the full payload. */
export function renderOffloaded(ref: ContextRef): string {
  return `${ref.preview}\n[full result offloaded — ref=${ref.ref}, ${ref.chars} chars]`;
}
