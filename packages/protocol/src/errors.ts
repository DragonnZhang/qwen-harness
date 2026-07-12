import { z } from 'zod';

/**
 * Errors are typed by origin, retryability, required user action, side-effect certainty, and
 * visibility (design.md §13). Those five axes are what the runtime actually branches on:
 *
 *  - `retryable` decides whether backoff is even legal;
 *  - `userActionRequired` decides whether retrying could ever succeed (quota/arrears/auth cannot);
 *  - `sideEffectCertainty` decides whether recovery may re-run the action — this is the axis that
 *    prevents replaying a known-complete destructive operation;
 *  - `visibleOutputEmitted` decides whether we may transparently retry, because a retry stream
 *    must never be concatenated onto partial visible output (PV-11).
 */
export const ErrorOriginSchema = z.enum([
  'provider',
  'network',
  'tool',
  'policy',
  'sandbox',
  'hook',
  'mcp',
  'storage',
  'config',
  'budget',
  'user',
  'internal',
]);
export type ErrorOrigin = z.infer<typeof ErrorOriginSchema>;

export const SideEffectCertaintySchema = z.enum([
  'none',
  'not-started',
  'known-complete',
  'known-failed',
  'indeterminate',
]);
export type SideEffectCertainty = z.infer<typeof SideEffectCertaintySchema>;

export const HarnessErrorSchema = z.object({
  origin: ErrorOriginSchema,
  /** Machine-readable, stable across releases. e.g. "provider.rate_limit.throttling". */
  category: z.string().min(1),
  /** Safe to show a user. Never contains credentials or full sensitive bodies. */
  message: z.string(),
  retryable: z.boolean(),
  userActionRequired: z.boolean(),
  sideEffectCertainty: SideEffectCertaintySchema,
  visibleOutputEmitted: z.boolean(),
  /** Provider request ID, preserved for support. Redacted of any credential material. */
  requestId: z.string().nullable(),
  /** Server retry hint in ms, when the provider supplied one. */
  retryAfterMs: z.number().int().nonnegative().nullable(),
});
export type HarnessErrorData = z.infer<typeof HarnessErrorSchema>;

export class HarnessError extends Error {
  readonly origin: ErrorOrigin;
  readonly category: string;
  readonly retryable: boolean;
  readonly userActionRequired: boolean;
  readonly sideEffectCertainty: SideEffectCertainty;
  readonly visibleOutputEmitted: boolean;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;

  constructor(data: HarnessErrorData, options?: { cause?: unknown }) {
    super(data.message, options);
    this.name = 'HarnessError';
    this.origin = data.origin;
    this.category = data.category;
    this.retryable = data.retryable;
    this.userActionRequired = data.userActionRequired;
    this.sideEffectCertainty = data.sideEffectCertainty;
    this.visibleOutputEmitted = data.visibleOutputEmitted;
    this.requestId = data.requestId;
    this.retryAfterMs = data.retryAfterMs;
  }

  toData(): HarnessErrorData {
    return {
      origin: this.origin,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      userActionRequired: this.userActionRequired,
      sideEffectCertainty: this.sideEffectCertainty,
      visibleOutputEmitted: this.visibleOutputEmitted,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
    };
  }

  /**
   * A retry is only legal when the error is retryable AND no visible output has already been
   * emitted AND we have not already caused a side effect whose outcome we know or cannot
   * determine. All three must hold; any one of them alone is not enough.
   */
  canRetryTransparently(): boolean {
    return (
      this.retryable &&
      !this.userActionRequired &&
      !this.visibleOutputEmitted &&
      (this.sideEffectCertainty === 'none' || this.sideEffectCertainty === 'not-started')
    );
  }
}

export function harnessError(
  partial: Pick<HarnessErrorData, 'origin' | 'category' | 'message'> & Partial<HarnessErrorData>,
  options?: { cause?: unknown },
): HarnessError {
  return new HarnessError(
    {
      retryable: false,
      userActionRequired: false,
      sideEffectCertainty: 'none',
      visibleOutputEmitted: false,
      requestId: null,
      retryAfterMs: null,
      ...partial,
    },
    options,
  );
}
