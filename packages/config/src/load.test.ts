import { describe, expect, it } from 'vitest';

import {
  ConfigEnvError,
  ConfigError,
  computeConfigPaths,
  loadCliSource,
  loadEnvSource,
} from './load.ts';

describe('loadEnvSource — allowlist only', () => {
  it('reads allowlisted variables into a validated source', () => {
    const source = loadEnvSource({
      QWEN_HARNESS_MODEL: 'qwen3.7-max',
      QWEN_HARNESS_REASONING_EFFORT: 'high',
      QWEN_HARNESS_TELEMETRY: 'true',
    });
    expect(source).toBeDefined();
    expect(source?.scope).toBe('env');
    expect(source?.config.model).toBe('qwen3.7-max');
    expect(source?.config.reasoningEffort).toBe('high');
    expect(source?.config.telemetry).toEqual({ enabled: true });
  });

  it('IGNORES a non-allowlisted variable', () => {
    // Neither an arbitrary var nor the raw key variable may steer config.
    const source = loadEnvSource({
      SOME_RANDOM_VAR: 'value',
      DASHSCOPE_API_KEY: 'sk-secret',
      QWEN_HARNESS_UNKNOWN: 'ignored',
    });
    expect(source).toBeUndefined();
  });

  it('returns undefined when no allowlisted variable is set', () => {
    expect(loadEnvSource({})).toBeUndefined();
  });

  it('coerces booleans and rejects a malformed one, naming the variable', () => {
    expect(loadEnvSource({ QWEN_HARNESS_TELEMETRY: 'off' })?.config.telemetry).toEqual({
      enabled: false,
    });
    try {
      loadEnvSource({ QWEN_HARNESS_TELEMETRY: 'maybe' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigEnvError);
      expect((err as ConfigEnvError).variable).toBe('QWEN_HARNESS_TELEMETRY');
    }
  });

  it('rejects an env value that fails schema validation, naming the variable(s)', () => {
    try {
      loadEnvSource({ QWEN_HARNESS_TRANSPORT: 'carrier-pigeon' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigEnvError);
      expect((err as ConfigEnvError).variable).toContain('QWEN_HARNESS_TRANSPORT');
    }
  });

  it('rejects a raw key given as the api-key-env variable', () => {
    expect(() => loadEnvSource({ QWEN_HARNESS_API_KEY_ENV: 'sk-abc123' })).toThrow(ConfigEnvError);
  });
});

describe('loadCliSource', () => {
  it('wraps a valid override as the cli source', () => {
    const source = loadCliSource({ permissionProfile: 'plan' });
    expect(source.scope).toBe('cli');
    expect(source.config.permissionProfile).toBe('plan');
  });

  it('rejects an invalid override visibly', () => {
    expect(() => loadCliSource({ budgets: { turnsPerGoal: -1 } })).toThrow(ConfigError);
  });
});

describe('computeConfigPaths', () => {
  it('respects an absolute XDG_CONFIG_HOME', () => {
    const paths = computeConfigPaths({
      projectRoot: '/repo',
      homeDir: '/home/dev',
      env: { XDG_CONFIG_HOME: '/custom/xdg' },
    });
    expect(paths.user).toBe('/custom/xdg/qwen-harness/config.json');
    expect(paths.sharedProject).toBe('/repo/.qwen-harness/config.json');
    expect(paths.localProject).toBe('/repo/.qwen-harness/config.local.json');
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or relative', () => {
    expect(computeConfigPaths({ projectRoot: '/repo', homeDir: '/home/dev', env: {} }).user).toBe(
      '/home/dev/.config/qwen-harness/config.json',
    );
    expect(
      computeConfigPaths({
        projectRoot: '/repo',
        homeDir: '/home/dev',
        env: { XDG_CONFIG_HOME: 'relative/path' },
      }).user,
    ).toBe('/home/dev/.config/qwen-harness/config.json');
  });
});
