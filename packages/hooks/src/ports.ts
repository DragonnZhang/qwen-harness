/**
 * The interfaces this engine depends on but does NOT own.
 *
 * `hooks` is a declared I/O owner for `node:child_process` ONLY (the command executor). Everything
 * else it needs — an outbound HTTP connection, a model prompt, a subagent — is INJECTED as a port.
 * This keeps the architecture boundary honest: HTTP hooks go through the `network` package's broker,
 * not a socket opened here, and the engine stays unit-testable with fakes.
 *
 * The ports are defined STRUCTURALLY (no import of the implementing package). `network` in
 * particular has no published surface yet; hooks depends on the SHAPE it needs, so the day network
 * ships a broker with this shape it drops straight in with zero coupling.
 */
import type { HookOutcome } from './outcome.ts';
import type { HookInvocation } from './registry.ts';

export interface NetworkHookRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The hook's own timeout. The engine ALSO enforces a deadline; this is defence in depth. */
  readonly timeoutMs: number;
}

export interface NetworkHookResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The approved outbound connection broker (the `network` package). The engine hands it a fully
 * formed request and an AbortSignal; the broker enforces network policy, TLS, and redirects. The
 * engine never sees a socket.
 */
export interface NetworkBroker {
  fetch(request: NetworkHookRequest, signal: AbortSignal): Promise<NetworkHookResponse>;
}

export interface PromptRequest {
  readonly prompt: string;
  readonly invocation: HookInvocation;
}

/** A prompt/model hook: the runtime injects the model call. */
export interface PromptRunner {
  run(request: PromptRequest, signal: AbortSignal): Promise<HookOutcome>;
}

export interface AgentRequest {
  readonly agent: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly invocation: HookInvocation;
}

/** An agent hook: the runtime injects a bounded subagent invocation. */
export interface AgentRunner {
  run(request: AgentRequest, signal: AbortSignal): Promise<HookOutcome>;
}
