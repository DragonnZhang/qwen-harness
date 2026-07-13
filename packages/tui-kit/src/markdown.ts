/**
 * Markdown/code segmentation for assistant text (UI-02).
 *
 * This turns a model message into renderable spans: paragraphs, fenced code blocks (with a
 * language), inline code, and links. Three properties matter and are tested:
 *
 *   1. STREAMING TOLERANCE. The model streams; at any instant the text may end mid-fence. An
 *      unterminated ``` must render as an OPEN code block (`closed: false`), never throw and never
 *      let the rest of the message leak out styled as prose.
 *   2. LINK SAFETY. A `[click](javascript:…)` or `[cfg](file:///etc/passwd)` from a model is an
 *      attack, not a link (see `isSafeLinkTarget`). Only `http/https/mailto` targets become a
 *      `link` span; every other target degrades to an `unsafe-link` span the renderer draws as
 *      PLAIN TEXT, so the user can never click a lie.
 *   3. INERTNESS. Every span's text is `SafeText`. The input is model output; each piece crosses
 *      `sanitize` with a `model` origin, so control sequences are neutralised even inside code.
 */

import type { SafeText } from '@qwen-harness/protocol';
import { isSafeLinkTarget, sanitize } from '@qwen-harness/protocol';

export type InlineSpan =
  | { readonly kind: 'text'; readonly text: SafeText }
  | { readonly kind: 'code'; readonly text: SafeText }
  | { readonly kind: 'link'; readonly text: SafeText; readonly href: SafeText }
  // A link whose target scheme is unsafe. Rendered as plain text, NOT as a clickable link.
  | { readonly kind: 'unsafe-link'; readonly text: SafeText; readonly rawTarget: SafeText };

export type MarkdownBlock =
  | { readonly kind: 'paragraph'; readonly spans: readonly InlineSpan[] }
  | {
      readonly kind: 'code';
      readonly language: string | null;
      readonly text: SafeText;
      /** False when the fence never closed — an open block still being streamed. */
      readonly closed: boolean;
    };

function safeModel(text: string): SafeText {
  return sanitize(text, { origin: 'model' }).text;
}

function safeLinkTarget(text: string): SafeText {
  return sanitize(text, { origin: 'markdown-link', multiline: false }).text;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/;

/**
 * Segment a model message into blocks. `source` is the raw (or already-sanitized — sanitizing is
 * idempotent) model text; it stays a plain string so the markdown SYNTAX (fences, brackets,
 * backticks) is still visible to the parser, while each emitted piece is re-sanitized to `SafeText`.
 */
export function segmentMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? '```';
      const language = (fence[2] ?? '').trim();
      const body: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const inner = lines[j] ?? '';
        // A closing fence is the same marker character run, alone on its line.
        if (new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(inner)) {
          closed = true;
          break;
        }
        body.push(inner);
      }
      blocks.push({
        kind: 'code',
        language: language === '' ? null : language,
        text: safeModel(body.join('\n')),
        closed,
      });
      // If the fence never closed we consumed the rest of the input; `j` sits at lines.length.
      i = closed ? j : lines.length;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

const LINK = /\[([^\]]*)\]\(([^)]*)\)/;

/** Parse inline spans: inline code first (highest precedence), then links, then plain runs. */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let rest = text;

  while (rest.length > 0) {
    const tick = rest.indexOf('`');
    const linkMatch = LINK.exec(rest);
    const linkAt = linkMatch?.index ?? -1;

    // Whichever construct comes first wins; nothing before it is plain text.
    const nextSpecial = pickFirst(tick, linkAt);
    if (nextSpecial === -1) {
      pushText(spans, rest);
      break;
    }

    if (nextSpecial > 0) {
      pushText(spans, rest.slice(0, nextSpecial));
      rest = rest.slice(nextSpecial);
      continue;
    }

    if (tick === 0) {
      const close = rest.indexOf('`', 1);
      if (close === -1) {
        // Unterminated inline code (streaming): the backtick is literal text.
        pushText(spans, rest);
        break;
      }
      spans.push({ kind: 'code', text: safeModel(rest.slice(1, close)) });
      rest = rest.slice(close + 1);
      continue;
    }

    // linkAt === 0
    if (linkMatch) {
      const label = linkMatch[1] ?? '';
      const target = linkMatch[2] ?? '';
      if (isSafeLinkTarget(target)) {
        spans.push({ kind: 'link', text: safeModel(label), href: safeLinkTarget(target) });
      } else {
        spans.push({
          kind: 'unsafe-link',
          text: safeModel(label),
          rawTarget: safeLinkTarget(target),
        });
      }
      rest = rest.slice(linkMatch[0].length);
      continue;
    }

    // Unreachable, but keeps the loop total.
    pushText(spans, rest);
    break;
  }

  return spans;
}

/** Smallest non-negative index, or -1 when both are absent. */
function pickFirst(a: number, b: number): number {
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function pushText(spans: InlineSpan[], text: string): void {
  if (text === '') return;
  spans.push({ kind: 'text', text: safeModel(text) });
}
