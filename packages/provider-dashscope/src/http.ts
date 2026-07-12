import {
  classifyHttpError,
  classifyTransportError,
  isHarnessError,
  parseErrorBody,
  parseRetryAfterHeader,
} from './errors.ts';

/**
 * The HTTP boundary. Node 24's built-in `fetch` is the transport — no `undici` dependency, because
 * adding one would only re-export what the runtime already ships.
 *
 * `fetch` is INJECTABLE for one reason that matters: the contract tests replay the real captured
 * SSE bytes through the real normalizer, and the credential test proves that a missing key means
 * zero calls. Neither is possible if the transport reaches for a global.
 */
export type FetchLike = typeof globalThis.fetch;

/** Mutable across a single stream. The error path needs both facts to classify correctly. */
export interface StreamState {
  /** Set the instant the first text delta reaches the caller. Gates PV-11. */
  visibleOutputEmitted: boolean;
  requestId: string | null;
}

export interface OpenStreamOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly signal: AbortSignal | undefined;
  readonly fetchImpl: FetchLike;
  readonly state: StreamState;
}

/** A failed request body is read whole, but bounded: an HTML error page must not become a log. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

export async function openSseStream(
  options: OpenStreamOptions,
): Promise<ReadableStream<Uint8Array>> {
  const { url, apiKey, body, signal, fetchImpl, state } = options;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        // The Authorization header is constructed here and never logged, echoed, or stored.
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
  } catch (cause) {
    if (isAbort(cause, signal)) throw cause;
    if (isHarnessError(cause)) throw cause;
    throw classifyTransportError(cause, {
      visibleOutputEmitted: state.visibleOutputEmitted,
      requestId: state.requestId,
    });
  }

  const headerRequestId = response.headers.get('x-request-id');
  if (headerRequestId !== null && headerRequestId !== '') state.requestId = headerRequestId;

  if (!response.ok) {
    const raw = (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
    const parsed = parseErrorBody(raw);
    if (parsed.requestId !== null) state.requestId = parsed.requestId;
    throw classifyHttpError({
      status: response.status,
      body: parsed,
      headerRequestId: state.requestId,
      headerRetryAfterMs: parseRetryAfterHeader(response.headers.get('retry-after'), Date.now()),
      visibleOutputEmitted: state.visibleOutputEmitted,
    });
  }

  if (response.body === null) {
    throw classifyTransportError(new Error('response had no body'), {
      visibleOutputEmitted: state.visibleOutputEmitted,
      requestId: state.requestId,
    });
  }
  return response.body;
}

/** Cancellation is not a provider failure: it must propagate as itself, never as a HarnessError. */
export function isAbort(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return cause instanceof Error && cause.name === 'AbortError';
}
