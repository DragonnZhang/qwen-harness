import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import {
  ConfigMigrationError,
  UnknownConfigVersionError,
  migrateConfig,
  readConfigVersion,
} from './migrations.ts';
import { ConfigDocSchema } from './schema.ts';

describe('readConfigVersion', () => {
  it('treats an absent version as v0 (unversioned pre-release)', () => {
    expect(readConfigVersion({ model: 'x' })).toBe(0);
  });

  it('reads an explicit version', () => {
    expect(readConfigVersion({ version: 1 })).toBe(1);
  });

  it('rejects a non-object document', () => {
    expect(() => readConfigVersion(42)).toThrow(ConfigMigrationError);
    expect(() => readConfigVersion(null)).toThrow(ConfigMigrationError);
    expect(() => readConfigVersion([])).toThrow(ConfigMigrationError);
  });

  it('rejects a non-integer version', () => {
    expect(() => readConfigVersion({ version: 'one' })).toThrow(ConfigMigrationError);
    expect(() => readConfigVersion({ version: 1.5 })).toThrow(ConfigMigrationError);
  });
});

describe('v0 -> v1 migration', () => {
  it('renames the legacy keys and stamps the version', () => {
    const result = migrateConfig({
      endpoint: 'https://dashscope.example/v1',
      keyEnv: 'DASHSCOPE_API_KEY',
      profile: 'acceptEdits',
      reasoning: 'high',
    });
    expect(result.fromVersion).toBe(0);
    expect(result.applied).toEqual(['v0-unversioned-to-v1']);
    expect(result.config).toMatchObject({
      version: 1,
      baseUrl: 'https://dashscope.example/v1',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      permissionProfile: 'acceptEdits',
      reasoningEffort: 'high',
    });
    // The legacy keys are gone.
    expect(result.config).not.toHaveProperty('endpoint');
    expect(result.config).not.toHaveProperty('keyEnv');

    // And the migrated document validates and the alias resolves.
    const parsed = ConfigDocSchema.parse(result.config);
    expect(parsed.permissionProfile).toBe('auto-accept-edits');
  });

  it('DROPS a legacy raw apiKey rather than carrying a secret forward', () => {
    const result = migrateConfig({ apiKey: CANARY_API_KEY });
    expect(result.config).not.toHaveProperty('apiKey');
    expect(result.notes.some((n) => n.includes('apiKey'))).toBe(true);
  });

  it('is deterministic', () => {
    const input = { endpoint: 'https://x/v1', profile: 'plan' };
    expect(migrateConfig({ ...input })).toEqual(migrateConfig({ ...input }));
  });

  it('an already-current v1 document is a no-op migration', () => {
    const result = migrateConfig({ version: 1, model: 'qwen3.7-max' });
    expect(result.fromVersion).toBe(1);
    expect(result.applied).toEqual([]);
    expect(result.config).toMatchObject({ version: 1, model: 'qwen3.7-max' });
  });
});

describe('unknown future version', () => {
  it('is a typed error, never a silent downgrade', () => {
    expect(() => migrateConfig({ version: 999 })).toThrow(UnknownConfigVersionError);
    try {
      migrateConfig({ version: 999 });
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownConfigVersionError);
      expect((err as UnknownConfigVersionError).version).toBe(999);
    }
  });
});
