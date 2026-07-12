import type { ProviderCapabilities } from './capabilities.ts';
import type { ProviderStreamEvent } from './events.ts';
import type { ModelRequest } from './model.ts';

/**
 * The only interface the runtime knows about.
 *
 * Failure contract, which every implementation must honor identically:
 *
 *  - A failure is emitted as a terminal `{ type: 'error' }` event AND then thrown as the same
 *    `HarnessError`. Emitting alone would let a careless consumer treat a failed turn as an empty
 *    one; throwing alone would hide the failure from an event-sourced projection. Both, always.
 *  - An abort rejects with the signal's reason, not with a `HarnessError`: cancellation is not a
 *    provider failure.
 *  - A successful stream ends with exactly one `done` event.
 */
export interface ModelProvider {
  readonly capabilities: ProviderCapabilities;
  stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent>;
}
