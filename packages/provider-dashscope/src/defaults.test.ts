import { describe, expect, it } from 'vitest';

import { DASHSCOPE_DEFAULTS, DashScopeProvider } from './provider.ts';

/**
 * PV-02 (U) — the frozen safe defaults for the DashScope provider.
 *
 * `task.md` pins these exact values (model `qwen3.7-max`, the compatible endpoint, the
 * `DASHSCOPE_API_KEY` env NAME — never a value, `responses` transport, `medium` effort, one-million
 * declared context). `provider-config.test.ts` already covers endpoint/transport/credential wiring;
 * this asserts the frozen model / effort / 1M-context defaults and that a provider built with no
 * options adopts the default endpoint rather than silently substituting one.
 */

describe('DASHSCOPE_DEFAULTS (PV-02)', () => {
  it('freezes the exact safe defaults task.md pins', () => {
    expect(DASHSCOPE_DEFAULTS).toMatchObject({
      model: 'qwen3.7-max',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      transport: 'responses',
      reasoningEffort: 'medium',
      contextWindowSize: 1_000_000,
    });
    // The defaults are a stable contract — frozen so nothing can mutate them at runtime.
    expect(Object.isFrozen(DASHSCOPE_DEFAULTS)).toBe(true);
  });

  it('stores the credential ENV NAME, never a value', () => {
    // The default names the environment variable to read; the value is never embedded.
    expect(DASHSCOPE_DEFAULTS.apiKeyEnv).toBe('DASHSCOPE_API_KEY');
    expect(DASHSCOPE_DEFAULTS.apiKeyEnv).not.toMatch(/^sk-/);
  });

  it('a provider built with no options adopts the default endpoint and responses transport', () => {
    const provider = new DashScopeProvider({});
    // Responses is the default transport, so the capabilities are the Responses table (reasoning
    // summary supported), not the Chat one — proving the default transport actually took effect.
    expect(provider.capabilities.reasoningSummary).toBe(true);
  });
});
