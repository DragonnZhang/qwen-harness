import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import {
  ApiKeyEnvSchema,
  ConfigDocSchema,
  ProfileConfigSchema,
  ReasoningEffortSchema,
} from './schema.ts';

describe('ApiKeyEnvSchema — stores a NAME, never a value', () => {
  it('accepts a plausible environment variable name', () => {
    expect(ApiKeyEnvSchema.parse('DASHSCOPE_API_KEY')).toBe('DASHSCOPE_API_KEY');
    expect(ApiKeyEnvSchema.parse('CUSTOM_MODEL_KEY_ENV')).toBe('CUSTOM_MODEL_KEY_ENV');
  });

  it('REJECTS a raw API key value (the SC threat model bug)', () => {
    // A `sk-…` value fails the env-name regex outright.
    expect(ApiKeyEnvSchema.safeParse(CANARY_API_KEY).success).toBe(false);
    expect(ApiKeyEnvSchema.safeParse(`${CANARY_API_KEY}-variant`).success).toBe(false);
    // Lowercase / hyphenated tokens are never env-var names.
    expect(ApiKeyEnvSchema.safeParse('my-secret-key').success).toBe(false);
  });

  it('rejects an all-caps value that still looks like a secret', () => {
    expect(ApiKeyEnvSchema.safeParse('TOKEN_ABCDEF').success).toBe(false);
    expect(ApiKeyEnvSchema.safeParse('BEARER_XYZ').success).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(ApiKeyEnvSchema.safeParse('').success).toBe(false);
  });
});

describe('ProfileConfigSchema — canonical profiles and aliases', () => {
  it('maps compatibility aliases onto canonical profiles', () => {
    expect(ProfileConfigSchema.parse('default')).toBe('ask');
    expect(ProfileConfigSchema.parse('manual')).toBe('ask');
    expect(ProfileConfigSchema.parse('acceptEdits')).toBe('auto-accept-edits');
    expect(ProfileConfigSchema.parse('bypassPermissions')).toBe('yolo');
  });

  it('accepts the four canonical profiles unchanged', () => {
    for (const profile of ['plan', 'ask', 'auto-accept-edits', 'yolo']) {
      expect(ProfileConfigSchema.parse(profile)).toBe(profile);
    }
  });

  it('rejects an unknown profile', () => {
    expect(ProfileConfigSchema.safeParse('wide-open').success).toBe(false);
  });
});

describe('ConfigDocSchema — a strict boundary', () => {
  it('accepts a minimal partial document', () => {
    const parsed = ConfigDocSchema.parse({ model: 'qwen3.7-max', reasoningEffort: 'high' });
    expect(parsed.model).toBe('qwen3.7-max');
    expect(ReasoningEffortSchema.parse(parsed.reasoningEffort)).toBe('high');
  });

  it('rejects an unknown key (a typo must not be silently ignored)', () => {
    expect(ConfigDocSchema.safeParse({ modle: 'qwen3.7-max' }).success).toBe(false);
  });

  it('rejects a non-URL baseUrl', () => {
    expect(ConfigDocSchema.safeParse({ baseUrl: 'not a url' }).success).toBe(false);
  });

  it('rejects a non-positive budget', () => {
    expect(ConfigDocSchema.safeParse({ budgets: { turnsPerGoal: 0 } }).success).toBe(false);
    expect(ConfigDocSchema.safeParse({ budgets: { turnsPerGoal: -5 } }).success).toBe(false);
  });

  it('rejects a raw key in apiKeyEnv at the document level', () => {
    expect(ConfigDocSchema.safeParse({ apiKeyEnv: CANARY_API_KEY }).success).toBe(false);
  });
});
