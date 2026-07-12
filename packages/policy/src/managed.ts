/**
 * Managed policy: the immutable safety ceiling.
 *
 * The ceiling is intersected LAST, after the profile, after repository and user rules, after
 * grants, and after hooks. That ordering is the whole design: it makes "managed hard deny
 * dominates every allow or hook outcome" (threat model, invariant 1) a structural property of the
 * evaluator rather than a rule someone has to remember to check. Nothing downstream of the
 * intersection can loosen it, because there IS nothing downstream of it.
 *
 * A managed policy can only ever remove authority. There is no managed `allow`: an administrator
 * who wants to permit something simply does not deny it. Adding a managed `allow` would create a
 * way for a ceiling to *raise* a floor, and every bypass in this class of system starts there.
 */

import type { IsolationMode, PermissionProfile } from '@qwen-harness/protocol';

import type { ActionMatcher } from './matcher.ts';
import { METADATA_HOSTS, PROTECTED_PATH_RULES } from './paths.ts';

export type ManagedEffect = 'deny' | 'ask';

export interface ManagedRule {
  readonly id: string;
  readonly effect: ManagedEffect;
  readonly match: ActionMatcher;
  readonly reason: string;
}

export interface ManagedPolicy {
  readonly version: number;
  readonly rules: readonly ManagedRule[];
  /** The most permissive profile any thread, child, or Cron job may run under. */
  readonly maxProfile: PermissionProfile;
  /** The weakest isolation permitted. `disabled` means the ceiling does not constrain isolation. */
  readonly maxIsolation: IsolationMode;
  /** When false, network is denied everywhere: no profile, rule, or grant can reach the network. */
  readonly networkAllowed: boolean;
  readonly maxChildDepth: number;
}

export const PROFILE_RANK: Record<PermissionProfile, number> = {
  plan: 0,
  ask: 1,
  'auto-accept-edits': 2,
  yolo: 3,
};

/** `read-only` is the strictest; `disabled` is no isolation at all. */
export const ISOLATION_RANK: Record<IsolationMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  disabled: 2,
};

export function leastProfile(a: PermissionProfile, b: PermissionProfile): PermissionProfile {
  return PROFILE_RANK[a] <= PROFILE_RANK[b] ? a : b;
}

export function strictestIsolation(a: IsolationMode, b: IsolationMode): IsolationMode {
  return ISOLATION_RANK[a] <= ISOLATION_RANK[b] ? a : b;
}

/**
 * The ceiling an unmanaged installation runs under: it constrains nothing, so `yolo` really does
 * mean "maximum host authority". This is the honest default — pretending an unmanaged install has
 * a ceiling it does not have would be the more dangerous lie.
 */
export const NO_MANAGED_RESTRICTIONS: ManagedPolicy = {
  version: 1,
  rules: [],
  maxProfile: 'yolo',
  maxIsolation: 'disabled',
  networkAllowed: true,
  maxChildDepth: 2,
};

const CREDENTIAL_STORE_PATTERNS = PROTECTED_PATH_RULES.filter(
  (rule) => rule.class === 'user-credential-store' || rule.class === 'daemon-socket',
).flatMap((rule) => rule.patterns);

/**
 * What an administrator should actually deploy. Hard-denies the things that no approval, no
 * profile, and no `yolo` should ever reach: the user's credential stores, container/daemon sockets
 * (root-equivalent), and the cloud instance-metadata endpoint.
 *
 * NOTE the `~` in these patterns is expanded by the engine against the context's home directory,
 * exactly like a protected-path pattern — managed rules read no environment either.
 */
export const RECOMMENDED_MANAGED_POLICY: ManagedPolicy = {
  version: 1,
  rules: [
    {
      id: 'managed.credential-stores',
      effect: 'deny',
      match: { paths: CREDENTIAL_STORE_PATTERNS },
      reason: 'credential stores and daemon sockets are never reachable, in any profile',
    },
    {
      id: 'managed.cloud-metadata',
      effect: 'deny',
      match: { hosts: [...METADATA_HOSTS, '169.254.*'] },
      reason: 'the cloud instance-metadata endpoint hands out instance credentials',
    },
  ],
  maxProfile: 'yolo',
  maxIsolation: 'disabled',
  networkAllowed: true,
  maxChildDepth: 2,
};

/**
 * Combine two ceilings. Denies UNION (both apply); permissions take the minimum. Used when a
 * durable job's captured creation-time ceiling meets the current managed policy at fire time
 * (defaults.md, "Cron defaults"): the job gets the intersection, never the newer or the older.
 */
export function intersectManaged(a: ManagedPolicy, b: ManagedPolicy): ManagedPolicy {
  const seen = new Set<string>();
  const rules: ManagedRule[] = [];
  for (const rule of [...a.rules, ...b.rules]) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    rules.push(rule);
  }
  return {
    version: Math.max(a.version, b.version),
    rules,
    maxProfile: leastProfile(a.maxProfile, b.maxProfile),
    maxIsolation: strictestIsolation(a.maxIsolation, b.maxIsolation),
    networkAllowed: a.networkAllowed && b.networkAllowed,
    maxChildDepth: Math.min(a.maxChildDepth, b.maxChildDepth),
  };
}
