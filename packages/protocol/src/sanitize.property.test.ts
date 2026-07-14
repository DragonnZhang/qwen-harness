/**
 * TL-11 (untrusted terminal content) and TL-14 (the single UntrustedText sanitizer) — the `P`
 * (property/fuzz) evidence class.
 *
 * The example-based `sanitize.test.ts` proves the sanitizer defeats a fixed catalogue of attacks.
 * This file proves the INVARIANTS hold for arbitrary input: strings salted with random
 * ANSI/CSI/OSC/DCS escape sequences, C0/C1 control bytes, OSC-52 clipboard payloads, OSC-8
 * hyperlinks, bidi/RTL overrides, zero-width characters, alternate line separators, and arbitrary
 * unicode — over EVERY `origin` and option combination (TL-14: one sanitizer, every crossing).
 *
 * The invariants are restated here INDEPENDENTLY of the production source (they are not imported
 * from `sanitize.ts`), so a regression that let an escape survive would genuinely FAIL this test.
 *
 * If the fuzzer finds an input the sanitizer does not neutralize, that is a security bug: the
 * failing counterexample is the report. Do not weaken the invariant to make it pass.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TextOrigin } from './domain.ts';
import { isSafeLinkTarget, sanitize, type SanitizeOptions } from './sanitize.ts';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`; // String Terminator (ESC \)

/** Every origin. TL-14 is specifically that all of these cross the SAME sanitizer. */
const ORIGINS: readonly TextOrigin[] = [
  'model',
  'repository',
  'tool',
  'hook',
  'mcp',
  'web',
  'provider',
  'user',
  'markdown-link',
];

// ---------------------------------------------------------------------------
// The contract, restated independently as "must NOT appear in output" detectors.
// ---------------------------------------------------------------------------

/** A raw ESC (0x1b) — the introducer for every terminal control sequence. Never allowed. */
const RAW_ESC = /\u001b/;

/**
 * A forbidden control character: any C0 EXCEPT the two the sanitizer documents as content
 * (`\t` = 0x09, `\n` = 0x0a), plus DEL (0x7f) and every C1 control (0x80-0x9f). `\r` (0x0d) is
 * inside 0x0b-0x1f, so a lone CR is forbidden too.
 */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** Deceptive Unicode: bidi overrides, zero-width chars, alternate line separators, soft hyphen. */
const DECEPTIVE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u00ad\u2028\u2029\ufeff]/;

/** Bare C1 range (0x80-0x9f) — some of these are sequence introducers on their own (CSI/OSC/DCS). */
const C1_INTRODUCER = /[\u0080-\u009f]/;

/**
 * An ACTIVE ESC-introduced control sequence — a mirror of `sanitize.ts`'s `ANSI_SEQUENCE`, used to
 * assert no active sequence survives in the output. (Since it requires an ESC to match, and we also
 * assert no ESC survives, this is a belt-and-braces restatement of "no active sequence remains".)
 */
const ACTIVE_SEQUENCE = new RegExp(
  `(?:\\u001b\\[[0-?]*[ -/]*[@-~]` +
    `|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\|$)` +
    `|\\u001b[P^_X][\\s\\S]*?(?:\\u001b\\\\|$)` +
    `|\\u001b[@-Z\\\\-_])`,
);

/** All invariants that must hold for the sanitized text of EVERY input. */
function assertInvariants(text: string, opts: SanitizeOptions): void {
  expect(typeof text, 'result must be a string (SafeText)').toBe('string');
  expect(RAW_ESC.test(text), 'raw ESC survived').toBe(false);
  expect(FORBIDDEN_CONTROL.test(text), 'a forbidden control character survived').toBe(false);
  expect(C1_INTRODUCER.test(text), 'a C1 control introducer survived').toBe(false);
  expect(DECEPTIVE.test(text), 'a deceptive Unicode character survived').toBe(false);
  expect(ACTIVE_SEQUENCE.test(text), 'an active terminal control sequence survived').toBe(false);
  if (opts.multiline === false) {
    expect(text.includes('\n'), 'a newline survived a single-line origin').toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Generators. Each token is a distinct hazard class; inputs interleave several.
// ---------------------------------------------------------------------------

const smallText = fc.string({ unit: 'binary', maxLength: 12 }); // arbitrary unicode incl. astral
const params = fc
  .array(fc.constantFrom(...'0123456789;?'.split('')), { maxLength: 6 })
  .map((a) => a.join(''));

/** ESC [ ... final — CSI: cursor movement, colour, screen clear. */
const csi = fc
  .tuple(
    params,
    fc.constantFrom('m', 'J', 'H', 'K', 'A', 'B', 'C', 'D', 'n', 'h', 'l', 'r', 's', 'u'),
  )
  .map(([p, final]) => `${ESC}[${p}${final}`);

/** ESC ] code ; payload BEL|ST — OSC: title, hyperlink, clipboard. */
const oscGeneric = fc
  .tuple(
    fc.constantFrom('0', '1', '2', '8', '52', '133', '1337'),
    smallText,
    fc.constantFrom(BEL, ST),
  )
  .map(([code, payload, term]) => `${ESC}]${code};${payload}${term}`);

/** OSC 52 — silent clipboard write with a base64 blob. */
const osc52 = fc
  .tuple(fc.base64String({ maxLength: 40 }), fc.constantFrom(BEL, ST))
  .map(([blob, term]) => `${ESC}]52;c;${blob}${term}`);

/** OSC 8 — a hyperlink whose visible label can lie about its target. */
const osc8 = fc
  .tuple(
    fc.oneof(fc.webUrl(), fc.constant('javascript:alert(1)'), fc.constant('http://evil.example')),
    smallText,
    fc.constantFrom(BEL, ST),
  )
  .map(([url, label, term]) => `${ESC}]8;;${url}${term}${label}${ESC}]8;;${term}`);

/** ESC P|X|^|_ ... ST — DCS / SOS / PM / APC device-control strings. */
const dcs = fc
  .tuple(fc.constantFrom('P', 'X', '^', '_'), smallText)
  .map(([intro, payload]) => `${ESC}${intro}${payload}${ST}`);

/** ESC <char> two-character escapes (some matched by the sequence regex, some not). */
const twoChar = fc
  .constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ\\]^_@=>78cDEM'.split(''))
  .map((c) => `${ESC}${c}`);

/** Bare C0 control characters (excluding \t and \n, which are content) — includes bare ESC/BEL. */
const c0 = fc
  .integer({ min: 0, max: 0x1f })
  .filter((n) => n !== 0x09 && n !== 0x0a)
  .map((n) => String.fromCharCode(n));

/** Bare C1 controls (0x80-0x9f) — some are sequence introducers on their own. */
const c1 = fc.integer({ min: 0x80, max: 0x9f }).map((n) => String.fromCharCode(n));

const del = fc.constant('\u007f');
const cr = fc.constantFrom('\r', '\r\n');

/** Bidi / RTL overrides (Trojan Source). */
const bidi = fc.constantFrom(
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
);
/** Zero-width / invisible characters used to hide payloads. */
const zeroWidth = fc.constantFrom(
  '\u200b',
  '\u200c',
  '\u200d',
  '\u200e',
  '\u200f',
  '\u2060',
  '\ufeff',
  '\u00ad',
);
/** Alternate line separators some terminals treat as newlines. */
const lineSep = fc.constantFrom('\u2028', '\u2029');

/** Benign content, including the two characters that are allowed through. */
const benign = fc.oneof(
  smallText,
  fc.constant('\n'),
  fc.constant('\t'),
  fc.constant('ordinary text 123 你好 🎉'),
);

/** One token from any hazard class (six of these carry an ESC). */
const token = fc.oneof(
  csi,
  oscGeneric,
  osc52,
  osc8,
  dcs,
  twoChar,
  c0,
  c1,
  del,
  cr,
  bidi,
  zeroWidth,
  lineSep,
  benign,
);

/** A fuzzed input: one or more interleaved hazard tokens. */
const hazardousInput = fc
  .array(token, { minLength: 1, maxLength: 10 })
  .map((parts) => parts.join(''));

/** Options across all origins and both multiline / maxLength dimensions. */
const anyOptions = fc.record({
  origin: fc.constantFrom(...ORIGINS),
  multiline: fc.option(fc.boolean(), { nil: undefined }),
  maxLength: fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
});

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

describe('sanitize is safe for arbitrary untrusted input (TL-11, TL-14) [P]', () => {
  it('neutralizes EVERY input to SafeText across every origin and option combo', () => {
    fc.assert(
      fc.property(hazardousInput, anyOptions, (raw, opts) => {
        const result = sanitize(raw, opts);
        assertInvariants(result.text as string, opts);
        // Provenance is carried through unchanged; options never relax the invariants above.
        expect(result.origin).toBe(opts.origin);
      }),
      { numRuns: 500 },
    );
  });

  it('is IDEMPOTENT: sanitize(sanitize(x)) === sanitize(x) (no partial-strip)', () => {
    // The core stripping must reach a fixed point in one pass. Truncation is deliberately NOT
    // idempotent (it re-appends a marker), so gate on the truncation flag rather than pretend.
    fc.assert(
      fc.property(hazardousInput, anyOptions, (raw, opts) => {
        const once = sanitize(raw, opts);
        if (once.truncated) return; // truncation is announced re-marking, not a fixed point
        const twice = sanitize(once.text, opts);
        expect(twice.text as string).toBe(once.text as string);
        // A second pass over already-safe text must find nothing to strip.
        expect(twice.strippedControlSequences).toBe(0);
        expect(twice.modified).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('an ESC-introduced OSC/DCS payload never survives as an active sequence', () => {
    // For ESC-introduced sequences the WHOLE sequence (payload included) is stripped, so a marker
    // buried inside the sequence must be gone — not merely defanged of its ESC.
    const marker = 'MARKER_c2VjcmV0_payload';
    const builders = fc.constantFrom<(p: string) => string>(
      (p) => `${ESC}]52;c;${p}${BEL}`, // OSC 52 clipboard blob
      (p) => `${ESC}]8;;http://evil/${p}${BEL}label${ESC}]8;;${BEL}`, // OSC 8 target
      (p) => `${ESC}]0;${p}${BEL}`, // OSC 0 title
      (p) => `${ESC}P${p}${ST}`, // DCS payload
    );
    fc.assert(
      fc.property(builders, smallText, anyOptions, (build, noise, opts) => {
        const result = sanitize(build(marker) + noise, opts);
        const text = result.text as string;
        assertInvariants(text, opts);
        // The noise is unrelated; only assert marker-absence when the noise didn't reintroduce it.
        if (!noise.includes(marker)) {
          expect(text.includes(marker), 'sequence payload survived as literal text').toBe(false);
        }
        expect(result.modified, 'an escape sequence was not detected as a modification').toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('non-vacuity: the generator really produces hazards [P]', () => {
  it('a meaningful fraction of generated inputs carry escapes / controls / deceptive chars', () => {
    const N = 1000;
    const samples = fc.sample(hazardousInput, N);
    let esc = 0;
    let control = 0;
    let deceptive = 0;
    let c1Bytes = 0;
    for (const s of samples) {
      if (RAW_ESC.test(s)) esc++;
      if (FORBIDDEN_CONTROL.test(s)) control++;
      if (DECEPTIVE.test(s)) deceptive++;
      if (C1_INTRODUCER.test(s)) c1Bytes++;
    }
    // Reported so the non-vacuity evidence is auditable, not merely asserted.
    console.log(
      `[non-vacuity/${N}] rawESC=${esc} forbiddenControl=${control} deceptive=${deceptive} c1=${c1Bytes}`,
    );
    // If these dropped to ~0, "no escape survives" would be vacuously true on benign input.
    expect(esc, 'generator rarely produced a raw ESC').toBeGreaterThan(300);
    expect(control, 'generator rarely produced a control character').toBeGreaterThan(300);
    expect(deceptive, 'generator rarely produced a deceptive character').toBeGreaterThan(150);
    expect(c1Bytes, 'generator rarely produced a C1 byte').toBeGreaterThan(100);
  });
});

describe('isSafeLinkTarget admits only http/https/mailto (TL-13, TL-14) [P]', () => {
  it('accepts arbitrary well-formed http(s) URLs', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        expect(isSafeLinkTarget(url)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('accepts arbitrary mailto: targets', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        expect(isSafeLinkTarget(`mailto:${email}`)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects every non-http/https/mailto scheme', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'javascript',
          'data',
          'file',
          'vbscript',
          'ftp',
          'ws',
          'wss',
          'gopher',
          'tel',
          'about',
        ),
        fc.string({ maxLength: 40 }),
        (scheme, body) => {
          expect(isSafeLinkTarget(`${scheme}:${body}`)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never admits a target whose parsed protocol is not in the allow-set', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (s) => {
        if (isSafeLinkTarget(s)) {
          const protocol = new URL(s).protocol;
          expect(['http:', 'https:', 'mailto:']).toContain(protocol);
        }
      }),
      { numRuns: 500 },
    );
  });
});
