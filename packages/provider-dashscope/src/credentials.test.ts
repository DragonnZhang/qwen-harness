import { HarnessError } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import {
  DASHSCOPE_API_KEY_ENV,
  EnvCredentialSource,
  NoCredentialSource,
  requireApiKey,
} from './credentials.ts';

describe('EnvCredentialSource', () => {
  it('reads the key from the environment', () => {
    const source = new EnvCredentialSource(DASHSCOPE_API_KEY_ENV, {
      [DASHSCOPE_API_KEY_ENV]: 'sk-value',
    });
    expect(source.read()).toBe('sk-value');
  });

  it('treats an empty or whitespace-only variable as ABSENT, not as a key', () => {
    // `export DASHSCOPE_API_KEY=` must produce "you have no key", not an opaque 401 from the server.
    expect(
      new EnvCredentialSource(DASHSCOPE_API_KEY_ENV, { [DASHSCOPE_API_KEY_ENV]: '' }).read(),
    ).toBeNull();
    expect(
      new EnvCredentialSource(DASHSCOPE_API_KEY_ENV, { [DASHSCOPE_API_KEY_ENV]: '   ' }).read(),
    ).toBeNull();
    expect(new EnvCredentialSource(DASHSCOPE_API_KEY_ENV, {}).read()).toBeNull();
  });

  it('describes WHERE the key comes from and never what it is', () => {
    const source = new EnvCredentialSource(DASHSCOPE_API_KEY_ENV, {
      [DASHSCOPE_API_KEY_ENV]: 'sk-secret-value',
    });
    expect(source.description).toBe('env:DASHSCOPE_API_KEY');
    expect(source.description).not.toContain('sk-secret-value');
  });
});

describe('requireApiKey', () => {
  it('throws a typed, actionable error when the key is absent', () => {
    let thrown: unknown;
    try {
      requireApiKey(new NoCredentialSource());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessError);
    const error = thrown as HarnessError;
    expect(error.category).toBe('provider.credential.missing');
    expect(error.userActionRequired).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.sideEffectCertainty).toBe('not-started');
    expect(error.message).toContain(DASHSCOPE_API_KEY_ENV);
  });

  it('returns the key when it is present', () => {
    const source = new EnvCredentialSource(DASHSCOPE_API_KEY_ENV, {
      [DASHSCOPE_API_KEY_ENV]: 'sk-value',
    });
    expect(requireApiKey(source)).toBe('sk-value');
  });
});
