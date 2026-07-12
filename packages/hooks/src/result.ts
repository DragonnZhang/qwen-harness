/**
 * The folded result of running every hook for one event.
 *
 * Everything here is ATTRIBUTED to the hook that produced it (`hookId`). Attribution is a security
 * requirement, not a nicety: injected context, a blocked action, a permission change, and a failure
 * all have to be traceable to a specific hook so the audit trail (SC-03) can name who did what.
 */
import type { SafeText } from '@qwen-harness/protocol';
import type { DecisionOutcome } from '@qwen-harness/policy';

import type { HookEvent } from './events.ts';
import type { HookOutcomeType, HookReason, McpAnnotation } from './outcome.ts';

/** Sanitized, attributed context text a hook injected. `text` is `SafeText` — it crossed the sanitizer. */
export interface InjectedContext {
  readonly hookId: string;
  readonly text: SafeText;
  /** Whether the sanitizer stripped anything (an attempted terminal-control injection). */
  readonly sanitized: boolean;
}

/**
 * A PROPOSED tool input from a `modify` hook. `needsRevalidation` is always true and non-optional:
 * the type makes it impossible to construct a proposal that claims it may be trusted directly.
 */
export interface ModifiedInputProposal {
  readonly hookId: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly needsRevalidation: true;
}

export interface AttributedReason {
  readonly hookId: string;
  readonly reason: HookReason;
}

export interface AttributedAnnotations {
  readonly hookId: string;
  readonly annotations: readonly McpAnnotation[];
}

/** A hook that TRIED to loosen permission. Recorded for audit; it had no effect (HK-04). */
export interface IgnoredElevation {
  readonly hookId: string;
  readonly requested: 'allow' | 'passthrough';
  readonly reason: HookReason;
  readonly note: string;
}

export type HookFailureKind =
  | 'timeout'
  | 'cancelled'
  | 'nonzero-exit'
  | 'spawn-error'
  | 'transport'
  | 'malformed-output'
  | 'exception'
  | 'misconfigured';

/** A visible, attributed handler failure. Never swallowed; a failing hook does not silently allow. */
export interface HookFailure {
  readonly hookId: string;
  readonly kind: HookFailureKind;
  readonly message: string;
  readonly detail?: string;
}

/** One line of the ordered audit of what each handler did. */
export interface HookInvocationRecord {
  readonly hookId: string;
  readonly form: string;
  readonly outcome: HookOutcomeType | 'failure' | 'skipped';
  readonly note: string;
}

export interface FoldedHookResult {
  readonly event: HookEvent;
  /** How many handlers actually ran (a short-circuiting block skips the rest). */
  readonly ranHandlers: number;

  /** The action is stopped before it happens (pre-action events only). */
  readonly blocked: boolean;
  readonly blockReason?: AttributedReason;

  /**
   * The permission decision after folding in every hook opinion. It is NEVER looser than the
   * decision that was fed in — a hook can restrict, never elevate (HK-04).
   */
  readonly decision: DecisionOutcome;
  readonly decisionChanged: boolean;

  /** Proposed input changes. The caller MUST re-validate each; none is applied here. */
  readonly modifications: readonly ModifiedInputProposal[];
  /** Convenience: the last proposal, still flagged for revalidation. Absent if none. */
  readonly modifiedInput?: ModifiedInputProposal;

  /** Sanitized, attributed context to inject. */
  readonly injectedContext: readonly InjectedContext[];

  /** Continuation is prevented (the NEXT step), distinct from blocking the current action. */
  readonly stopped: boolean;
  readonly stopReason?: AttributedReason;
  /**
   * True on post-tool events: the completed tool result is durable and was NOT touched, even though
   * continuation may be stopped (HK-05).
   */
  readonly resultDurable: boolean;

  readonly annotations: readonly AttributedAnnotations[];
  readonly ignoredElevations: readonly IgnoredElevation[];
  readonly failures: readonly HookFailure[];

  /** True when a Stop hook tried to trigger Stop again and was refused (HK-05). */
  readonly stopReentryRefused: boolean;

  readonly audit: readonly HookInvocationRecord[];
}
