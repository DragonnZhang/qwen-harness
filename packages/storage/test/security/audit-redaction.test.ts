import { CANARY_API_KEY, SequentialIds, SYSTEM_ACTOR } from '@qwen-harness/testkit';
import { ManualClock } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { EventStore } from '../../src/index.ts';

/**
 * The audit trail never persists a secret, even inside an error (SC-03, S).
 *
 * A provider error can carry a credential (in a URL, a header echo, a message). The store is
 * constructed with the credential value precisely so it scrubs it out of ANYTHING it persists — so the
 * durable audit an operator later reads is free of the secret, in every field, however it was embedded.
 */

const THREAD = 'thr_000001';
const CORR = 'cor_000001';

describe('audit records redact secrets, including in errors (SC-03, S)', () => {
  it('a provider error that leaked the credential is scrubbed in the durable audit', () => {
    const store = new EventStore({
      path: ':memory:',
      clock: new ManualClock(1),
      ids: new SequentialIds(),
      secrets: [CANARY_API_KEY],
    });
    try {
      store.append({
        threadId: THREAD,
        correlationId: CORR,
        permissionProfile: 'ask',
        actor: SYSTEM_ACTOR,
        payload: { type: 'thread-created', cwd: '/repo', canonicalRepo: null, name: null },
      });

      // A retryable failure whose message AND request id both echo the credential.
      store.append({
        threadId: THREAD,
        correlationId: CORR,
        permissionProfile: 'ask',
        actor: SYSTEM_ACTOR,
        payload: {
          type: 'model-request-failed',
          requestId: `req-${CANARY_API_KEY}`,
          category: 'auth',
          retryable: false,
          message: `401 from https://api.example/v1?key=${CANARY_API_KEY} — check your key`,
        },
      });

      // Read the durable audit exactly as an operator or `export` would, and prove the secret is gone.
      const serialized = JSON.stringify(store.readAll());
      expect(serialized).not.toContain(CANARY_API_KEY);
      // The failure IS still there — redaction removes the secret, not the audit record.
      expect(serialized).toContain('model-request-failed');
      expect(serialized).toContain('check your key');
    } finally {
      store.close();
    }
  });
});
