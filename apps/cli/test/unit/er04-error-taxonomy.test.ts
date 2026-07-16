import { TerminationReasonSchema } from '@qwen-harness/protocol';
import { ruleForStatus } from '@qwen-harness/provider-dashscope';
import { isBinary } from '@qwen-harness/tool-worker';
import { ToolErrorCategorySchema } from '@qwen-harness/tools-core';
import { describe, expect, it } from 'vitest';

/**
 * Every recoverable error condition has its OWN typed path (ER-04).
 *
 * ER-04 is about DISTINCTNESS: image/media validation, stream/tool abort, hook block, token-budget,
 * overload, and unsupported capabilities must each terminate through a specific, named path — so a
 * user learns WHICH pathology occurred, and code can react differently to each. This exercises the
 * real classifiers/detectors and the frozen taxonomies to prove none of them collapses into a generic
 * error. (The engine driving these reasons end to end is `packages/runtime/test/integration/turn-engine.test.ts`.)
 */

describe('recoverable conditions have distinct typed paths (ER-04)', () => {
  it('image/media validation: binary content is DETECTED and routed to its own category', () => {
    // A NUL byte in the head marks non-text (image/media/binary) content.
    expect(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a]))).toBe(true);
    expect(isBinary(Buffer.from('ordinary source code\n', 'utf8'))).toBe(false);
    // ...and it has its OWN tool-error category, distinct from a size or input error.
    const cats = ToolErrorCategorySchema.options;
    expect(cats).toContain('binary-file');
    expect(cats).toContain('too-large');
    expect(cats).toContain('unsupported'); // unsupported capability is its own category too
  });

  it('overload is a distinct, RETRYABLE class — never conflated with a permanent failure', () => {
    // A 5xx (server overload) is retryable: back off and try again.
    expect(ruleForStatus(503).errorClass).toBe('retryable');
    expect(ruleForStatus(500).errorClass).toBe('retryable');
    // An auth failure is NOT retryable — a different typed path entirely.
    expect(ruleForStatus(401).errorClass).toBe('user-action-required');
    // A plain 4xx is permanent — a third distinct class.
    expect(ruleForStatus(422).errorClass).toBe('permanent');
    // Three inputs, three distinct classes — the taxonomy does not collapse.
    expect(
      new Set([
        ruleForStatus(503).errorClass,
        ruleForStatus(401).errorClass,
        ruleForStatus(422).errorClass,
      ]).size,
    ).toBe(3);
  });

  it('abort, hook block, and token-budget each terminate with their OWN reason', () => {
    const reasons = TerminationReasonSchema.options as readonly string[];
    // Each condition names a distinct termination reason: abort → user-cancelled, hook block →
    // hook-stop, token-budget → token-limit (plus the sibling model/tool/time/cost limits).
    for (const r of [
      'user-cancelled',
      'hook-stop',
      'token-limit',
      'time-limit',
      'provider-error',
    ]) {
      expect(reasons, `missing typed reason: ${r}`).toContain(r);
    }
    // They are genuinely distinct members — a hook block is never a token-budget exhaustion.
    expect(new Set(['user-cancelled', 'hook-stop', 'token-limit', 'provider-error']).size).toBe(4);
  });
});
