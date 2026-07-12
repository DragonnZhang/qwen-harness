import { HarnessError, harnessError, type SideEffectCertainty } from '@qwen-harness/protocol';

import { safeProviderMessage } from './redact.ts';

/**
 * Error classification (PV-10 / requirements 10 and 11).
 *
 * Classification is keyed on HTTP status PLUS provider code, never on either alone. The reason is
 * concrete: DashScope returns 429 for at least three different situations that need three
 * different behaviors — a burst that will clear in a second, an allocation quota that will clear
 * when a window rolls over, and an arrears state that will never clear without a human. Retrying
 * all three because "429 means slow down" burns the 5-minute budget on a bill that is unpaid.
 *
 * The four behavior classes:
 *
 *  - `retryable`             transient; back off and try again
 *  - `hint-gated`            retry ONLY with explicit window evidence (a server retry hint);
 *                            with no evidence it is indistinguishable from a permanent quota wall,
 *                            so it degrades to user-action-required rather than to blind retry
 *  - `user-action-required`  a human must do something (pay, fix the key, fix the model name)
 *  - `permanent`            will never succeed as sent, and no user action helps (a client bug)
 */
export type ErrorClass = 'retryable' | 'hint-gated' | 'user-action-required' | 'permanent';

export interface ErrorRule {
  /** Stable machine-readable category. Runtime branches on this, never on the message. */
  readonly category: string;
  readonly errorClass: ErrorClass;
}

/**
 * Keyed by lower-cased provider code. Both the DashScope native codes (`Throttling.RateQuota`) and
 * the OpenAI-compatible codes (`insufficient_quota`) appear, because the compatible-mode endpoint
 * returns BOTH body shapes depending on which layer rejected the request — the captured fixture
 * shows an OpenAI-shaped `error.code` for 401/404 and a DashScope-shaped top-level `code` for the
 * `background` rejection.
 */
export const ERROR_TABLE: ReadonlyMap<string, ErrorRule> = new Map<string, ErrorRule>([
  // --- transient: the request was fine, the moment was not ------------------------------------
  ['throttling', { category: 'provider.rate_limit.throttling', errorClass: 'retryable' }],
  ['ratequota', { category: 'provider.rate_limit.rate_quota', errorClass: 'retryable' }],
  ['burstrate', { category: 'provider.rate_limit.burst_rate', errorClass: 'retryable' }],
  ['requesttimeout', { category: 'provider.transient.request_timeout', errorClass: 'retryable' }],
  [
    'serviceunavailable',
    { category: 'provider.transient.service_unavailable', errorClass: 'retryable' },
  ],
  ['internalerror', { category: 'provider.transient.internal_error', errorClass: 'retryable' }],
  ['systemerror', { category: 'provider.transient.internal_error', errorClass: 'retryable' }],
  ['rate_limit_exceeded', { category: 'provider.rate_limit.throttling', errorClass: 'retryable' }],

  // --- hint-gated: retry only on explicit window evidence ---------------------------------------
  ['allocationquota', { category: 'provider.quota.allocation', errorClass: 'hint-gated' }],
  ['insufficient_quota', { category: 'provider.quota.insufficient', errorClass: 'hint-gated' }],

  // --- a human must act -------------------------------------------------------------------------
  [
    'commoditynotpurchased',
    { category: 'provider.billing.not_purchased', errorClass: 'user-action-required' },
  ],
  [
    'prepaidbilloverdue',
    { category: 'provider.billing.prepaid_overdue', errorClass: 'user-action-required' },
  ],
  [
    'postpaidbilloverdue',
    { category: 'provider.billing.postpaid_overdue', errorClass: 'user-action-required' },
  ],
  [
    'invalid_api_key',
    { category: 'provider.auth.invalid_key', errorClass: 'user-action-required' },
  ],
  ['invalidapikey', { category: 'provider.auth.invalid_key', errorClass: 'user-action-required' }],
  [
    'model_not_found',
    { category: 'provider.request.model_not_found', errorClass: 'user-action-required' },
  ],
  [
    'modelnotfound',
    { category: 'provider.request.model_not_found', errorClass: 'user-action-required' },
  ],

  // --- permanent client fault: retrying and paying both change nothing --------------------------
  ['invalidparameter', { category: 'provider.request.invalid_parameter', errorClass: 'permanent' }],
  [
    'invalid_request_error',
    { category: 'provider.request.invalid_request', errorClass: 'permanent' },
  ],
]);

/**
 * A DashScope code may be dotted (`Throttling.RateQuota`, `Throttling.AllocationQuota`). Try the
 * whole code first, then the trailing segment — `Throttling.AllocationQuota` must resolve to the
 * hint-gated allocation rule, NOT to the plain retryable `Throttling` prefix, so the specific
 * lookup has to win.
 */
export function lookupRule(code: string): ErrorRule | undefined {
  const normalized = code.trim().toLowerCase();
  const exact = ERROR_TABLE.get(normalized);
  if (exact !== undefined) return exact;
  const lastSegment = normalized.split('.').pop();
  if (lastSegment !== undefined && lastSegment !== normalized) return ERROR_TABLE.get(lastSegment);
  return undefined;
}

/** Fall back to the HTTP status when the code is absent or unknown. */
export function ruleForStatus(status: number): ErrorRule {
  if (status === 401 || status === 403) {
    return { category: 'provider.auth.rejected', errorClass: 'user-action-required' };
  }
  if (status === 404) {
    return { category: 'provider.request.model_not_found', errorClass: 'user-action-required' };
  }
  // PV-10: an UNRECOGNIZED 429 defaults to user-action-required, not to retry. We cannot tell a
  // clearing burst from an unpaid bill, and guessing "retry" turns an arrears state into ten
  // pointless requests.
  if (status === 429) {
    return { category: 'provider.rate_limit.unrecognized', errorClass: 'user-action-required' };
  }
  if (status >= 500) {
    return { category: 'provider.transient.server_error', errorClass: 'retryable' };
  }
  if (status >= 400) {
    return { category: 'provider.request.invalid_request', errorClass: 'permanent' };
  }
  return { category: 'provider.unknown', errorClass: 'permanent' };
}

export interface ParsedErrorBody {
  readonly code: string | null;
  readonly message: string | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/**
 * Both error body shapes, in one parser. Hand-rolled rather than schema-validated on purpose: an
 * error body is the one payload we must never reject for being malformed, because rejecting it
 * would replace a diagnosable provider failure with an opaque parse failure.
 */
export function parseErrorBody(raw: string): ParsedErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: null, message: null, requestId: null, retryAfterMs: null };
  }
  const body = asRecord(parsed);
  if (body === null) return { code: null, message: null, requestId: null, retryAfterMs: null };

  const nested = asRecord(body['error']);
  const source = nested ?? body;

  return {
    code: asString(source['code']) ?? asString(source['type']),
    message: asString(source['message']),
    requestId: asString(body['request_id']) ?? asString(source['request_id']),
    retryAfterMs: retryHintFromBody(source),
  };
}

/**
 * "Window evidence" for a hint-gated class. A number of seconds/milliseconds the provider itself
 * named — never a duration we invented, because inventing one is exactly the blind retry the
 * contract forbids.
 */
function retryHintFromBody(source: UnknownRecord): number | null {
  const ms = asPositiveNumber(source['retry_after_ms']);
  if (ms !== null) return Math.trunc(ms);
  const seconds = asPositiveNumber(source['retry_after']);
  if (seconds !== null) return Math.trunc(seconds * 1000);
  return null;
}

/** `Retry-After` is either delta-seconds or an HTTP date (RFC 9110 §10.2.3). Support both. */
export function parseRetryAfterHeader(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

export interface ClassifyInput {
  readonly status: number;
  readonly body: ParsedErrorBody;
  /** From the `x-request-id` response header. */
  readonly headerRequestId: string | null;
  /** From the `Retry-After` response header, already converted to milliseconds. */
  readonly headerRetryAfterMs: number | null;
  /**
   * True when the turn already streamed text to the user. This alone forbids a transparent retry
   * (PV-11): a second stream appended to a half-written sentence is a corrupted transcript.
   */
  readonly visibleOutputEmitted: boolean;
  readonly sideEffectCertainty?: SideEffectCertainty;
}

export function classifyHttpError(input: ClassifyInput): HarnessError {
  const { status, body, visibleOutputEmitted } = input;
  const rule = (body.code !== null ? lookupRule(body.code) : undefined) ?? ruleForStatus(status);
  const retryAfterMs = body.retryAfterMs ?? input.headerRetryAfterMs;

  // The one place a class is decided by evidence rather than by the table: an allocation quota
  // with a named window is transient; without one it is a wall.
  const hintGatedRetryable = rule.errorClass === 'hint-gated' && retryAfterMs !== null;
  const retryable = rule.errorClass === 'retryable' || hintGatedRetryable;
  const userActionRequired =
    rule.errorClass === 'user-action-required' ||
    (rule.errorClass === 'hint-gated' && !hintGatedRetryable);

  const detail = body.message !== null ? safeProviderMessage(body.message) : 'no message supplied';
  const codeLabel = body.code ?? 'no-code';

  return harnessError({
    origin: 'provider',
    category: rule.category,
    message: `DashScope HTTP ${String(status)} (${codeLabel}): ${detail}`,
    retryable,
    userActionRequired,
    // A model call that failed with an HTTP status started no tool and mutated nothing.
    sideEffectCertainty: input.sideEffectCertainty ?? 'not-started',
    visibleOutputEmitted,
    requestId: body.requestId ?? input.headerRequestId,
    retryAfterMs,
  });
}

/**
 * A transport failure: connection reset, DNS, TLS, a socket that died mid-stream. Always transient
 * — but `visibleOutputEmitted` still decides whether a retry is legal, and for a stream that died
 * halfway it usually is not.
 */
export function classifyTransportError(
  cause: unknown,
  options: { readonly visibleOutputEmitted: boolean; readonly requestId: string | null },
): HarnessError {
  const detail = cause instanceof Error ? safeProviderMessage(cause.message) : 'transport failure';
  return harnessError(
    {
      origin: 'network',
      category: 'provider.network.transport',
      message: `DashScope request failed before completing: ${detail}`,
      retryable: true,
      userActionRequired: false,
      sideEffectCertainty: 'not-started',
      visibleOutputEmitted: options.visibleOutputEmitted,
      requestId: options.requestId,
      retryAfterMs: null,
    },
    { cause },
  );
}

/**
 * The server opened a 200 stream and then reported a failure inside it (`response.failed`, an
 * `error` frame). Same table, no HTTP status to fall back on — so an unrecognized code is treated
 * as permanent rather than retried on a guess.
 */
export function streamFailureError(options: {
  readonly code: string | null;
  readonly message: string;
  readonly requestId: string | null;
  readonly visibleOutputEmitted: boolean;
}): HarnessError {
  const rule = (options.code !== null ? lookupRule(options.code) : undefined) ?? {
    category: 'provider.stream.failed',
    errorClass: 'permanent' as const,
  };
  return harnessError({
    origin: 'provider',
    category: rule.category,
    message: `DashScope stream failed (${options.code ?? 'no-code'}): ${safeProviderMessage(options.message)}`,
    retryable: rule.errorClass === 'retryable',
    userActionRequired:
      rule.errorClass === 'user-action-required' || rule.errorClass === 'hint-gated',
    sideEffectCertainty: 'not-started',
    visibleOutputEmitted: options.visibleOutputEmitted,
    requestId: options.requestId,
    retryAfterMs: null,
  });
}

/** The stream ended without a terminal event. Transient, but never blindly re-streamed. */
export function truncatedStreamError(options: {
  readonly visibleOutputEmitted: boolean;
  readonly requestId: string | null;
}): HarnessError {
  return harnessError({
    origin: 'network',
    category: 'provider.stream.truncated',
    message: 'DashScope stream ended before the model reported a finish state',
    retryable: true,
    userActionRequired: false,
    sideEffectCertainty: 'not-started',
    visibleOutputEmitted: options.visibleOutputEmitted,
    requestId: options.requestId,
    retryAfterMs: null,
  });
}

/**
 * PV-05: a tool call whose arguments do not parse is a TYPED ERROR, never a partially-parsed call.
 * Guessing at half an object is how a `delete` runs against the wrong path.
 */
export function malformedToolArgumentsError(options: {
  readonly toolName: string;
  readonly callId: string;
  readonly argumentsJson: string;
  readonly requestId: string | null;
  readonly visibleOutputEmitted: boolean;
  readonly cause: unknown;
}): HarnessError {
  return harnessError(
    {
      origin: 'provider',
      category: 'provider.tool_call.malformed_arguments',
      message:
        `Tool call ${options.toolName} (${options.callId}) produced ${String(options.argumentsJson.length)} ` +
        'bytes of arguments that are not valid JSON; the call was not executed',
      retryable: false,
      userActionRequired: false,
      // Nothing ran: PV-05 refuses to surface the call at all until the JSON parses.
      sideEffectCertainty: 'not-started',
      visibleOutputEmitted: options.visibleOutputEmitted,
      requestId: options.requestId,
      retryAfterMs: null,
    },
    { cause: options.cause },
  );
}

export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError;
}
