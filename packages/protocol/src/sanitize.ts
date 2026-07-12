import type { SafeText, TextOrigin, UntrustedText } from './domain.ts';

/**
 * The single sanitizer every untrusted string must cross before it reaches a terminal, a log, or
 * an export (TL-14).
 *
 * The threat is not theoretical. A model, a README, a tool's stdout, a hook, an MCP server
 * description, or a fetched web page can all emit terminal control sequences. Left alone, those
 * sequences can:
 *
 *   - repaint the screen to forge an approval dialog the user then "confirms" (approval confusion);
 *   - write to the system clipboard via OSC 52 — exfiltration with no visible trace;
 *   - rewrite the terminal title, or emit an OSC 8 hyperlink whose visible text lies about its target;
 *   - move the cursor to overwrite the trusted status line or the `yolo` danger banner.
 *
 * So the rule is inverted from the usual one. We do not blocklist "bad" sequences — a blocklist of
 * terminal escapes is a losing game. We allow NO control characters through at all, except the two
 * that are genuinely content (`\n` and `\t`). Everything else becomes a visible, inert
 * placeholder: visible, because silently swallowing an attack hides it from the user; inert,
 * because that is the entire point.
 *
 * Only typed trusted-chrome values — constructed by the TUI itself, never derived from input —
 * may emit real terminal control sequences.
 */

/** Marks a removed control sequence. Rendered visibly so an attack is *apparent*, not eaten. */
const PLACEHOLDER = '�';

const ESC = '\\u001b';

/**
 * Whole ESC-introduced sequences, stripped FIRST so their payload cannot survive as literal text —
 * the URL inside an OSC 8 hyperlink, or the base64 clipboard blob inside OSC 52.
 *
 *   ESC [ ... final    CSI  — cursor movement, colour, screen clear
 *   ESC ] ... BEL|ST   OSC  — window title, hyperlink, clipboard (OSC 52)
 *   ESC P|X|^|_ ... ST DCS/SOS/PM/APC — device control strings
 *   ESC <char>         two-character escapes
 */
const ANSI_SEQUENCE = new RegExp(
  `(?:${ESC}\\[[0-?]*[ -/]*[@-~]` +
    `|${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\|$)` +
    `|${ESC}[P^_X][\\s\\S]*?(?:${ESC}\\\\|$)` +
    `|${ESC}[@-Z\\\\-_])`,
  'g',
);

/** C0 controls except \t (09) and \n (0A); DEL (7F); C1 controls (80-9F). */

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** A lone CR rewinds the cursor to column 0 and can overwrite text the user already read. */
const LONE_CR = /\r/g;

/**
 * Not "control characters", but used to lie about what text says: bidirectional overrides
 * (Trojan Source), zero-width characters that hide a payload inside innocuous text, and alternate
 * line separators that some terminals treat as newlines.
 */
const DECEPTIVE_UNICODE =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u00ad\u2028\u2029\ufeff]/g;

export interface SanitizeOptions {
  /** Where the text came from. Recorded for provenance; it never relaxes anything. */
  readonly origin: TextOrigin;
  /** Hard cap. Oversized content is truncated with an explicit marker, never silently. */
  readonly maxLength?: number;
  /** Allow newlines. False for single-line chrome such as the status line. */
  readonly multiline?: boolean;
}

export interface SanitizeResult {
  readonly text: SafeText;
  /** True if anything was stripped, so the UI can flag "this output tried to control your terminal". */
  readonly modified: boolean;
  readonly strippedControlSequences: number;
  readonly truncated: boolean;
  readonly origin: TextOrigin;
}

/**
 * The ONLY way to obtain a `SafeText`.
 *
 * `SafeText` is a nominal type, so it cannot be produced by a cast. A renderer that accepts only
 * `SafeText` is therefore *statically guaranteed* to have been handed sanitized content — the
 * compiler enforces the trust boundary, not code review.
 */
export function sanitize(input: UntrustedText | string, options: SanitizeOptions): SanitizeResult {
  const original = String(input);
  let stripped = 0;

  const count = <T>(fn: () => T): T => {
    stripped++;
    return fn();
  };

  // 1. Whole ANSI/OSC/DCS sequences, so their payload never survives as text.
  let out = original.replace(ANSI_SEQUENCE, () => count(() => PLACEHOLDER));

  // 2. Normalize CRLF to LF before treating a lone CR as hostile.
  out = out.replace(/\r\n/g, '\n');
  out = out.replace(LONE_CR, () => count(() => PLACEHOLDER));

  // 3. Any remaining control character — including a bare ESC whose sequence was malformed, and
  //    the BEL that terminates an OSC. `\n` and `\t` are excluded from the class: they are content.
  out = out.replace(CONTROL_CHARS, () => count(() => PLACEHOLDER));

  // 4. Deceptive Unicode: bidi overrides, zero-width characters, alternate line separators.
  out = out.replace(DECEPTIVE_UNICODE, () => count(() => PLACEHOLDER));

  if (options.multiline === false) {
    out = out.replace(/\n/g, ' ');
  }

  // 5. Bounded length. Truncation is ANNOUNCED — a silent cut can invert the meaning of text.
  let truncated = false;
  const max = options.maxLength;
  if (max !== undefined && out.length > max) {
    out = out.slice(0, max) + `… [truncated ${out.length - max} chars]`;
    truncated = true;
  }

  return {
    text: out as SafeText,
    modified: stripped > 0 || truncated,
    strippedControlSequences: stripped,
    truncated,
    origin: options.origin,
  };
}

/** Convenience for the common case where only the text is needed. */
export function sanitizeText(input: UntrustedText | string, origin: TextOrigin): SafeText {
  return sanitize(input, { origin }).text;
}

/**
 * URL schemes safe to render as a clickable link.
 *
 * `javascript:`, `data:`, `file:`, and `vbscript:` are excluded. A Markdown link from a model or a
 * repository README whose target is `javascript:...` or `file:///etc/passwd` is an attack, not a
 * link — and OSC 8 lets the visible text differ from the target, so the user cannot tell.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isSafeLinkTarget(url: string): boolean {
  try {
    return SAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    // Not a parseable absolute URL. Relative targets are not rendered as links.
    return false;
  }
}
