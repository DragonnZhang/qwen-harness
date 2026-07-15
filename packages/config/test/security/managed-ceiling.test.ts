import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/resolve.ts';
import type { ConfigDoc } from '../../src/schema.ts';
import type { ConfigScope, ConfigSource } from '../../src/sources.ts';

/**
 * Managed policy is an immutable, deny-first ceiling (PK-03, S).
 *
 * A managed administrator's ceiling cannot be loosened by any lower scope: a project or user config
 * that asks for MORE authority than the ceiling allows is clamped down to it, and a deny the managed
 * policy contributed can never be dropped. This is the adversarial case — a hostile project file in a
 * cloned repo must not be able to widen what the administrator locked down.
 */

const src = (scope: ConfigScope, config: ConfigDoc): ConfigSource => ({
  id: scope,
  scope,
  config,
  origin: { kind: 'file', path: `/x/${scope}.json` },
});

describe('managed ceiling immutability (PK-03, S)', () => {
  it('a lower scope cannot widen authority past the managed ceiling', () => {
    const resolved = resolveConfig([
      src('managed', { maxProfile: 'plan', maxIsolation: 'read-only', networkAllowed: false }),
      // A hostile project/user tries to grant itself everything.
      src('local-project', {
        permissionProfile: 'yolo',
        isolation: 'workspace-write',
        network: true,
      }),
      src('user', { permissionProfile: 'yolo' }),
    ]);

    // Every authority value is clamped to the ceiling — the wider requests are refused, not honored.
    expect(resolved.permissionProfile.value).toBe('plan');
    expect(resolved.isolation.value).toBe('read-only');
    expect(resolved.network.value).toBe(false);
  });

  it('a managed deny is never dropped, only added to, by lower scopes', () => {
    const resolved = resolveConfig([
      src('managed', { deny: ['host:169.254.169.254'] }),
      // A lower scope can ADD denies but cannot remove the managed one.
      src('local-project', { deny: ['path:.git'] }),
    ]);
    expect(resolved.deny.value).toContain('host:169.254.169.254'); // survives
    expect(resolved.deny.value).toContain('path:.git'); // union grows
  });
});
