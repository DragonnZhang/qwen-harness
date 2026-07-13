/**
 * Grapheme-cluster segmentation and terminal display width — the primitive the editor and the view
 * models stand on (UI-03).
 *
 * WHY a hand-written segmenter rather than `Intl.Segmenter`: this is a PURE, layer-0-adjacent
 * package (architecture rule 5). `Intl.Segmenter` is available at runtime on the target Node, but
 * its types are not in the `ES2023` lib this repo compiles against, and — more importantly — a
 * documented codepoint algorithm is deterministic across every host and ICU version, which is
 * exactly the property the rest of the runtime (RT-08) depends on. So we implement the parts of
 * Unicode UAX #29 the terminal actually needs, and we document every rule.
 *
 * The three properties the terminal cannot get wrong:
 *
 *   1. A CJK ideograph or a wide emoji occupies TWO terminal cells; everything else occupies one.
 *      Miscount this and the cursor lands in the wrong column and the line wraps wrongly.
 *   2. An emoji (even a multi-codepoint one) is ONE grapheme — one thing the user deletes with one
 *      backspace and steps over with one cursor move.
 *   3. A combining mark (e + ◌́) attaches to its base and is never a separate cursor stop.
 */

/** Zero-width joiner (U+200D): glues emoji sequences such as a family emoji into one grapheme. */
const ZWJ = 0x200d;

/** A base codepoint that renders in two terminal cells (East Asian Wide / Fullwidth + emoji). */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK radicals, Kangxi, punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK symbols
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x16fe0, 0x16fe4], // Tangut/Nushu marks
  [0x17000, 0x18aff], // Tangut, Khitan
  [0x1b000, 0x1b2ff], // Kana supplements
  [0x1f004, 0x1f004], // 🀄
  [0x1f0cf, 0x1f0cf], // 🃏
  [0x1f18e, 0x1f18e], // 🆎
  [0x1f191, 0x1f19a], // squared latin
  [0x1f200, 0x1f320], // enclosed ideographic supplement + emoji
  [0x1f300, 0x1f64f], // Misc symbols, emoticons (👍 lives here)
  [0x1f680, 0x1f6ff], // transport & map
  [0x1f900, 0x1f9ff], // supplemental symbols (🤝)
  [0x1fa00, 0x1faff], // symbols extended-A
  [0x20000, 0x3fffd], // CJK Extension B and beyond
];

/** Regional indicator letters 🇦..🇿 — two of them combine into one flag grapheme. */
function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * A codepoint that binds to the preceding base rather than starting a new grapheme: any Unicode
 * combining mark (`\p{M}`), a variation selector, or an emoji skin-tone modifier.
 */
function isExtend(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true; // variation selectors supplement
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true; // emoji modifiers (skin tone)
  return /\p{M}/u.test(ch); // Mn / Mc / Me combining marks
}

/** True for a codepoint that occupies no terminal cell of its own. */
function isZeroWidth(ch: string): boolean {
  return /\p{M}|\p{Cf}/u.test(ch);
}

function isWideCodePoint(cp: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * Split text into grapheme clusters: the units a human perceives as single characters and the
 * units the editor steps over one at a time.
 *
 * The algorithm walks codepoints (surrogate-pair aware via the string iterator) and extends the
 * current cluster when the next codepoint is a combining mark/selector, follows a ZWJ, or pairs a
 * second regional indicator. Anything else starts a new cluster.
 */
export function toGraphemes(text: string): string[] {
  const clusters: string[] = [];
  let current = '';
  let prevWasZwj = false;
  let openRegional = false;

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;

    if (current === '') {
      current = ch;
      prevWasZwj = cp === ZWJ;
      openRegional = isRegionalIndicator(cp);
      continue;
    }

    if (isExtend(ch) || cp === ZWJ) {
      current += ch;
      prevWasZwj = cp === ZWJ;
      openRegional = false;
      continue;
    }

    if (prevWasZwj) {
      // A ZWJ glues whatever follows into the same emoji cluster.
      current += ch;
      prevWasZwj = false;
      openRegional = isRegionalIndicator(cp);
      continue;
    }

    if (openRegional && isRegionalIndicator(cp)) {
      // Second half of a flag; the pair is now complete.
      current += ch;
      openRegional = false;
      continue;
    }

    clusters.push(current);
    current = ch;
    prevWasZwj = cp === ZWJ;
    openRegional = isRegionalIndicator(cp);
  }

  if (current !== '') clusters.push(current);
  return clusters;
}

/** Number of grapheme clusters — the editor's unit of cursor motion. */
export function graphemeCount(text: string): number {
  return toGraphemes(text).length;
}

/** Terminal cell width of a single grapheme: 0 (combining), 1 (normal), or 2 (CJK/emoji). */
export function graphemeWidth(grapheme: string): number {
  const cp = grapheme.codePointAt(0);
  if (cp === undefined) return 0;
  const base = String.fromCodePoint(cp);
  if (isZeroWidth(base)) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
}

/** Total terminal cell width of a string, summed over its graphemes. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const g of toGraphemes(text)) width += graphemeWidth(g);
  return width;
}

/** Join a slice of a grapheme array back into a string (`from` inclusive, `to` exclusive). */
export function sliceGraphemes(graphemes: readonly string[], from: number, to?: number): string {
  return graphemes.slice(from, to).join('');
}
