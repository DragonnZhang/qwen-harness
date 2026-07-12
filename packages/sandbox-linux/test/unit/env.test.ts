/**
 * Environment minimization. The allowlist is positive: a variable the child sees is one we
 * deliberately passed. This test proves a secret in the parent environment does not survive into
 * the child's — the property the sandbox depends on for credential isolation.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ENV_ALLOWLIST, minimizeEnv } from '../../src/env.ts';

describe('minimizeEnv', () => {
  it('keeps only allowlisted names', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/dev',
      // A secret the child must never inherit. Named generically on purpose.
      SOME_API_TOKEN: 'sk-secret-value',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    };
    const child = minimizeEnv(parent);
    expect(child['PATH']).toBe('/usr/bin');
    expect(child).not.toHaveProperty('SOME_API_TOKEN');
    expect(child).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    // HOME is not on the default allowlist; it is set explicitly by the backend when needed.
    expect(child).not.toHaveProperty('HOME');
  });

  it('the default allowlist contains no credential-shaped name', () => {
    for (const name of DEFAULT_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
    }
  });

  it('applies overrides and always provides a PATH', () => {
    const child = minimizeEnv({}, { overrides: { HOME: '/qh/scratch' } });
    expect(child['HOME']).toBe('/qh/scratch');
    expect(child['PATH']).toBe('/usr/bin:/bin');
  });

  it('extra allowed names pass through by NAME, never by value', () => {
    const child = minimizeEnv({ CI: 'true', NOPE: 'x' }, { allow: ['CI'] });
    expect(child['CI']).toBe('true');
    expect(child).not.toHaveProperty('NOPE');
  });
});
