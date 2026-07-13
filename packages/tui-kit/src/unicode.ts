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
 * The lowest codepoint that can possibly be a combining mark (`\p{M}` begins at U+0300) or a
 * zero-width format character. Below this, the answer to "does it combine?" and "is it zero
 * width?" is always no — with the single exception of U+00AD SOFT HYPHEN, which is `\p{Cf}`.
 *
 * This constant is the whole optimization, and it matters because the fixture in
 * `test/performance` caught the original code taking 217 ms to width-measure an 18 KB payload —
 * four times the entire per-frame budget. The reason was mundane: `stringWidth` ran TWO Unicode
 * property regexes plus a linear scan of 26 ranges for every grapheme, so ordinary ASCII text paid
 * the full cost of Unicode on every single character. Real transcripts are overwhelmingly ASCII.
 *
 * Nothing about the semantics changes — the slow path below is still the authority, and the
 * property tests compare against it. This only skips work that provably cannot matter.
 */
const BELOW_COMBINING = 0x0300;
const SOFT_HYPHEN = 0x00ad;
/** Nothing below the first Hangul Jamo is ever double-width. */
const BELOW_WIDE = 0x1100;

// Hoisted so they are compiled once, not re-evaluated on every call.
const COMBINING_MARK = /\p{M}/u;
const ZERO_WIDTH = /\p{M}|\p{Cf}/u;

/**
 * A codepoint that binds to the preceding base rather than starting a new grapheme: any Unicode
 * combining mark (`\p{M}`), a variation selector, or an emoji skin-tone modifier.
 */
function isExtend(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  // Fast path: no codepoint below U+0300 is a combining mark, a selector, or a modifier.
  if (cp < BELOW_COMBINING) return false;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true; // variation selectors supplement
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true; // emoji modifiers (skin tone)
  return COMBINING_MARK.test(ch); // Mn / Mc / Me combining marks
}

/** True for a codepoint that occupies no terminal cell of its own. */
function isZeroWidth(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (cp < BELOW_COMBINING && cp !== SOFT_HYPHEN) return false;
  return ZERO_WIDTH.test(ch);
}

/**
 * Binary search over the sorted, non-overlapping wide ranges. The list is ordered by construction;
 * `unicode.test.ts` asserts that ordering, so a future range added out of order fails the test
 * rather than silently making a CJK character measure one cell wide.
 */
function isWideCodePoint(cp: number): boolean {
  if (cp < BELOW_WIDE) return false;
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = WIDE_RANGES[mid];
    if (range === undefined) return false;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
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

/**
 * Total terminal cell width of a string, summed over its graphemes.
 *
 * This walks codepoints directly instead of `toGraphemes(text).map(graphemeWidth)`. The old form
 * allocated one short-lived string per grapheme — roughly 10,000 of them for a single 18 KB
 * payload — and the allocation, not the arithmetic, was the cost. It is the hottest function in the
 * TUI (every frame measures every visible line), and the performance gate caught it eating the
 * entire per-frame budget on its own.
 *
 * The cluster rules below mirror `toGraphemes` exactly, and only a cluster's BASE codepoint
 * contributes width — which is precisely what `graphemeWidth` does, since it reads the first
 * codepoint of the cluster. `unicode.test.ts` asserts the two agree on random and adversarial
 * strings, so this fast path can never silently drift from the readable one.
 */
export function stringWidth(text: string): number {
  let width = 0;
  let inCluster = false;
  let prevWasZwj = false;
  let openRegional = false;

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;

    // Printable ASCII — the overwhelming majority of real transcript text. One cell, always a new
    // cluster, and provably neither an extender nor wide, so nothing below needs to run.
    //
    // `!prevWasZwj` is load-bearing and was missing at first: a ZWJ glues whatever FOLLOWS it into
    // the current cluster, including a plain ASCII letter, so `x<ZWJ>y` is ONE grapheme one cell
    // wide. Taking the fast path there counted `y` as a second cluster and returned 2. The
    // equivalence test against `toGraphemes`/`graphemeWidth` caught it — which is the entire reason
    // a hand-rolled fast path must be pinned to the readable implementation rather than trusted.
    if (cp >= 0x20 && cp < 0x7f && !prevWasZwj) {
      width += 1;
      inCluster = true;
      prevWasZwj = false;
      openRegional = false;
      continue;
    }

    if (!inCluster) {
      width += widthOfCodePoint(cp, ch);
      inCluster = true;
      prevWasZwj = cp === ZWJ;
      openRegional = isRegionalIndicator(cp);
      continue;
    }

    // Extenders, ZWJ-glued parts, and the second half of a flag all join the current cluster and
    // contribute no width of their own.
    if (isExtend(ch) || cp === ZWJ) {
      prevWasZwj = cp === ZWJ;
      openRegional = false;
      continue;
    }
    if (prevWasZwj) {
      prevWasZwj = false;
      openRegional = isRegionalIndicator(cp);
      continue;
    }
    if (openRegional && isRegionalIndicator(cp)) {
      openRegional = false;
      continue;
    }

    // Anything else begins a new cluster, and a new cluster is what costs cells.
    width += widthOfCodePoint(cp, ch);
    prevWasZwj = cp === ZWJ;
    openRegional = isRegionalIndicator(cp);
  }

  return width;
}

/** The width a cluster's base codepoint contributes. Shared by `graphemeWidth` and `stringWidth`. */
function widthOfCodePoint(cp: number, ch: string): number {
  if (isZeroWidth(ch)) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
}

/** Join a slice of a grapheme array back into a string (`from` inclusive, `to` exclusive). */
export function sliceGraphemes(graphemes: readonly string[], from: number, to?: number): string {
  return graphemes.slice(from, to).join('');
}
