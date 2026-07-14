/**
 * Unit tests for the tool-worker's pure content classifiers and diff (TL-03 `U`, TL-04 `U`).
 *
 * These are the exact functions the sandboxed file tools use to DECIDE things — is this file binary,
 * what line ending does it use, has the source changed under us, and what did an edit change. They
 * are pure (Buffer/string in, value out), so they are unit-tested here directly; the sandboxed
 * behaviour they drive (pagination, escape rejection, stale-source refusal) is proven separately in
 * the integration/security/property suites this file names.
 */

import { describe, expect, it } from 'vitest';

import { detectLineEnding, digest, isBinary, unifiedDiff } from '../../src/handlers.ts';

describe('isBinary (TL-03) — a NUL byte in the first 8 KiB marks a file binary', () => {
  it('plain UTF-8 text is not binary', () => {
    expect(isBinary(Buffer.from('hello\nworld\n', 'utf8'))).toBe(false);
  });

  it('an empty buffer is not binary', () => {
    expect(isBinary(Buffer.alloc(0))).toBe(false);
  });

  it('a NUL byte anywhere in the first 8 KiB makes it binary', () => {
    expect(isBinary(Buffer.from([0x68, 0x69, 0x00, 0x21]))).toBe(true);
  });

  it('a NUL only AFTER the first 8 KiB is not detected (bounded window, by design)', () => {
    const buf = Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]);
    expect(isBinary(buf)).toBe(false);
    // …but a NUL at the last byte of the window IS caught.
    const inWindow = Buffer.concat([Buffer.alloc(8191, 0x41), Buffer.from([0x00])]);
    expect(isBinary(inWindow)).toBe(true);
  });

  it('UTF-8 multibyte content (no NUL) is not binary', () => {
    expect(isBinary(Buffer.from('café — 日本語 — 🚀', 'utf8'))).toBe(false);
  });
});

describe('detectLineEnding (TL-03) — CRLF iff any CRLF is present', () => {
  it('LF-only text reports \\n', () => {
    expect(detectLineEnding('a\nb\nc')).toBe('\n');
  });
  it('any CRLF reports \\r\\n', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toBe('\r\n');
    // A single CRLF among LFs still counts as CRLF (that is what "preserve" keys off).
    expect(detectLineEnding('a\nb\r\nc')).toBe('\r\n');
  });
  it('text with no newline at all defaults to \\n', () => {
    expect(detectLineEnding('single line')).toBe('\n');
  });
});

describe('digest (TL-04) — the stale-source guard key', () => {
  it('is deterministic and content-addressed (equal content ⇒ equal digest)', () => {
    expect(digest('const x = 1\n')).toBe(digest('const x = 1\n'));
  });
  it('changes when the content changes by even one byte', () => {
    expect(digest('const x = 1\n')).not.toBe(digest('const x = 2\n'));
  });
  it('is a fixed-width hex string', () => {
    expect(digest('anything')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('unifiedDiff (TL-04) — per-file diff of an edit', () => {
  it('emits a - line and a + line for a single-line change, with a tight hunk', () => {
    const d = unifiedDiff('src/x.ts', 'keep\nold\ntail\n', 'keep\nnew\ntail\n');
    expect(d).toContain('--- a/src/x.ts');
    expect(d).toContain('+++ b/src/x.ts');
    expect(d).toContain('-old');
    expect(d).toContain('+new');
    // The unchanged lines are context, not churn.
    expect(d).toContain(' keep');
    expect(d).toContain(' tail');
  });

  it('an insertion emits the inserted lines as additions, bracketed by context', () => {
    const d = unifiedDiff('f', 'a\nb\n', 'a\nX\nY\nb\n');
    const body = d.split('\n').slice(3); // drop ---/+++/@@
    // The inserted lines appear as additions.
    expect(body).toContain('+X');
    expect(body).toContain('+Y');
    // The leading unchanged line stays CONTEXT, not churn (the differ brackets the change region; it
    // is not minimal — a boundary line may be re-emitted — but it round-trips, proven in the P test).
    expect(body).toContain(' a');
  });

  it('the @@ header line counts equal the emitted context+change line counts', () => {
    const d = unifiedDiff('f', 'a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n');
    const header = d.split('\n').find((l) => l.startsWith('@@'))!;
    const m = header.match(/@@ -\d+,(\d+) \+\d+,(\d+) @@/)!;
    const [, aCount, bCount] = m;
    const body = d.split('\n').slice(d.split('\n').indexOf(header) + 1);
    const aLines = body.filter((l) => l.startsWith(' ') || l.startsWith('-')).length;
    const bLines = body.filter((l) => l.startsWith(' ') || l.startsWith('+')).length;
    expect(aLines).toBe(Number(aCount));
    expect(bLines).toBe(Number(bCount));
  });
});
