import { describe, expect, it } from 'vitest';

import type { TextOrigin } from './domain.ts';
import { isSafeLinkTarget, sanitize, sanitizeText } from './sanitize.ts';

const ESC = '\u001b';
const BEL = '\u0007';

/** Assert nothing that could reach a terminal driver survived. */
function assertInert(text: string) {
  expect(text, 'ESC survived').not.toContain(ESC);
  expect(text, 'BEL survived').not.toContain(BEL);
  // No C0 control other than \n and \t, no DEL, no C1.
  // eslint-disable-next-line no-control-regex
  expect(text, 'a control character survived').not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
}

describe('terminal control sequences are neutralized (TL-11)', () => {
  const attacks: [name: string, payload: string][] = [
    ['OSC 52 clipboard write (silent exfiltration)', `${ESC}]52;c;aGVsbG8gd29ybGQ=${BEL}`],
    ['OSC 0 terminal title rewrite', `${ESC}]0;pwned${BEL}`],
    ['OSC 8 hyperlink whose text lies about its target', `${ESC}]8;;http://evil.example${BEL}click me${ESC}]8;;${BEL}`],
    ['CSI screen clear + cursor home (repaint the screen)', `${ESC}[2J${ESC}[H`],
    ['CSI cursor move (overwrite the trusted status line)', `${ESC}[1;1H${ESC}[K`],
    ['SGR colour codes used to imitate trusted chrome', `${ESC}[42m${ESC}[30m APPROVED ${ESC}[0m`],
    ['DCS device control string', `${ESC}Pq#0;2;0;0;0#0~~${ESC}\\`],
    ['APC application command', `${ESC}_Gf=100${ESC}\\`],
    ['bare ESC with a malformed sequence', `${ESC}[[[?`],
    ['carriage return overwriting prior output', 'you owe $0\rYOU OWE $9999'],
    ['backspace erasing prior output', 'safe\u0008\u0008\u0008\u0008evil'],
    ['NUL byte', 'before\u0000after'],
  ];

  it.each(attacks)('neutralizes: %s', (_name, payload) => {
    const result = sanitize(payload, { origin: 'tool' });
    assertInert(result.text);
    expect(result.modified, 'attack was not detected').toBe(true);
    expect(result.strippedControlSequences).toBeGreaterThan(0);
  });

  it('does not let an OSC payload survive as literal text', () => {
    // The danger is not only the escape byte. If we stripped ESC but kept the payload, the
    // base64 clipboard blob / attacker URL would still be sitting in the transcript.
    const result = sanitize(`${ESC}]52;c;c2VjcmV0${BEL}`, { origin: 'model' });
    expect(result.text).not.toContain('c2VjcmV0');
    expect(result.text).not.toContain('52;c');
  });

  it('does not let an OSC 8 hyperlink target survive as literal text', () => {
    const result = sanitize(`${ESC}]8;;http://evil.example${BEL}safe text${ESC}]8;;${BEL}`, {
      origin: 'markdown-link',
    });
    expect(result.text).not.toContain('evil.example');
    // The visible label is content and is preserved.
    expect(result.text).toContain('safe text');
  });

  it('a forged approval dialog cannot reach the terminal', () => {
    // The realistic attack: tool output paints something that looks like our own approval UI.
    const forged =
      `${ESC}[2J${ESC}[H${ESC}[1;32m` +
      '  ✓ Allow write to /etc/passwd?  [y/N] ' +
      `${ESC}[0m${ESC}[6n`;
    const result = sanitize(forged, { origin: 'tool' });

    assertInert(result.text);
    // The TEXT may still be there — that is fine and correct, the user sees it as tool output.
    // What must NOT survive is the ability to position it as chrome or to clear the screen.
    expect(result.text).not.toContain('[2J');
    expect(result.modified).toBe(true);
  });
});

describe('every origin crosses the same sanitizer (TL-14)', () => {
  // The threat model is explicit that these attacks come from model, repository, hook, MCP, web,
  // and Markdown content — not only from tool stdout. There is one sanitizer, not six.
  const origins: TextOrigin[] = [
    'model',
    'repository',
    'tool',
    'hook',
    'mcp',
    'web',
    'provider',
    'markdown-link',
  ];

  it.each(origins)('sanitizes content originating from: %s', (origin) => {
    const result = sanitize(`${ESC}]0;title${BEL}payload`, { origin });
    assertInert(result.text);
    expect(result.modified).toBe(true);
    expect(result.origin).toBe(origin);
  });
});

describe('deceptive Unicode', () => {
  it('strips bidirectional overrides (Trojan Source)', () => {
    // RLO makes displayed text read differently from its bytes — e.g. hiding what a command does.
    const trojan = 'if (isAdmin) {\u202e // }\u202d';
    const result = sanitize(trojan, { origin: 'repository' });
    expect(result.text).not.toMatch(/[\u202a-\u202e]/);
    expect(result.modified).toBe(true);
  });

  it('strips zero-width characters used to hide a payload', () => {
    const result = sanitize('inno\u200bcent\u200dtext\ufeff', { origin: 'model' });
    expect(result.text).not.toMatch(/[\u200b-\u200f\ufeff]/);
  });

  it('strips alternate line separators some terminals treat as newlines', () => {
    const result = sanitize('a\u2028b\u2029c', { origin: 'web' });
    expect(result.text).not.toMatch(/[\u2028\u2029]/);
  });
});

describe('content is preserved', () => {
  it('keeps newlines and tabs — they are content, not control', () => {
    const result = sanitize('line one\n\tindented\nline two', { origin: 'tool' });
    expect(result.text).toBe('line one\n\tindented\nline two');
    expect(result.modified).toBe(false);
    expect(result.strippedControlSequences).toBe(0);
  });

  it('keeps Unicode, CJK, emoji, and combining characters intact', () => {
    const text = '你好世界 🎉 café é ñ';
    expect(sanitizeText(text, 'model')).toBe(text);
  });

  it('normalizes CRLF to LF without flagging it as an attack', () => {
    const result = sanitize('a\r\nb', { origin: 'tool' });
    expect(result.text).toBe('a\nb');
    expect(result.modified).toBe(false);
  });

  it('collapses newlines when the context is single-line chrome', () => {
    const result = sanitize('status\nline', { origin: 'tool', multiline: false });
    expect(result.text).toBe('status line');
  });
});

describe('bounded output', () => {
  it('announces truncation rather than silently cutting', () => {
    // A silent cut can invert meaning ("do not delete" -> "do"). Truncation is always visible.
    const result = sanitize('x'.repeat(100), { origin: 'tool', maxLength: 10 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('truncated 90 chars');
    expect(result.modified).toBe(true);
  });
});

describe('link targets (TL-13, TL-14)', () => {
  it.each([
    ['https://example.com', true],
    ['http://example.com/path?q=1', true],
    ['mailto:a@example.com', true],
    ['javascript:alert(1)', false],
    ['data:text/html;base64,PHNjcmlwdD4=', false],
    ['file:///etc/passwd', false],
    ['vbscript:msgbox', false],
    ['not a url', false],
    ['/relative/path', false],
  ])('isSafeLinkTarget(%s) === %s', (url, expected) => {
    expect(isSafeLinkTarget(url)).toBe(expected);
  });
});
