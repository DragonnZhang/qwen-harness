/**
 * Authority and its intersection.
 *
 * A child agent, a teammate, a background job, and a Cron fire all ask the same question: "how
 * much am I allowed to do?" The answer is always the same shape — the intersection of what was
 * REQUESTED, the ceiling the PARENT holds, and the current MANAGED policy. Never a union, never
 * the parent's authority verbatim, never "whatever the caller passed".
 *
 * `isAtMost` is the invariant `intersect` exists to satisfy. It is exported because it is not only
 * a test predicate: the runtime asserts it before handing authority to a child, so a future bug in
 * `intersect` becomes a crash at the boundary instead of a privilege escalation.
 */

import type { IsolationMode, PermissionProfile } from '@qwen-harness/protocol';
import { DEFAULT_ISOLATION, DEFAULT_NETWORK_ALLOWED } from '@qwen-harness/protocol';

import type { Grant } from './grants.ts';
import {
  ISOLATION_RANK,
  PROFILE_RANK,
  leastProfile,
  strictestIsolation,
  type ManagedPolicy,
} from './managed.ts';
import { isWithin } from './paths.ts';
import type { PolicyRule } from './rules.ts';

export interface Authority {
  readonly profile: PermissionProfile;
  readonly isolation: IsolationMode;
  readonly networkAllowed: boolean;
  /** Canonical absolute roots the holder may work in. */
  readonly workspaceRoots: readonly string[];
  readonly rules: readonly PolicyRule[];
  readonly grants: readonly Grant[];
  /** How many further levels of children this holder may create. */
  readonly maxChildDepth: number;
}

export function defaultAuthority(
  profile: PermissionProfile,
  workspaceRoot: string,
  managed: ManagedPolicy,
): Authority {
  const capped = leastProfile(profile, managed.maxProfile);
  return {
    profile: capped,
    isolation: strictestIsolation(DEFAULT_ISOLATION[capped], managed.maxIsolation),
    networkAllowed: DEFAULT_NETWORK_ALLOWED[capped] && managed.networkAllowed,
    workspaceRoots: [workspaceRoot],
    rules: [],
    grants: [],
    maxChildDepth: managed.maxChildDepth,
  };
}

const restrictiveRule = (rule: PolicyRule): boolean =>
  rule.effect === 'deny' || rule.effect === 'ask';

/**
 * The child gets: the least profile, the strictest isolation, network only if BOTH have it, only
 * workspace roots that sit inside a parent root, only allow-rules and grants the parent already
 * holds — and every restriction from either side, because a restriction is not authority and may
 * always be added.
 *
 * `maxChildDepth` decrements: a child of a child is one level further from the human who approved
 * any of this, so the budget must shrink or a recursion becomes unbounded.
 */
export function intersect(
  requested: Authority,
  parentCeiling: Authority,
  managed: ManagedPolicy,
): Authority {
  const profile = leastProfile(
    leastProfile(requested.profile, parentCeiling.profile),
    managed.maxProfile,
  );

  const isolation = strictestIsolation(
    strictestIsolation(requested.isolation, parentCeiling.isolation),
    managed.maxIsolation,
  );

  const parentAllowIds = new Set(
    parentCeiling.rules.filter((r) => r.effect === 'allow').map((r) => r.id),
  );
  const parentGrantIds = new Set(parentCeiling.grants.map((g) => g.id));

  // Restrictions from BOTH sides survive; allow-rules survive only if the parent already had them.
  const rules: PolicyRule[] = [
    ...parentCeiling.rules,
    ...requested.rules.filter(
      (rule) =>
        restrictiveRule(rule) ||
        (rule.effect === 'allow' &&
          parentAllowIds.has(rule.id) &&
          !parentCeiling.rules.some((p) => p.id === rule.id)),
    ),
  ];

  const requestedRoots =
    requested.workspaceRoots.length === 0 ? parentCeiling.workspaceRoots : requested.workspaceRoots;

  const workspaceRoots = requestedRoots.filter((root) =>
    parentCeiling.workspaceRoots.some((parentRoot) => isWithin(parentRoot, root)),
  );

  return {
    profile,
    isolation,
    networkAllowed:
      requested.networkAllowed && parentCeiling.networkAllowed && managed.networkAllowed,
    workspaceRoots,
    rules,
    grants: requested.grants.filter((grant) => parentGrantIds.has(grant.id)),
    maxChildDepth: Math.max(
      0,
      Math.min(requested.maxChildDepth, parentCeiling.maxChildDepth - 1, managed.maxChildDepth),
    ),
  };
}

export interface AuthorityViolation {
  readonly field: string;
  readonly detail: string;
}

/** Every way `child` could hold MORE than `parent`. Empty means the invariant holds. */
export function authorityViolations(
  child: Authority,
  parent: Authority,
): readonly AuthorityViolation[] {
  const violations: AuthorityViolation[] = [];

  if (PROFILE_RANK[child.profile] > PROFILE_RANK[parent.profile]) {
    violations.push({
      field: 'profile',
      detail: `${child.profile} is more permissive than ${parent.profile}`,
    });
  }
  if (ISOLATION_RANK[child.isolation] > ISOLATION_RANK[parent.isolation]) {
    violations.push({
      field: 'isolation',
      detail: `${child.isolation} is weaker than ${parent.isolation}`,
    });
  }
  if (child.networkAllowed && !parent.networkAllowed) {
    violations.push({ field: 'networkAllowed', detail: 'child has network, parent does not' });
  }
  for (const root of child.workspaceRoots) {
    if (!parent.workspaceRoots.some((parentRoot) => isWithin(parentRoot, root))) {
      violations.push({ field: 'workspaceRoots', detail: `${root} is outside every parent root` });
    }
  }
  const parentAllowIds = new Set(parent.rules.filter((r) => r.effect === 'allow').map((r) => r.id));
  for (const rule of child.rules) {
    if (rule.effect === 'allow' && !parentAllowIds.has(rule.id)) {
      violations.push({
        field: 'rules',
        detail: `allow-rule ${rule.id} is not held by the parent`,
      });
    }
  }
  const parentGrantIds = new Set(parent.grants.map((g) => g.id));
  for (const grant of child.grants) {
    if (!parentGrantIds.has(grant.id)) {
      violations.push({ field: 'grants', detail: `grant ${grant.id} is not held by the parent` });
    }
  }
  if (child.maxChildDepth > parent.maxChildDepth) {
    violations.push({ field: 'maxChildDepth', detail: 'child may recurse deeper than its parent' });
  }
  return violations;
}

export function isAtMost(child: Authority, parent: Authority): boolean {
  return authorityViolations(child, parent).length === 0;
}
