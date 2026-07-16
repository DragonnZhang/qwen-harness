import { CANARY_API_KEY } from '@qwen-harness/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createRedactor } from './redaction.ts';

/**
 * Audit redaction is total (SC-03, P).
 *
 * Whatever surrounds it and wherever it is nested — a message, a URL, an array, a deep object — the
 * credential never survives `redactValue`. This is the property the audit trail relies on: an operator
 * reading any persisted record can never recover the secret from it.
 */

describe('the credential never survives redaction, however it is embedded (SC-03, P)', () => {
  const redactor = createRedactor([CANARY_API_KEY]);

  it('scrubs the credential from any string, in any position, at any depth', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (prefix, suffix) => {
        const record = {
          message: `${prefix}${CANARY_API_KEY}${suffix}`,
          request: { url: `https://api.example/v1?key=${CANARY_API_KEY}&x=1` },
          headers: { Authorization: `Bearer ${CANARY_API_KEY}` },
          trace: [`${prefix}${CANARY_API_KEY}`, { note: `${CANARY_API_KEY}${suffix}` }],
        };
        const redacted = redactor.redactValue(record);
        expect(JSON.stringify(redacted)).not.toContain(CANARY_API_KEY);
      }),
      { numRuns: 400 },
    );
  });
});
