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
