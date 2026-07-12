import { describe, expect, it } from 'vitest';

import {
  classifyHttpError,
  lookupRule,
  parseErrorBody,
  parseRetryAfterHeader,
  ruleForStatus,
} from './errors.ts';
import { redact, safeProviderMessage } from './redact.ts';

describe('parseErrorBody', () => {
  it('reads the OpenAI-compatible shape (nested error object)', () => {
    expect(
      parseErrorBody(
        JSON.stringify({
          error: { message: 'nope', type: 'invalid_request_error', code: 'model_not_found' },
          request_id: 'req-1',
        }),
      ),
    ).toEqual({ code: 'model_not_found', message: 'nope', requestId: 'req-1', retryAfterMs: null });
  });

  it('reads the DashScope-native shape (top-level code)', () => {
    expect(
      parseErrorBody(
        JSON.stringify({
          request_id: 'req-2',
          code: 'InvalidParameter',
          message: 'Currently not support background.',
        }),
      ),
    ).toEqual({
      code: 'InvalidParameter',
      message: 'Currently not support background.',
      requestId: 'req-2',
      retryAfterMs: null,
    });
  });

  it('falls back to `type` when there is no `code`', () => {
    expect(parseErrorBody(JSON.stringify({ error: { type: 'insufficient_quota' } })).code).toBe(
      'insufficient_quota',
    );
  });

  it('never throws on a malformed body — an unparseable error must stay diagnosable', () => {
    expect(parseErrorBody('<html>502 Bad Gateway</html>')).toEqual({
      code: null,
      message: null,
      requestId: null,
      retryAfterMs: null,
    });
    expect(parseErrorBody('null').code).toBeNull();
    expect(parseErrorBody('[1,2,3]').code).toBeNull();
  });

  it('reads a body-supplied retry hint in seconds or milliseconds', () => {
    expect(parseErrorBody(JSON.stringify({ code: 'x', retry_after: 12 })).retryAfterMs).toBe(
      12_000,
    );
    expect(parseErrorBody(JSON.stringify({ code: 'x', retry_after_ms: 900 })).retryAfterMs).toBe(
      900,
    );
  });
});

describe('lookupRule', () => {
  it('is case-insensitive', () => {
    expect(lookupRule('THROTTLING')?.category).toBe('provider.rate_limit.throttling');
  });

  it('resolves a dotted code to its MOST specific rule, not to its prefix', () => {
    // The trap: `Throttling.AllocationQuota` starts with `Throttling`, which is retryable. It is
    // NOT retryable. A prefix match here would retry an exhausted allocation ten times.
    expect(lookupRule('Throttling.AllocationQuota')?.errorClass).toBe('hint-gated');
    expect(lookupRule('Throttling.RateQuota')?.errorClass).toBe('retryable');
    expect(lookupRule('Throttling')?.errorClass).toBe('retryable');
  });

  it('returns undefined for an unknown code so the status fallback decides', () => {
    expect(lookupRule('CompletelyNewCode')).toBeUndefined();
  });
});

describe('ruleForStatus', () => {
  it('defaults an unrecognized 429 to user-action-required, NOT retryable', () => {
    expect(ruleForStatus(429)).toEqual({
      category: 'provider.rate_limit.unrecognized',
      errorClass: 'user-action-required',
    });
  });

  it('treats 5xx as transient', () => {
    expect(ruleForStatus(500).errorClass).toBe('retryable');
    expect(ruleForStatus(502).errorClass).toBe('retryable');
    expect(ruleForStatus(599).errorClass).toBe('retryable');
  });

  it('treats auth and model errors as needing a human', () => {
    expect(ruleForStatus(401).errorClass).toBe('user-action-required');
    expect(ruleForStatus(403).errorClass).toBe('user-action-required');
    expect(ruleForStatus(404).errorClass).toBe('user-action-required');
  });
});

describe('parseRetryAfterHeader', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterHeader('30', 0)).toBe(30_000);
    expect(parseRetryAfterHeader('0', 0)).toBe(0);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('Sun, 12 Jul 2026 10:00:00 GMT');
    expect(parseRetryAfterHeader('Sun, 12 Jul 2026 10:00:45 GMT', now)).toBe(45_000);
    // A date already in the past is a hint of zero, never a negative delay.
    expect(parseRetryAfterHeader('Sun, 12 Jul 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('returns null for an absent or nonsense value', () => {
    expect(parseRetryAfterHeader(null, 0)).toBeNull();
    expect(parseRetryAfterHeader('soon', 0)).toBeNull();
  });
});

describe('classifyHttpError', () => {
  const base = {
    headerRequestId: null,
    headerRetryAfterMs: null,
    visibleOutputEmitted: false,
  };

  it('gates AllocationQuota on window evidence, in both directions', () => {
    const withoutHint = classifyHttpError({
      ...base,
      status: 429,
      body: { code: 'AllocationQuota', message: 'x', requestId: null, retryAfterMs: null },
    });
    expect(withoutHint.retryable).toBe(false);
    expect(withoutHint.userActionRequired).toBe(true);

    const withHint = classifyHttpError({
      ...base,
      status: 429,
      body: { code: 'AllocationQuota', message: 'x', requestId: null, retryAfterMs: 60_000 },
    });
    expect(withHint.retryable).toBe(true);
    expect(withHint.userActionRequired).toBe(false);
    expect(withHint.retryAfterMs).toBe(60_000);
  });

  it('prefers a body request ID over the header, and falls back to the header', () => {
    const fromBody = classifyHttpError({
      ...base,
      status: 500,
      headerRequestId: 'header-id',
      body: { code: null, message: null, requestId: 'body-id', retryAfterMs: null },
    });
    expect(fromBody.requestId).toBe('body-id');

    const fromHeader = classifyHttpError({
      ...base,
      status: 500,
      headerRequestId: 'header-id',
      body: { code: null, message: null, requestId: null, retryAfterMs: null },
    });
    expect(fromHeader.requestId).toBe('header-id');
  });

  it('marks visibleOutputEmitted so canRetryTransparently() refuses (PV-11)', () => {
    const error = classifyHttpError({
      ...base,
      status: 500,
      visibleOutputEmitted: true,
      body: { code: null, message: null, requestId: null, retryAfterMs: null },
    });
    expect(error.retryable).toBe(true);
    expect(error.canRetryTransparently()).toBe(false);
  });

  it('records the side effect as not-started: a failed model call ran no tool', () => {
    const error = classifyHttpError({
      ...base,
      status: 500,
      body: { code: null, message: null, requestId: null, retryAfterMs: null },
    });
    expect(error.sideEffectCertainty).toBe('not-started');
  });
});

describe('redaction (PV-12)', () => {
  // Assembled at runtime rather than written as a literal: `scripts/secret-scan.ts` scans the
  // working tree for `sk-…` and must not have to special-case a test file. A fixture that looks
  // exactly like a real credential is precisely what the scanner exists to catch.
  const looksLikeKey = `sk-${'1234567890abcdef'}`;

  it('scrubs an API key a server echoed back', () => {
    expect(redact(`Incorrect API key provided: ${looksLikeKey}.`)).toBe(
      'Incorrect API key provided: [REDACTED].',
    );
    expect(redact(`Incorrect API key provided: ${looksLikeKey}.`)).not.toContain('1234567890');
  });

  it('scrubs a bearer token', () => {
    const header = `header was Authorization: Bearer ${looksLikeKey}`;
    expect(redact(header)).toContain('[REDACTED]');
    expect(redact(header)).not.toContain('1234567890');
  });

  it('neutralizes control characters so a provider string cannot rewrite a terminal line', () => {
    expect(safeProviderMessage('bad\u001b[2Kmessage\u0007')).toBe('bad [2Kmessage ');
  });

  it('bounds the length so an error body cannot become a log flood', () => {
    expect(safeProviderMessage('x'.repeat(5000))).toHaveLength(500 + '…[truncated]'.length);
  });
});
