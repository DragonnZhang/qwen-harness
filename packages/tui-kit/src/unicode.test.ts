import { describe, expect, it } from 'vitest';

import { graphemeCount, graphemeWidth, stringWidth, toGraphemes } from './unicode.ts';

/**
 * The three Unicode properties the terminal cannot get wrong (UI-03): CJK is width 2, an emoji is
 * one grapheme, and a combining mark attaches to its base.
 */
describe('grapheme segmentation and width', () => {
  it('treats CJK as two graphemes of width two each', () => {
    expect(toGraphemes('你好')).toEqual(['你', '好']);
    expect(graphemeCount('你好')).toBe(2);
    expect(graphemeWidth('你')).toBe(2);
    expect(stringWidth('你好')).toBe(4);
  });

  it('treats an emoji as a single grapheme of width two', () => {
    expect(toGraphemes('👍')).toEqual(['👍']);
    expect(graphemeCount('👍')).toBe(1);
    expect(graphemeWidth('👍')).toBe(2);
  });

  it('attaches a combining accent to its base as one grapheme', () => {
    const eAccent = 'e\u0301'; // e + COMBINING ACUTE ACCENT
    expect(toGraphemes(eAccent)).toEqual([eAccent]);
    expect(graphemeCount(eAccent)).toBe(1);
    expect(stringWidth(eAccent)).toBe(1);
  });

  it('joins a ZWJ emoji sequence and a skin-tone modifier into one grapheme', () => {
    const family = '👨‍👩‍👧'; // man ZWJ woman ZWJ girl
    expect(graphemeCount(family)).toBe(1);
    const thumbTone = '👍\u{1f3fb}'; // thumbs up + light skin tone
    expect(graphemeCount(thumbTone)).toBe(1);
  });

  it('pairs two regional indicators into one flag', () => {
    expect(graphemeCount('\u{1f1fa}\u{1f1f8}')).toBe(1); // 🇺🇸
  });

  it('measures plain ASCII as width one per character', () => {
    expect(stringWidth('hello')).toBe(5);
    expect(graphemeCount('hello')).toBe(5);
  });
});

/**
 * The optimized width path must be EXACTLY the old one, not merely close.
 *
 * `graphemeWidth` was rewritten for speed (the performance gate caught it costing 217 ms on an
 * 18 KB payload against a 50 ms per-frame budget): an ASCII fast path, hoisted regexes, and a
 * BINARY SEARCH over the wide ranges instead of a linear scan. A binary search is only correct if
 * the range table is sorted and non-nested — an assumption that is easy to break later by adding a
 * range in the wrong place, and whose failure mode is silent (a CJK character quietly measuring one
 * cell, so the cursor lands in the wrong column).
 *
 * So we check it exhaustively against a reference linear scan across the entire Unicode space,
 * rather than trusting the table to stay sorted.
 */
describe('optimized width equals the reference implementation, exhaustively', () => {
  // The reference: the original, obviously-correct linear scan.
  const REFERENCE_WIDE: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f],
    [0x2329, 0x232a],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x16fe0, 0x16fe4],
    [0x17000, 0x18aff],
    [0x1b000, 0x1b2ff],
    [0x1f004, 0x1f004],
    [0x1f0cf, 0x1f0cf],
    [0x1f18e, 0x1f18e],
    [0x1f191, 0x1f19a],
    [0x1f200, 0x1f320],
    [0x1f300, 0x1f64f],
    [0x1f680, 0x1f6ff],
    [0x1f900, 0x1f9ff],
    [0x1fa00, 0x1faff],
    [0x20000, 0x3fffd],
  ];

  function referenceWidth(ch: string): number {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return 0;
    if (/\p{M}|\p{Cf}/u.test(String.fromCodePoint(cp))) return 0;
    for (const [lo, hi] of REFERENCE_WIDE) {
      if (cp >= lo && cp <= hi) return 2;
    }
    return 1;
  }

  it('agrees on every codepoint in the Unicode space (surrogates excluded)', () => {
    const disagreements: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      // Lone surrogates are not scalar values and cannot appear in well-formed text.
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (graphemeWidth(ch) !== referenceWidth(ch)) disagreements.push(cp);
    }
    expect(disagreements.slice(0, 10)).toEqual([]);
    expect(disagreements.length).toBe(0);
  });

  it('still measures the things a terminal must not get wrong', () => {
    expect(stringWidth('你好')).toBe(4); // two wide CJK cells each
    expect(stringWidth('ab')).toBe(2);
    expect(stringWidth('é́́')).toBe(1); // base + combining marks = one cell
    expect(graphemeWidth('👍')).toBe(2);
  });
});

/**
 * `stringWidth` no longer routes through `toGraphemes` — it walks codepoints directly, because
 * allocating one string per grapheme was eating the whole per-frame budget. That makes it a SECOND
 * implementation of the clustering rules, and a second implementation is a second chance to be
 * wrong. So it is pinned to the readable one on adversarial and random input.
 */
describe('stringWidth agrees with the readable toGraphemes/graphemeWidth composition', () => {
  const reference = (s: string): number =>
    toGraphemes(s).reduce((sum, g) => sum + graphemeWidth(g), 0);

  const ADVERSARIAL = [
    '',
    'plain ascii',
    '你好世界',
    '👍',
    '👩‍👩‍👧‍👦', // ZWJ family
    '🇯🇵', // regional indicator pair
    '🇯🇵🇩🇪', // two flags back to back
    '🇯', // lone regional indicator
    'é́́', // base + stacked combining marks
    'áb́', // combining marks between ASCII
    '👍🏽', // skin-tone modifier
    'x‍y', // ZWJ between plain letters
    '‍', // leading ZWJ
    'ｆｕｌｌｗｉｄｔｈ',
    'مرحبا بالعالم',
    'a­y', // soft hyphen (Cf, zero width)
    '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', // astral plane
    'mixed 你好 👍 é́ ascii 🇯🇵 end',
  ];

  it('agrees on adversarial strings', () => {
    for (const s of ADVERSARIAL) {
      expect(stringWidth(s), JSON.stringify(s)).toBe(reference(s));
    }
  });

  it('agrees on random strings drawn from the whole scalar space', () => {
    // Deterministic PRNG: a failure must be reproducible, not a one-off the next run hides.
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 300; trial += 1) {
      let s = '';
      const length = next() % 40;
      for (let i = 0; i < length; i += 1) {
        let cp = next() % 0x110000;
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x41; // skip lone surrogates
        s += String.fromCodePoint(cp);
      }
      expect(stringWidth(s), `seed trial ${trial}: ${JSON.stringify(s)}`).toBe(reference(s));
    }
  });
});
