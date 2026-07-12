/**
 * Building a `PolicyContext`.
 *
 * The engine takes every input it needs explicitly — profile, ceiling, rules, grants, roots, home,
 * clock, actor — because a pure function with a hidden input is not a pure function. This is the
 * one place that assembles those inputs, so a caller cannot accidentally omit the managed ceiling
 * and get a permissive default: `managedPolicy` has no default here, it must be supplied.
 */

import { createHash } from 'node:crypto';

import type { Actor, PermissionProfile } from '@qwen-harness/protocol';

import type { PolicyContext, HookOutcome } from './engine.ts';
import type { Grant } from './grants.ts';
import type { ManagedPolicy } from './managed.ts';
import type { PolicyRule } from './rules.ts';

/** The content digest a `file-write` action binds its approval to. */
export function contentDigest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface PolicyContextInput {
  readonly profile: PermissionProfile;
  readonly managedPolicy: ManagedPolicy;
  readonly workspaceRoot: string;
  readonly homeDir: string;
  readonly now: number;
  readonly actor: Actor;
  readonly rules?: readonly PolicyRule[];
  readonly grants?: readonly Grant[];
  readonly hookOutcome?: HookOutcome | undefined;
}

export function policyContext(input: PolicyContextInput): PolicyContext {
  return {
    profile: input.profile,
    managedPolicy: input.managedPolicy,
    rules: input.rules ?? [],
    grants: input.grants ?? [],
    workspaceRoot: input.workspaceRoot,
    homeDir: input.homeDir,
    now: input.now,
    actor: input.actor,
    hookOutcome: input.hookOutcome,
  };
}
