import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { resolveConfig } from './resolve.ts';
import type { ConfigDoc } from './schema.ts';
import { OVERRIDE_RANK, type ConfigScope, type ConfigSource } from './sources.ts';

/**
 * Configuration precedence and deny-union as properties (PK-03).
 *
 * For ANY set of ordinary-scope sources, the highest-precedence scope that set a key wins and the
 * provenance names it — last-write-wins is exact, not approximate. And the security deny list is the
 * UNION across every scope: adding a scope can only ever grow it, so no scope can drop a deny another
 * contributed. Managed is proven elsewhere to never out-vote an ordinary value; here we pin the
 * ordinary ladder and the monotonic deny merge.
 */

const SCOPES = ['user', 'shared-project', 'local-project', 'env', 'cli'] as const;
const DENY_POOL = ['exec:/bin/rm', 'path:~/.ssh', 'host:169.254.169.254', 'path:.git'] as const;

const src = (scope: ConfigScope, config: ConfigDoc): ConfigSource => ({
  id: scope,
  scope,
  config,
  origin: { kind: 'file', path: `/x/${scope}.json` },
});

describe('config precedence (PK-03, P)', () => {
  it('the highest-precedence scope that set a key always wins, with matching provenance', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(...SCOPES), { minLength: 1 }), (scopes) => {
        const sources = scopes.map((s) => src(s, { model: `model-${s}` }));
        const resolved = resolveConfig(sources);
        const winner = scopes.reduce((a, b) => (OVERRIDE_RANK[a] >= OVERRIDE_RANK[b] ? a : b));
        expect(resolved.model.value).toBe(`model-${winner}`);
        expect(resolved.model.source.scope).toBe(winner);
      }),
      { numRuns: 300 },
    );
  });

  it('the deny list is the UNION across scopes — adding a scope never drops a deny', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            scope: fc.constantFrom(...SCOPES),
            deny: fc.uniqueArray(fc.constantFrom(...DENY_POOL), { maxLength: DENY_POOL.length }),
          }),
          { maxLength: SCOPES.length },
        ),
        (entries) => {
          // At most one source per scope (resolveConfig expects distinct scopes).
          const byScope = new Map(entries.map((e) => [e.scope, e.deny]));
          const sources = [...byScope].map(([scope, deny]) => src(scope, { deny }));
          const resolved = resolveConfig(sources);
          const expectedUnion = new Set([...byScope.values()].flat());
          expect(new Set(resolved.deny.value)).toEqual(expectedUnion);
        },
      ),
      { numRuns: 300 },
    );
  });
});
