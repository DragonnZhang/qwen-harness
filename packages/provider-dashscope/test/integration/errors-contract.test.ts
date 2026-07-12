import { describe, expect, it } from 'vitest';

import { HarnessError } from '@qwen-harness/protocol';
import { DEFAULT_RETRY_POLICY, decideRetry } from '@qwen-harness/provider-core';

import { DashScopeProvider, type CredentialSource } from '../../src/index.ts';
import { drain, errorFixtures, fakeFetch } from './replay.ts';

/**
 * Table-driven error contract, replaying the REAL captured error bodies from checkpoint 0 plus the
 * documented DashScope classes we could not provoke safely against a live account (arrears, quota,
 * throttling — deliberately not triggered on someone's real bill).
 *
 * Every row asserts the full behavioral tuple, not just a category string: the whole point of the
 * classification is what the runtime is then ALLOWED to do.
 */

const key: CredentialSource = { description: 'test', read: () => 'sk-test-key-value' };

const request = {
  model: 'qwen3.7-max',
  instructions: '',
  input: [{ type: 'message' as const, role: 'user' as const, text: 'hi' }],
  tools: [],
};

async function failWith(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchImpl = fakeFetch({ status, json: body, headers });
  const provider = new DashScopeProvider({ credentials: key, fetchImpl });
  const { events, thrown } = await drain(provider.stream(request));
  return { events, thrown, error: thrown as HarnessError };
}

/** DashScope's native error body shape (top-level `code`). */
const dashscope = (code: string, message = 'x') => ({
  request_id: 'req-fixture-1',
  code,
  message,
});

interface Row {
  readonly name: string;
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  readonly category: string;
  readonly retryable: boolean;
  readonly userActionRequired: boolean;
}

const captured = errorFixtures();

const ROWS: readonly Row[] = [
  // --- straight from fixtures/provider/dashscope/errors.json ----------------------------------
  {
    name: 'captured: model_not_found (404)',
    status: captured['model_not_found']!.http,
    body: captured['model_not_found']!.body,
    category: 'provider.request.model_not_found',
    retryable: false,
    userActionRequired: true,
  },
  {
    name: 'captured: invalid_api_key (401)',
    status: captured['invalid_api_key']!.http,
    body: captured['invalid_api_key']!.body,
    category: 'provider.auth.invalid_key',
    retryable: false,
    userActionRequired: true,
  },
  {
    name: 'captured: InvalidParameter — background unsupported (400)',
    status: captured['background_unsupported']!.http,
    body: captured['background_unsupported']!.body,
    category: 'provider.request.invalid_parameter',
    retryable: false,
    // Nobody can pay or configure their way out of a parameter the endpoint does not have.
    userActionRequired: false,
  },

  // --- retryable ------------------------------------------------------------------------------
  {
    name: 'Throttling (429)',
    status: 429,
    body: dashscope('Throttling'),
    category: 'provider.rate_limit.throttling',
    retryable: true,
    userActionRequired: false,
  },
  {
    name: 'Throttling.RateQuota (429)',
    status: 429,
    body: dashscope('Throttling.RateQuota'),
    category: 'provider.rate_limit.rate_quota',
    retryable: true,
    userActionRequired: false,
  },
  {
    name: 'Throttling.BurstRate (429)',
    status: 429,
    body: dashscope('Throttling.BurstRate'),
    category: 'provider.rate_limit.burst_rate',
    retryable: true,
    userActionRequired: false,
  },
  {
    name: '500 with no code',
    status: 500,
    body: { request_id: 'req-fixture-1' },
    category: 'provider.transient.server_error',
    retryable: true,
    userActionRequired: false,
  },
  {
    name: '503 with no code',
    status: 503,
    body: {},
    category: 'provider.transient.server_error',
    retryable: true,
    userActionRequired: false,
  },

  // --- hint-gated -----------------------------------------------------------------------------
  {
    name: 'AllocationQuota with NO hint -> user action, not retry',
    status: 429,
    body: dashscope('Throttling.AllocationQuota'),
    category: 'provider.quota.allocation',
    retryable: false,
    userActionRequired: true,
  },
  {
    name: 'AllocationQuota WITH a Retry-After header -> retryable',
    status: 429,
    body: dashscope('Throttling.AllocationQuota'),
    headers: { 'retry-after': '30' },
    category: 'provider.quota.allocation',
    retryable: true,
    userActionRequired: false,
  },
  {
    name: 'insufficient_quota with NO hint -> user action',
    status: 429,
    body: { error: { code: 'insufficient_quota', message: 'out of quota' } },
    category: 'provider.quota.insufficient',
    retryable: false,
    userActionRequired: true,
  },
  {
    name: 'insufficient_quota with a body retry_after -> retryable',
    status: 429,
    body: { error: { code: 'insufficient_quota', message: 'x', retry_after: 12 } },
    category: 'provider.quota.insufficient',
    retryable: true,
    userActionRequired: false,
  },

  // --- never retry ----------------------------------------------------------------------------
  {
    name: 'CommodityNotPurchased',
    status: 403,
    body: dashscope('CommodityNotPurchased'),
    category: 'provider.billing.not_purchased',
    retryable: false,
    userActionRequired: true,
  },
  {
    name: 'PrepaidBillOverdue',
    status: 403,
    body: dashscope('PrepaidBillOverdue'),
    category: 'provider.billing.prepaid_overdue',
    retryable: false,
    userActionRequired: true,
  },
  {
    name: 'PostpaidBillOverdue',
    status: 403,
    body: dashscope('PostpaidBillOverdue'),
    category: 'provider.billing.postpaid_overdue',
    retryable: false,
    userActionRequired: true,
  },

  // --- the unrecognized 429 default ------------------------------------------------------------
  {
    name: 'unrecognized 429 defaults to user-action-required, NOT retryable',
    status: 429,
    body: dashscope('SomeBrandNewThrottleCodeWeHaveNeverSeen'),
    category: 'provider.rate_limit.unrecognized',
    retryable: false,
    userActionRequired: true,
  },
  {
    name: 'bare 429 with no body at all',
    status: 429,
    body: {},
    category: 'provider.rate_limit.unrecognized',
    retryable: false,
    userActionRequired: true,
  },
];

describe('error classification table (PV-10)', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const { error, events } = await failWith(row.status, row.body, row.headers ?? {});

      expect(error).toBeInstanceOf(HarnessError);
      expect(error.category).toBe(row.category);
      expect(error.retryable).toBe(row.retryable);
      expect(error.userActionRequired).toBe(row.userActionRequired);
      expect(error.origin).toBe('provider');

      // The failure is BOTH an event and a throw; a consumer cannot accidentally ignore it.
      const emitted = events.filter((e) => e.type === 'error');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.error).toBe(error);
      expect(events.some((e) => e.type === 'done')).toBe(false);

      // Only a genuinely retryable class may reach the backoff at all.
      const decision = decideRetry(error, { attempt: 1, elapsedMs: 0 }, () => 0.5);
      expect(decision.retry).toBe(row.retryable);
    });
  }

  it('preserves the request ID from the body', async () => {
    const { error } = await failWith(404, captured['model_not_found']!.body);
    expect(error.requestId).toBe('<REDACTED-REQUEST-ID>');
  });

  it('preserves the request ID from the x-request-id header when the body has none', async () => {
    const { error } = await failWith(500, {}, { 'x-request-id': 'req-header-only' });
    expect(error.requestId).toBe('req-header-only');
  });

  it('converts a Retry-After header into a retry hint the policy honors', async () => {
    const { error } = await failWith(429, dashscope('Throttling'), { 'retry-after': '7' });
    expect(error.retryAfterMs).toBe(7000);
    expect(
      decideRetry(error, { attempt: 1, elapsedMs: 0 }, () => 0.5, DEFAULT_RETRY_POLICY),
    ).toEqual({ retry: true, delayMs: 7000 });
  });

  it('never leaks an API key that a server echoed back into an error message', async () => {
    const { error } = await failWith(401, {
      error: {
        code: 'invalid_api_key',
        message: 'Incorrect API key provided: sk-abcdef0123456789.',
      },
    });
    expect(error.message).not.toContain('sk-abcdef0123456789');
    expect(error.message).toContain('[REDACTED]');
  });

  it('a transport failure is retryable and carries no vendor object', async () => {
    const fetchImpl = Object.assign(
      () => Promise.reject(new TypeError('fetch failed: ECONNRESET')),
      { calls: [] },
    );
    const provider = new DashScopeProvider({ credentials: key, fetchImpl });
    const { thrown } = await drain(provider.stream(request));
    const error = thrown as HarnessError;
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.origin).toBe('network');
    expect(error.retryable).toBe(true);
    expect(error.canRetryTransparently()).toBe(true);
  });
});
