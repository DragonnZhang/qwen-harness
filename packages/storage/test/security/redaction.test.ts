import { describe, expect, it } from 'vitest';

import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import {
  CANARY_API_KEY,
  CANARY_AWS_KEY,
  CANARY_GITHUB_TOKEN,
  CANARY_PRIVATE_KEY,
  ManualClock,
  SequentialIds,
  USER_ACTOR,
} from '@qwen-harness/testkit';

import { EventStore, REDACTED, createRedactor, exportJsonl } from '../../src/index.ts';

/**
 * Canaries look exactly like real credentials but are not, and are assembled at runtime so that
 * no source file contains a literal that `pnpm secrets:scan` would (correctly) flag. See
 * `packages/testkit/src/canaries.ts` — we keep the scanner strict rather than allowlisting.
 */
const CANARY = CANARY_API_KEY;

describe('Redactor: pattern-based scrubbing', () => {
  const r = createRedactor();

  it.each([
    ['dashscope-style key', `key is ${CANARY} ok`],
    ['github token', `token ${CANARY_GITHUB_TOKEN}`],
    ['aws access key', `id ${CANARY_AWS_KEY} here`],
    ['bearer header', 'Authorization: Bearer abcdefghijklmnop0123456789'],
  ])('scrubs a %s', (_label, input) => {
    const out = r.redact(input);
    expect(out).toContain(REDACTED);
    // Nothing that looked like credential material survives.
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|ghp_\w{20,}|AKIA[0-9A-Z]{16}/);
  });

  it('scrubs credentials embedded in a URL', () => {
    expect(r.redact('https://user:hunter2@example.com/x')).toBe(
      `https://${REDACTED}@example.com/x`,
    );
    expect(r.redact('https://api.example.com/v1?api_key=supersecretvalue123&z=1')).toBe(
      `https://api.example.com/v1?api_key=${REDACTED}&z=1`,
    );
  });

  it('scrubs a private key block', () => {
    expect(r.redact(`here: ${CANARY_PRIVATE_KEY}`)).toBe(`here: ${REDACTED}`);
  });

  it('redacts a field by NAME even when its value looks innocuous', () => {
    // A value like "abc" matches no pattern — but a field called `authorization` is still secret.
    const out = r.redactValue({ authorization: 'abc', api_key: 'x1', harmless: 'abc' });
    expect(out).toEqual({ authorization: REDACTED, api_key: REDACTED, harmless: 'abc' });
  });
});

describe('Redactor: the LIVE key value and its encodings (PV-12)', () => {
  const r = createRedactor([CANARY]);

  it('scrubs the exact value', () => {
    expect(r.redact(`prefix ${CANARY} suffix`)).toBe(`prefix ${REDACTED} suffix`);
  });

  it('scrubs base64, base64url, and percent-encoded forms', () => {
    // A key can leak in a shape no regex anticipates — base64'd into a header dump, or
    // percent-encoded into a URL. Scrubbing the literal value's ENCODINGS catches those.
    const b64 = Buffer.from(CANARY, 'utf8').toString('base64');
    const b64url = Buffer.from(CANARY, 'utf8').toString('base64url');
    const pct = encodeURIComponent(CANARY);
    const bearerB64 = Buffer.from(`Bearer ${CANARY}`, 'utf8').toString('base64');

    for (const encoded of [b64, b64url, pct, bearerB64]) {
      const out = r.redact(`leaked: ${encoded}`);
      expect(out, `encoding ${encoded.slice(0, 12)}... survived`).toContain(REDACTED);
      expect(out).not.toContain(encoded);
    }
  });

  it('scrubs the key nested deep inside an object graph', () => {
    const out = r.redactValue({
      request: { headers: { 'x-custom': `Bearer ${CANARY}` }, body: [{ note: CANARY }] },
    });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
});

describe('redaction happens BEFORE persistence, not before logging', () => {
  it('a secret in an event payload never reaches SQLite or the JSONL export', () => {
    const store = new EventStore({
      path: ':memory:',
      clock: new ManualClock(1_700_000_000_000),
      ids: new SequentialIds(),
      secrets: [CANARY],
    });

    const threadId = 'thr_000001' as ThreadId;
    store.append({
      threadId,
      correlationId: 'cor_000001' as CorrelationId,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
    // A hostile/careless payload carrying the key straight into the log.
    store.append({
      threadId,
      correlationId: 'cor_000001' as CorrelationId,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: {
        type: 'model-request-failed',
        requestId: 'req-1',
        category: 'provider.auth',
        retryable: false,
        message: `401 using Authorization: Bearer ${CANARY}`,
      },
    });

    // 1. Not in the database.
    const rows = store.db.prepare('SELECT payload FROM events').all() as { payload: string }[];
    const raw = rows.map((r) => r.payload).join('\n');
    expect(raw).not.toContain(CANARY);
    expect(raw).toContain(REDACTED);

    // 2. Therefore not in the export either — because the export serializes what was stored.
    // This is the point of redacting at the storage boundary rather than at the log boundary:
    // every downstream artifact is clean by construction.
    const jsonl = exportJsonl(store, { exportedAt: 0 });
    expect(jsonl).not.toContain(CANARY);
  });
});
