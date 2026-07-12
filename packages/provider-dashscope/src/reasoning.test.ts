import { HarnessError } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import {
  chatEnableThinking,
  resolveReasoningEffort,
  responsesReasoningParam,
} from './reasoning.ts';

describe('resolveReasoningEffort (PV-13)', () => {
  it('lets an explicit effort win over the legacy shape, every time', () => {
    const legacyOff = { extra_body: { enable_thinking: false } };
    const legacyOn = { extra_body: { enable_thinking: true } };
    expect(resolveReasoningEffort('high', legacyOff)).toBe('high');
    expect(resolveReasoningEffort('none', legacyOn)).toBe('none');
    expect(resolveReasoningEffort('minimal', legacyOn)).toBe('minimal');
  });

  it('maps enable_thinking:false to none and true to medium', () => {
    expect(resolveReasoningEffort(undefined, { extra_body: { enable_thinking: false } })).toBe(
      'none',
    );
    expect(resolveReasoningEffort(undefined, { extra_body: { enable_thinking: true } })).toBe(
      'medium',
    );
  });

  it('defaults to medium when nothing is configured', () => {
    expect(resolveReasoningEffort(undefined, undefined)).toBe('medium');
    expect(resolveReasoningEffort(undefined, {})).toBe('medium');
    expect(resolveReasoningEffort(undefined, { extra_body: {} })).toBe('medium');
  });
});

describe('responsesReasoningParam', () => {
  it('passes the graded scale straight through and asks for a summary', () => {
    expect(responsesReasoningParam('high')).toEqual({ effort: 'high', summary: 'auto' });
    expect(responsesReasoningParam('minimal')).toEqual({ effort: 'minimal', summary: 'auto' });
    expect(responsesReasoningParam('low')).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('does not ask for a summary of thinking that will not happen', () => {
    expect(responsesReasoningParam('none')).toEqual({ effort: 'none' });
  });
});

describe('chatEnableThinking', () => {
  it('maps none to false and medium to true', () => {
    expect(chatEnableThinking('none')).toBe(false);
    expect(chatEnableThinking('medium')).toBe(true);
  });

  it.each(['minimal', 'low', 'high'] as const)(
    "rejects '%s' with a typed error instead of rounding it",
    (effort) => {
      let thrown: unknown;
      try {
        chatEnableThinking(effort);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HarnessError);
      const error = thrown as HarnessError;
      expect(error.category).toBe('provider.unsupported.reasoning_granularity');
      expect(error.retryable).toBe(false);
      expect(error.userActionRequired).toBe(true);
      expect(error.message).toContain(effort);
    },
  );
});
