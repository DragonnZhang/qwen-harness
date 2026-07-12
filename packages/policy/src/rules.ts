/**
 * Ordinary (non-managed) policy rules and the scope precedence between them.
 *
 * Two properties are load-bearing:
 *
 * 1. Security decisions merge DENY-FIRST across scopes (defaults.md, "Configuration precedence").
 *    Not last-write-wins: a user-level `allow` may not overwrite a project-level `deny`. The merge
 *    is a lattice join on restrictiveness — deny > ask > allow — so adding any source can only
 *    ever tighten the result.
 *
 * 2. Repository-controlled content cannot ADD authority (threat model, invariant 2). A `project`
 *    rule is checked into the repository and is therefore attacker-controlled in the
 *    malicious-repo threat model. Project rules may DENY or ASK; only scopes a human authored
 *    outside the repository (`user`, `local`, `session`) may ALLOW. This is enforced here, once,
 *    rather than trusted to every consumer.
 */

import type { NormalizedAction } from './action.ts';
import type { ActionMatcher, MatchContext } from './matcher.ts';
import { matchesAction } from './matcher.ts';

export type RuleEffect = 'allow' | 'deny' | 'ask' | 'passthrough';

/** Ordered from the least trusted authoring surface to the most trusted. */
export type RuleScope = 'project' | 'user' | 'local' | 'session';

export interface PolicyRule {
  readonly id: string;
  readonly scope: RuleScope;
  readonly effect: RuleEffect;
  readonly match: ActionMatcher;
  readonly reason: string;
}

/**
 * `project` is missing on purpose. A rule that lives in the repository is under the control of
 * whoever wrote the repository, which in the malicious-repo threat model is the attacker.
 */
export const SCOPES_THAT_MAY_ALLOW: readonly RuleScope[] = ['user', 'local', 'session'];

export function mayAllow(scope: RuleScope): boolean {
  return SCOPES_THAT_MAY_ALLOW.includes(scope);
}

export interface RuleMatch {
  readonly rule: PolicyRule;
  readonly effect: RuleEffect;
  /** Set when the rule's declared effect was downgraded (a project `allow` becoming a no-op). */
  readonly downgradedFrom: RuleEffect | null;
}

export interface RuleMerge {
  /** The merged effect, or null when no rule had an opinion. */
  readonly effect: Exclude<RuleEffect, 'passthrough'> | null;
  readonly winner: RuleMatch | null;
  readonly matches: readonly RuleMatch[];
}

const RESTRICTIVENESS: Record<Exclude<RuleEffect, 'passthrough'>, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Merge every matching rule deny-first. `passthrough` means "no opinion" and drops out; a project
 * `allow` is downgraded to `passthrough` (recorded, so `doctor` can explain why it did nothing).
 */
export function mergeRules(
  rules: readonly PolicyRule[],
  action: NormalizedAction,
  ctx: MatchContext,
  digest: string,
): RuleMerge {
  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    if (!matchesAction(rule.match, action, ctx, digest)) continue;
    if (rule.effect === 'allow' && !mayAllow(rule.scope)) {
      matches.push({ rule, effect: 'passthrough', downgradedFrom: 'allow' });
      continue;
    }
    matches.push({ rule, effect: rule.effect, downgradedFrom: null });
  }

  let winner: RuleMatch | null = null;
  for (const match of matches) {
    if (match.effect === 'passthrough') continue;
    if (winner === null || winner.effect === 'passthrough') {
      winner = match;
      continue;
    }
    const current = RESTRICTIVENESS[winner.effect];
    const candidate = RESTRICTIVENESS[match.effect];
    if (candidate > current) winner = match;
  }

  const effect = winner === null || winner.effect === 'passthrough' ? null : winner.effect;

  return { effect, winner: effect === null ? null : winner, matches };
}
