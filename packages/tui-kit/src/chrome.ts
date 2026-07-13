/**
 * Trusted chrome (UI-02, UI-06, TL-11).
 *
 * The trust boundary has two sides. `SafeText` is untrusted content that has been made INERT — a
 * model message, a tool's stdout, a diff. Trusted chrome is the opposite: the labels, borders,
 * banners, and status indicators the TUI draws AROUND that content. Only trusted chrome may style
 * the terminal (colour a border, bold a banner), and it must NEVER be derived from untrusted input
 * — otherwise a tool that prints "APPROVED" could forge the frame the user reads as our own voice.
 *
 * We encode this as a nominal type, exactly as `SafeText` does. A `TrustedChrome` value can only be
 * produced by {@link chrome} from a string literal the TUI itself owns. The renderer accepts
 * `SafeText` for content and `TrustedChrome` for framing, and the compiler keeps the two from ever
 * being confused — the same static guarantee `sanitize` gives, applied to the other side of the line.
 */

declare const chromeBrand: unique symbol;

/** A label/banner/border string the TUI owns and is allowed to render with terminal styling. */
export type TrustedChrome = string & { readonly [chromeBrand]: 'TrustedChrome' };

/**
 * Construct trusted chrome. Call this ONLY with constant strings the client itself authored. There
 * is deliberately no path from `UntrustedText`/`SafeText` to `TrustedChrome`: crossing that line is
 * the attack this whole boundary exists to prevent.
 */
export function chrome(literal: string): TrustedChrome {
  return literal as TrustedChrome;
}

/** Stable chrome labels the transcript view attaches to each row kind. */
export const ROW_LABELS = {
  user: chrome('user'),
  assistant: chrome('assistant'),
  reasoningSummary: chrome('reasoning'),
  reasoningStatus: chrome('thinking'),
  toolCall: chrome('tool'),
  toolResult: chrome('result'),
  diff: chrome('diff'),
  error: chrome('error'),
  usage: chrome('usage'),
  progress: chrome('progress'),
  approval: chrome('approval'),
  compaction: chrome('compacted'),
  userShell: chrome('shell'),
} as const;

/**
 * The persistent `yolo` danger banner (PS-05, UI-06). It is trusted chrome by construction, so tool
 * output can never overwrite or spoof it — a `SafeText` value simply is not assignable here.
 */
export const YOLO_BANNER: TrustedChrome = chrome(
  'YOLO MODE — prompts disabled, isolation off; every tool runs with full authority',
);
