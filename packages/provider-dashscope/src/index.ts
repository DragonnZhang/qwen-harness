/**
 * @qwen-harness/provider-dashscope
 *
 * The one production provider adapter. LAYER 2.
 *
 * This package owns model-endpoint traffic and is the ONLY reader of `DASHSCOPE_API_KEY` in the
 * product (`pnpm architecture` rule 6 enforces both). Everything it exports is expressed in
 * `provider-core` types: no vendor wire object crosses this boundary (task.md boundary 6), which
 * is why `wire.ts` is not re-exported here.
 */

export { CHAT_CAPABILITIES, buildChatBody, toChatMessages } from './chat-transport.ts';
export {
  DASHSCOPE_API_KEY_ENV,
  EnvCredentialSource,
  NoCredentialSource,
  missingCredentialError,
  requireApiKey,
  type CredentialSource,
} from './credentials.ts';
export {
  ERROR_TABLE,
  classifyHttpError,
  classifyTransportError,
  lookupRule,
  malformedToolArgumentsError,
  parseErrorBody,
  parseRetryAfterHeader,
  ruleForStatus,
  streamFailureError,
  truncatedStreamError,
  type ErrorClass,
  type ErrorRule,
  type ParsedErrorBody,
} from './errors.ts';
export type { FetchLike } from './http.ts';
export {
  DEFAULT_REASONING_EFFORT,
  chatEnableThinking,
  resolveReasoningEffort,
  responsesReasoningParam,
  unsupportedReasoningGranularityError,
  type LegacyGenerationConfig,
} from './reasoning.ts';
export {
  DASHSCOPE_DEFAULTS,
  DashScopeProvider,
  type DashScopeProviderOptions,
  type DashScopeTransport,
} from './provider.ts';
export {
  RESPONSES_CAPABILITIES,
  buildResponsesBody,
  parseToolArguments,
} from './responses-transport.ts';
