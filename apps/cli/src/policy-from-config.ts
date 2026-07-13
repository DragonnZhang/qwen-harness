import {
  loadCliSource,
  loadResolvedConfig,
  resolveConfig,
  type LoadOptions,
  type ResolvedConfig,
} from '@qwen-harness/config';
import { NO_MANAGED_RESTRICTIONS, type ManagedPolicy, type PolicyRule } from '@qwen-harness/policy';
import type { IsolationMode, PermissionProfile } from '@qwen-harness/protocol';

/**
 * The bridge from resolved configuration to the policy ceiling a run actually executes under.
 *
 * This file exists because of a real hole: `createHarnessRuntime` used to construct its
 * `PolicyContext` with `NO_MANAGED_RESTRICTIONS` and `rules: []`, unconditionally. The managed
 * ceiling logic in `@qwen-harness/policy` was correct and thoroughly tested — it was simply never
 * FED. `/etc/qwen-harness/managed.json` therefore constrained what `doctor` reported and nothing
 * about what a run was allowed to do. An administrator who deployed a managed policy would have
 * been told it was in force while the model ran unbounded by it. That is the single worst failure
 * mode this product can have, so the ceiling is now a REQUIRED input: `HarnessRuntimeOptions`
 * cannot be constructed without stating one, and "no restrictions" has to be typed out on purpose.
 *
 * Two invariants are preserved here and asserted in `test/security/managed-ceiling.test.ts`:
 *
 *  - **Deny is absolute.** `resolveConfig` already unions every scope's `deny` list (a higher scope
 *    can never remove a deny a lower one contributed). Those denies become MANAGED rules, not
 *    ordinary rules, because a managed rule cannot be lifted by a grant, an approval, or `yolo`.
 *  - **The ceiling only ever tightens.** `maxProfile` / `maxIsolation` / `networkAllowed` come from
 *    `resolveConfig`, which resolves each by taking the tightest value across all scopes with the
 *    `managed` scope unrelaxable. We pass them through; we never widen them.
 */

export interface RunAuthority {
  /** The ceiling. Intersected LAST by the policy engine; nothing may exceed it. */
  readonly managedPolicy: ManagedPolicy;
  /** Ordinary rules (deny-first). Currently the config's own deny list is hoisted into `managed`. */
  readonly rules: readonly PolicyRule[];
  /** Effective profile — already clamped to the ceiling by `resolveConfig`. */
  readonly profile: PermissionProfile;
  /** Effective isolation — already clamped. `disabled` genuinely means no sandbox (yolo). */
  readonly isolation: IsolationMode;
  readonly networkAllowed: boolean;
  readonly config: ResolvedConfig;
}

/**
 * Turn a resolved config into the authority a run executes under.
 *
 * Note what is NOT here: no profile is re-derived, no isolation is re-guessed. `resolveConfig` has
 * already applied precedence and clamped to the ceiling; re-deriving would be a second, divergent
 * implementation of the rule, and the two would eventually disagree. There must be exactly one.
 */
export function authorityFromConfig(resolved: ResolvedConfig): RunAuthority {
  const denies = resolved.deny.value;

  // The config deny list is a HARD deny: unliftable by grant, approval, or profile. Modelling it as
  // a managed rule is what makes that true — an ordinary rule could be outranked.
  const managedRules: ManagedPolicy['rules'] =
    denies.length === 0
      ? []
      : [
          {
            id: 'config.deny',
            effect: 'deny',
            match: { paths: [...denies] },
            reason:
              'denied by configuration; a deny is the union of every scope and can never be ' +
              'removed by a higher scope, a grant, or an approval',
          },
        ];

  const managedPolicy: ManagedPolicy = {
    version: 1,
    rules: managedRules,
    maxProfile: resolved.maxProfile.value,
    maxIsolation: resolved.maxIsolation.value,
    networkAllowed: resolved.networkAllowed.value,
    // Not a config key today. Taking the shipped default keeps child depth bounded rather than
    // unbounded, which is the safe direction when a value is unspecified.
    maxChildDepth: NO_MANAGED_RESTRICTIONS.maxChildDepth,
  };

  return {
    managedPolicy,
    rules: [],
    profile: resolved.permissionProfile.value,
    isolation: resolved.isolation.value,
    networkAllowed: resolved.network.value,
    config: resolved,
  };
}

/** Load configuration from disk/env/flags and derive the authority a run executes under. */
export function loadRunAuthority(options: LoadOptions): RunAuthority {
  return authorityFromConfig(loadResolvedConfig(options).resolved);
}

/**
 * The authority for a bare profile, with no config files in play — the "no administrator has
 * deployed a ceiling here" case.
 *
 * It goes through the REAL resolution path (`loadCliSource` → `resolveConfig` → `authorityFromConfig`)
 * rather than hand-assembling a `ManagedPolicy`. A test that builds the ceiling by hand is testing
 * its own fixture; this one exercises the same code a run does, so if resolution or clamping breaks,
 * these callers break too.
 */
export function authorityForProfile(profile: PermissionProfile): RunAuthority {
  return authorityFromConfig(resolveConfig([loadCliSource({ permissionProfile: profile })]));
}
