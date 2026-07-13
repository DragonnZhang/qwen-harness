import { describe, expect, it } from 'vitest';

import { parseInline, segmentMarkdown } from './markdown.ts';

describe('markdown segmentation (UI-02)', () => {
  it('segments paragraphs, fenced code, and inline code', () => {
    const source = [
      'Here is a paragraph with `inline` code.',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'A closing paragraph.',
    ].join('\n');

    const blocks = segmentMarkdown(source);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph']);

    const code = blocks[1];
    expect(code?.kind).toBe('code');
    if (code?.kind === 'code') {
      expect(code.language).toBe('ts');
      expect(code.text).toBe('const x = 1;');
      expect(code.closed).toBe(true);
    }

    const firstPara = blocks[0];
    if (firstPara?.kind === 'paragraph') {
      const kinds = firstPara.spans.map((s) => s.kind);
      expect(kinds).toContain('code');
    }
  });

  it('renders an unterminated code fence as an open block without throwing (streaming)', () => {
    const streaming = ['Answer:', '', '```python', 'def f():', '    return 1'].join('\n');
    const blocks = segmentMarkdown(streaming);
    const code = blocks.find((b) => b.kind === 'code');
    expect(code?.kind).toBe('code');
    if (code?.kind === 'code') {
      expect(code.closed).toBe(false); // fence never closed
      expect(code.language).toBe('python');
      expect(code.text).toContain('def f():');
    }
  });

  it('does not render a javascript: link as a link (attack), but does render https', () => {
    const unsafe = parseInline('click [here](javascript:alert(1)) now');
    expect(unsafe.some((s) => s.kind === 'link')).toBe(false);
    expect(unsafe.some((s) => s.kind === 'unsafe-link')).toBe(true);

    const safe = parseInline('see [docs](https://example.com/page)');
    const link = safe.find((s) => s.kind === 'link');
    expect(link?.kind).toBe('link');
    if (link?.kind === 'link') {
      expect(link.href).toBe('https://example.com/page');
      expect(link.text).toBe('docs');
    }
  });

  it('treats file: and data: link targets as unsafe', () => {
    for (const target of ['file:///etc/passwd', 'data:text/html,<script>']) {
      const spans = parseInline(`[x](${target})`);
      expect(spans.some((s) => s.kind === 'link')).toBe(false);
      expect(spans.some((s) => s.kind === 'unsafe-link')).toBe(true);
    }
  });

  it('keeps an unterminated inline backtick as literal text', () => {
    const spans = parseInline('an `unterminated span');
    expect(spans.every((s) => s.kind === 'text')).toBe(true);
    expect(spans.map((s) => (s.kind === 'text' ? s.text : '')).join('')).toContain('`unterminated');
  });
});
