/**
 * Inline vs forked skills: context, tools, budget, permission, and result semantics (IN-05).
 *
 * A skill is not a privilege. It is a body of text plus a declared, NARROWING set of tools. The one
 * invariant this file exists to enforce:
 *
 *      effective authority = requested ∩ parent ∩ managed        (never a union, ever)
 *
 * For the policy dimensions (profile, isolation, network, workspace roots, rules, grants) we do not
 * re-derive that — `@qwen-harness/policy`'s `intersect` already is that operation, and it is tested
 * there. We pass the PARENT's authority as the requested authority, which makes it structurally
 * impossible for a skill's frontmatter to ask for more: there is no field it could ask with.
 *
 * For tools, the intersection is here, because tools are the one dimension a skill DOES declare.
 * `allowed-tools: [a, b, c]` means "of the tools you already hold, I need only these". A tool the
 * parent does not hold is not granted — it is REPORTED in `denied`, so a misconfigured skill is
 * visible rather than mysteriously broken.
 *
 *   inline: runs in the PARENT's context and turn. Body is appended to the parent conversation;
 *           result is whatever the parent's own tool calls produce. Authority is the parent's,
 *           unchanged (an inline skill changes no permission — it is text). Tools narrow.
 *   forked: runs in a FRESH context with only the skill body and the invocation arguments. Its
 *           authority is `intersect(parent, parent, managed)` — i.e. the parent ceiling with the
 *           child-depth budget decremented — further narrowed to the declared tools. Only a SUMMARY
 *           returns to the parent, never the fork's raw transcript: a fork exists to keep an
 *           untrusted body's exploration out of the parent's context.
 */

import { intersect, type Authority, type ManagedPolicy } from '@qwen-harness/policy';

import type { SkillDescriptor } from './descriptor.ts';
import { SkillInvocationError } from './errors.ts';
import type { SkillContextMode } from './frontmatter.ts';

/** How the skill's body enters context. */
export type SkillContextDisposition = 'parent-context' | 'fresh-context';
/** What comes back to the parent when the skill finishes. */
export type SkillResultDisposition = 'appended-to-parent' | 'summary-to-parent';
/** How the skill's authority was derived. */
export type SkillPermissionDisposition = 'inherited-unchanged' | 'intersected-with-parent';

export interface SkillExecutionPlan {
  readonly skill: string;
  readonly mode: SkillContextMode;
  readonly context: SkillContextDisposition;
  readonly result: SkillResultDisposition;
  readonly permission: SkillPermissionDisposition;
  /** Effective tools. ALWAYS a subset of the parent's tools. Sorted, so the plan is comparable. */
  readonly tools: readonly string[];
  /** Tools the skill declared that the parent does not hold. Not granted; reported. */
  readonly denied: readonly string[];
  /** The effective authority for the skill's tool calls. Never broader than the parent's. */
  readonly authority: Authority;
  /** The loaded-content token budget this invocation may spend. */
  readonly budgetTokens: number;
  /** The model hint the skill asked for, or `null`. A HINT: the runtime may ignore it. */
  readonly modelHint: string | null;
}

export interface PlanSkillArgs {
  readonly descriptor: SkillDescriptor;
  /** The tools the caller currently holds. The ceiling for the skill's tools. */
  readonly parentTools: readonly string[];
  readonly parentAuthority: Authority;
  readonly managed: ManagedPolicy;
  /** Per-skill loaded-content token budget. */
  readonly budgetTokens: number;
}

/** The tool intersection, stated once. `null` declared tools means "inherit", not "everything". */
function intersectTools(
  parentTools: readonly string[],
  declared: readonly string[] | null,
): { tools: string[]; denied: string[] } {
  const parent = new Set(parentTools);
  if (declared === null) return { tools: [...parent].sort(), denied: [] };

  const tools: string[] = [];
  const denied: string[] = [];
  for (const tool of declared) {
    if (parent.has(tool)) tools.push(tool);
    else denied.push(tool);
  }
  return { tools: [...new Set(tools)].sort(), denied: [...new Set(denied)].sort() };
}

/**
 * Build the execution plan for one skill invocation.
 *
 * A fork consumes one level of child depth, so a parent that has none left cannot fork — that is a
 * typed refusal (`fork-depth-exhausted`), not a silent downgrade to inline. Silently running a
 * forked skill inline would put an untrusted body straight into the parent's context, which is the
 * precise thing the author of that skill asked us not to do.
 */
export function planSkillExecution(args: PlanSkillArgs): SkillExecutionPlan {
  const { descriptor, parentAuthority, managed } = args;
  const fm = descriptor.frontmatter;
  const { tools, denied } = intersectTools(args.parentTools, fm.allowedTools);

  if (fm.contextMode === 'inline') {
    return {
      skill: descriptor.name,
      mode: 'inline',
      context: 'parent-context',
      result: 'appended-to-parent',
      permission: 'inherited-unchanged',
      tools,
      denied,
      // An inline skill is text in the parent's turn. It gets the parent's authority verbatim —
      // it cannot narrow policy either, because policy is not the skill's to set; only its TOOLS
      // narrow. Anything else would let a repository file change a permission (SC-02 forbids it).
      authority: parentAuthority,
      budgetTokens: args.budgetTokens,
      modelHint: fm.modelHint,
    };
  }

  if (parentAuthority.maxChildDepth <= 0) {
    throw new SkillInvocationError(
      descriptor.name,
      'fork-depth-exhausted',
      'the caller holds no remaining child-depth budget, and a forked skill must not be silently downgraded to inline',
    );
  }

  // `intersect(requested, parentCeiling, managed)` with the parent as BOTH requested and ceiling:
  // the skill has no way to request more, and managed policy still applies on top.
  const authority = intersect(parentAuthority, parentAuthority, managed);

  return {
    skill: descriptor.name,
    mode: 'forked',
    context: 'fresh-context',
    result: 'summary-to-parent',
    permission: 'intersected-with-parent',
    tools,
    denied,
    authority,
    budgetTokens: args.budgetTokens,
    modelHint: fm.modelHint,
  };
}

/**
 * The assertion the runtime makes before it hands a plan to an executor. `intersect` is tested in
 * `policy`, but a future edit HERE could still hand out a tool the parent never had, so we prove it
 * at the boundary: a broadened plan becomes a crash, not a privilege escalation.
 */
export function assertPlanNeverBroadens(
  plan: SkillExecutionPlan,
  parentTools: readonly string[],
  parentAuthority: Authority,
): void {
  const parent = new Set(parentTools);
  for (const tool of plan.tools) {
    if (!parent.has(tool)) {
      throw new Error(
        `skill "${plan.skill}" plan contains tool "${tool}" the caller does not hold; authority may never broaden`,
      );
    }
  }
  if (plan.authority.maxChildDepth > parentAuthority.maxChildDepth) {
    throw new Error(
      `skill "${plan.skill}" plan raises maxChildDepth above the caller's; authority may never broaden`,
    );
  }
  if (plan.authority.networkAllowed && !parentAuthority.networkAllowed) {
    throw new Error(
      `skill "${plan.skill}" plan grants network the caller does not hold; authority may never broaden`,
    );
  }
}
