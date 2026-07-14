import type { ToolCallId } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import {
  ToolAnnotationsSchema,
  ToolErrorCategorySchema,
  type ToolErrorCategory,
  type ToolResult,
} from './contract.ts';

/**
 * TL-12 — the ONE stable tool-result shape.
 *
 * `ToolResult` is what every executed tool becomes before it re-enters the runtime: provenance for
 * the audit trail (SC-03), a bounded `modelText` for the context budget, a `truncated`/`outputRef`
 * pair for offloaded output (TL-10), a machine-readable `error.category`, and a `durationMs`. These
 * tests pin that shape and the error taxonomy against the REAL contract, for a success AND an error.
 *
 * Note on scope: `ToolResult` is a TypeScript interface with no runtime zod schema; the only
 * runtime-validated part of the result contract is the error CATEGORY (`ToolErrorCategorySchema`).
 * So the load-bearing runtime assertions here drive that schema and the field invariants directly.
 */

// A well-formed SUCCESS result, typed against the real interface so the field list is the real one.
const success: ToolResult<{ text: string }> = {
  callId: 'call_000001' as ToolCallId,
  toolName: 'read_file',
  ok: true,
  output: { text: 'hello' },
  error: null,
  userText: 'hello\nworld\n(full 5000-line file)',
  modelText: 'hello\nworld\n… (truncated)',
  outputRef: 'blob://outputs/abc123',
  truncated: true,
  durationMs: 12,
  provenance: 'worker:sandbox-0',
};

// A well-formed ERROR result.
const failure: ToolResult<never> = {
  callId: 'call_000002' as ToolCallId,
  toolName: 'write_file',
  ok: false,
  output: null,
  error: { category: 'permission-denied', message: 'profile "ask" declined write' },
  userText: 'write refused',
  modelText: 'write refused',
  outputRef: null,
  truncated: false,
  durationMs: 3,
  provenance: 'runtime:policy',
};

describe('ToolErrorCategory taxonomy (TL-12)', () => {
  // The exact, ordered taxonomy the contract declares. Pinning it makes an addition/removal/rename
  // fail loudly — the category is machine-readable and crosses into events, so it is a stable API.
  const CATEGORIES: readonly ToolErrorCategory[] = [
    'invalid-input',
    'semantic-invalid',
    'not-found',
    'permission-denied',
    'policy-denied',
    'sandbox-denied',
    'stale-file',
    'binary-file',
    'too-large',
    'timeout',
    'cancelled',
    'execution-failed',
    'unsupported',
    'internal',
  ];

  it('pins the exact set of error categories', () => {
    expect(ToolErrorCategorySchema.options).toEqual(CATEGORIES);
  });

  it('accepts every declared category and REJECTS an undeclared one', () => {
    for (const c of CATEGORIES) {
      expect(ToolErrorCategorySchema.safeParse(c).success).toBe(true);
    }
    expect(ToolErrorCategorySchema.safeParse('kaboom').success).toBe(false);
    expect(ToolErrorCategorySchema.safeParse('').success).toBe(false);
    expect(ToolErrorCategorySchema.safeParse(42).success).toBe(false);
  });
});

describe('ToolResult stable shape (TL-12)', () => {
  it('a SUCCESS result carries output, no error, and full audit fields', () => {
    expect(success.ok).toBe(true);
    expect(success.output).not.toBeNull();
    expect(success.error).toBeNull();

    // Audit identity + budget fields are all present and of the declared kind.
    expect(typeof success.callId).toBe('string');
    expect(typeof success.toolName).toBe('string');
    expect(typeof success.userText).toBe('string');
    expect(typeof success.modelText).toBe('string');
    expect(typeof success.durationMs).toBe('number');
    expect(success.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof success.provenance).toBe('string');
    expect(success.provenance.length).toBeGreaterThan(0);
    expect(typeof success.truncated).toBe('boolean');
  });

  it('the two renderings are distinct and modelText is the bounded one (TL-10)', () => {
    // The whole reason there are two fields: `modelText` is bounded for the context window while
    // `userText` may be long. When output is offloaded, `outputRef` is set and `truncated` is true.
    expect(success.truncated).toBe(true);
    expect(success.outputRef).not.toBeNull();
    expect(success.modelText.length).toBeLessThanOrEqual(success.userText.length);
  });

  it('an ERROR result carries a categorized error, no output, and no dangling ref', () => {
    expect(failure.ok).toBe(false);
    expect(failure.output).toBeNull();
    expect(failure.error).not.toBeNull();

    // The error category is a REAL member of the taxonomy — validated by the contract's own schema.
    const parsed = ToolErrorCategorySchema.safeParse(failure.error?.category);
    expect(parsed.success).toBe(true);
    expect(typeof failure.error?.message).toBe('string');

    // A failed call produced no offloaded output.
    expect(failure.outputRef).toBeNull();
    expect(failure.truncated).toBe(false);
    // Even a failure keeps provenance + duration for the audit trail.
    expect(failure.provenance.length).toBeGreaterThan(0);
    expect(typeof failure.durationMs).toBe('number');
  });
});

describe('ToolAnnotations schema (behavioral contract the scheduler/policy read)', () => {
  it('accepts a complete annotation set and REJECTS a partial one', () => {
    const full = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
    expect(ToolAnnotationsSchema.safeParse(full).success).toBe(true);

    // Every flag is required — a missing one is a real defect, not a default.
    const partial = { readOnly: true, destructive: false, idempotent: true };
    expect(ToolAnnotationsSchema.safeParse(partial).success).toBe(false);
  });
});
