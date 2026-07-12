/**
 * Approval grants: what a human said yes to, and exactly how far that yes reaches.
 *
 * A grant binds to `actionDigest(action)`. Not to a tool name, not to a path prefix, not to a
 * "similar" call. If the model changes one byte of the content it is writing, the digest changes
 * and the previous approval does not authorize it. That property is what makes
 * "approval binds to complete canonical parameters" (threat model, invariant 4) true by
 * construction instead of by vigilance.
 *
 * The one scope that is not digest-bound is `rule`: the user explicitly asked for a NARROW rule
 * ("always allow `npm test` in this repo"). Rule grants are validated (`validateRuleGrant`) before
 * they may be stored, and they can never reach a protected path — the engine only consults them
 * when the action is not protected.
 *
 * Everything here is pure. Expiry compares against a `now` the caller supplies; there is no clock
 * in this package, so a grant can never expire differently in two places.
 */

import type { NormalizedAction } from './action.ts';
import type { ActionMatcher, MatchContext } from './matcher.ts';
import { isEmptyMatcher, matchesAction } from './matcher.ts';
import { classifyPath, isWithin, type ProtectedLookupContext } from './paths.ts';

export type GrantScope = 'once' | 'session' | 'rule';

export interface Grant {
  readonly id: string;
  readonly scope: GrantScope;
  /** Required for `once` and `session`. Null only for `rule`. */
  readonly actionDigest: string | null;
  /** Required for `rule`. Null otherwise. */
  readonly match: ActionMatcher | null;
  readonly grantedAt: number;
  /** Epoch ms. Null = no expiry (session grants die with the session, which the caller owns). */
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  /** A `once` grant is spent after it authorizes one action. */
  readonly usedAt: number | null;
  readonly grantedBy: string;
  readonly reason: string;
}

export type GrantRejection =
  | 'expired'
  | 'revoked'
  | 'already-used'
  | 'no-match'
  | 'scope-not-allowed-here';

export interface GrantLookup {
  readonly grant: Grant | null;
  /** Grants that matched the action but were not usable, with the reason. For `doctor`. */
  readonly rejected: readonly { readonly grant: Grant; readonly reason: GrantRejection }[];
}

export function isGrantLive(grant: Grant, now: number): GrantRejection | null {
  if (grant.revokedAt !== null && grant.revokedAt <= now) return 'revoked';
  if (grant.expiresAt !== null && now >= grant.expiresAt) return 'expired';
  if (grant.scope === 'once' && grant.usedAt !== null) return 'already-used';
  return null;
}

export interface GrantLookupOptions extends MatchContext {
  /**
   * The action is protected, so ONLY an exact digest-bound grant may authorize it. A narrow rule
   * grant — however carefully written — never reaches a protected path.
   */
  readonly exactOnly: boolean;
  readonly now: number;
}

export function findGrant(
  grants: readonly Grant[],
  action: NormalizedAction,
  digest: string,
  options: GrantLookupOptions,
): GrantLookup {
  const rejected: { grant: Grant; reason: GrantRejection }[] = [];

  for (const grant of grants) {
    const matched =
      grant.scope === 'rule'
        ? grant.match !== null && matchesAction(grant.match, action, options, digest)
        : grant.actionDigest === digest;

    if (!matched) continue;

    if (options.exactOnly && grant.scope === 'rule') {
      rejected.push({ grant, reason: 'scope-not-allowed-here' });
      continue;
    }

    const dead = isGrantLive(grant, options.now);
    if (dead !== null) {
      rejected.push({ grant, reason: dead });
      continue;
    }
    return { grant, rejected };
  }

  return { grant: null, rejected };
}

/** Spend a `once` grant. Immutable: returns a new array, so an audit log can keep both versions. */
export function consumeGrant(grants: readonly Grant[], id: string, now: number): readonly Grant[] {
  return grants.map((g) => (g.id === id && g.scope === 'once' ? { ...g, usedAt: now } : g));
}

export function revokeGrant(grants: readonly Grant[], id: string, now: number): readonly Grant[] {
  return grants.map((g) => (g.id === id ? { ...g, revokedAt: now } : g));
}

export type RuleGrantProblem =
  | 'not-a-rule-grant'
  | 'empty-matcher'
  | 'missing-kinds'
  | 'path-outside-workspace'
  | 'path-is-protected'
  | 'unbounded-path-glob';

export interface RuleGrantValidation {
  readonly ok: boolean;
  readonly problems: readonly RuleGrantProblem[];
}

/**
 * A rule grant is the only grant that is not digest-bound, so it is the only one that can be too
 * broad. Validate it at the moment it is created, not at the moment it is used: an over-broad rule
 * that was never storable can never be exploited later.
 *
 * Requirements: it must name the action kinds, every path glob must be anchored inside the
 * workspace, and no path glob may reach a protected path.
 */
export function validateRuleGrant(grant: Grant, ctx: ProtectedLookupContext): RuleGrantValidation {
  const problems: RuleGrantProblem[] = [];
  if (grant.scope !== 'rule' || grant.match === null) {
    return { ok: false, problems: ['not-a-rule-grant'] };
  }
  const match = grant.match;
  if (isEmptyMatcher(match)) problems.push('empty-matcher');
  if (match.kinds === undefined || match.kinds.length === 0) problems.push('missing-kinds');

  for (const pattern of match.paths ?? []) {
    if (!pattern.startsWith('/')) {
      problems.push('unbounded-path-glob');
      continue;
    }
    // The literal prefix before the first wildcard is the only part we can reason about
    // statically; everything after it is attacker-shaped. Require that prefix to be inside the
    // workspace, so no glob can be steered out of it.
    const wildcard = pattern.search(/[*?]/);
    const literal = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
    const anchor = literal.endsWith('/') ? literal.slice(0, -1) : literal;
    if (anchor.length === 0 || !isWithin(ctx.workspaceRoot, anchor)) {
      problems.push('path-outside-workspace');
      continue;
    }
    if (
      classifyPath(anchor, 'write', ctx).length > 0 ||
      classifyPath(anchor, 'read', ctx).length > 0
    ) {
      problems.push('path-is-protected');
    }
  }

  return { ok: problems.length === 0, problems };
}
