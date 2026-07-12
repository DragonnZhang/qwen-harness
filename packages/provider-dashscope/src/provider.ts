import type {
  ModelProvider,
  ModelRequest,
  ProviderCapabilities,
  ProviderStreamEvent,
  ReasoningEffort,
} from '@qwen-harness/provider-core';

import { CHAT_CAPABILITIES, streamChat } from './chat-transport.ts';
import {
  DASHSCOPE_API_KEY_ENV,
  EnvCredentialSource,
  requireApiKey,
  type CredentialSource,
} from './credentials.ts';
import { classifyTransportError, isHarnessError } from './errors.ts';
import { isAbort, type FetchLike, type StreamState } from './http.ts';
import { resolveReasoningEffort, type LegacyGenerationConfig } from './reasoning.ts';
import {
  RESPONSES_CAPABILITIES,
  streamResponses,
  type TransportContext,
} from './responses-transport.ts';

export type DashScopeTransport = 'responses' | 'chat';

/** The default safe configuration frozen in task.md. */
export const DASHSCOPE_DEFAULTS = Object.freeze({
  model: 'qwen3.7-max',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: DASHSCOPE_API_KEY_ENV,
  transport: 'responses' as DashScopeTransport,
  reasoningEffort: 'medium' as ReasoningEffort,
  contextWindowSize: 1_000_000,
});

export interface DashScopeProviderOptions {
  readonly baseURL?: string;
  readonly transport?: DashScopeTransport;
  /** Defaults to the environment variable. `secret-store` will implement this same interface. */
  readonly credentials?: CredentialSource;
  /** Injected so contract tests can replay real captured bytes without a socket. */
  readonly fetchImpl?: FetchLike;
  /**
   * The legacy compatibility shape (requirement 12). Accepted as configuration, translated on the
   * way out, and NEVER emitted: an `extra_body` key does not exist on this wire.
   * An explicit `reasoningEffort` on the request always wins over it.
   */
  readonly generationConfig?: LegacyGenerationConfig;
}

export class DashScopeProvider implements ModelProvider {
  readonly capabilities: ProviderCapabilities;

  readonly #baseURL: string;
  readonly #transport: DashScopeTransport;
  readonly #credentials: CredentialSource;
  readonly #fetchImpl: FetchLike;
  readonly #generationConfig: LegacyGenerationConfig | undefined;

  constructor(options: DashScopeProviderOptions = {}) {
    this.#baseURL = (options.baseURL ?? DASHSCOPE_DEFAULTS.baseURL).replace(/\/+$/, '');
    this.#transport = options.transport ?? DASHSCOPE_DEFAULTS.transport;
    this.#credentials = options.credentials ?? new EnvCredentialSource();
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#generationConfig = options.generationConfig;
    this.capabilities =
      this.#transport === 'responses' ? RESPONSES_CAPABILITIES : CHAT_CAPABILITIES;
  }

  /** Where the key comes from, for `doctor`. Never the key. */
  get credentialDescription(): string {
    return this.#credentials.description;
  }

  /**
   * Failure contract (see `ModelProvider`): every failure is emitted as a terminal `error` event
   * AND thrown as the same `HarnessError`. Emitting alone lets a careless consumer mistake a failed
   * turn for an empty one; throwing alone hides the failure from an event-sourced projection.
   *
   * An abort propagates as itself. Cancellation is not a provider failure and must not be
   * classified, counted against a retry budget, or shown as one.
   */
  async *stream(request: ModelRequest): AsyncGenerator<ProviderStreamEvent> {
    const state: StreamState = { visibleOutputEmitted: false, requestId: null };
    try {
      yield* this.#run(request, state);
    } catch (cause) {
      if (isAbort(cause, request.signal)) throw cause;
      const error = isHarnessError(cause)
        ? cause
        : classifyTransportError(cause, {
            visibleOutputEmitted: state.visibleOutputEmitted,
            requestId: state.requestId,
          });
      yield { type: 'error', error };
      throw error;
    }
  }

  async *#run(request: ModelRequest, state: StreamState): AsyncGenerator<ProviderStreamEvent> {
    // Requirement 13: this throws BEFORE the request body is built and before any socket opens.
    const apiKey = requireApiKey(this.#credentials);
    const effort = resolveReasoningEffort(request.reasoningEffort, this.#generationConfig);

    const ctx: TransportContext = {
      url: `${this.#baseURL}${this.#transport === 'responses' ? '/responses' : '/chat/completions'}`,
      apiKey,
      fetchImpl: this.#fetchImpl,
    };

    if (this.#transport === 'responses') {
      yield* streamResponses(ctx, request, effort, state);
    } else {
      yield* streamChat(ctx, request, effort, state);
    }
  }
}
