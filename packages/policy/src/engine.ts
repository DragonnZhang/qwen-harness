/**
 * The deny-by-default permission engine.
 *
 * Evaluation is a pipeline of stages, and the ORDER is the security property:
 *
 *   0  input validation   a non-canonical action is DENIED, never asked about
 *   1  profile            what this profile makes available at all
 *   2  protected paths    overrides the profile; can SEAL a verdict against later loosening
 *   3  rules              deny-first merge; repository-scoped rules may never ALLOW
 *   4  grants             an exact approval (or a validated narrow rule) can turn ask -> allow
 *   5  hooks              a hook may RESTRICT; a hook `allow` is recorded and ignored
 *   6  managed policy     the immutable ceiling, intersected LAST — nothing runs after it
 *   7  user passthrough   a direct `!command` skips the model-approval gate, nothing else
 *
 * Two mechanisms carry the invariants:
 *
 *   `sealed`         — no later stage may LOOSEN this verdict. Set by `plan` (mutations are
 *                      unavailable, not askable) and by protected paths. This is what makes
 *                      "plan cannot be smuggled through shell/hooks/MCP" true: there is no code
 *                      path from a sealed deny back to an allow.
 *   `exactGrantOnly` — the verdict may only be loosened by a digest-bound grant, i.e. by a human
 *                      approving THIS EXACT action. Broad rules and rule-grants cannot reach it.
 *
 * Every stage appends to `trace`, so `doctor` can print exactly which rule, grant, or ceiling won
 * and why (PS-07). A decision that cannot be explained is a decision nobody can audit.
 */

import type { Actor, PermissionProfile } from '@qwen-harness/protocol';

import type { NormalizedAction } from './action.ts';
import {
  actionDigest,
  actionPaths,
  checkCanonicalAction,
  describeAction,
  isSideEffect,
  isWriteAction,
} from './action.ts';
import type { Grant } from './grants.ts';
import { findGrant } from './grants.ts';
import type { ManagedPolicy } from './managed.ts';
import { matchesAction } from './matcher.ts';
import {
  classifyPath,
  isMetadataHost,
  isWithin,
  sensitiveEditReason,
  type ProtectedMatch,
} from './paths.ts';
import type { PolicyRule } from './rules.ts';
import { mergeRules } from './rules.ts';

export type DecisionOutcome = 'allow' | 'deny' | 'ask' | 'passthrough';

/**
 * What a hook said about this action. A hook may restrict or annotate. It may NEVER elevate:
 * `allow` from a hook is recorded in the trace and has no effect (task.md, boundary 7).
 */
export type HookOutcome = 'allow' | 'deny' | 'ask' | 'passthrough';

export type DecisionStage =
  | 'input-validation'
  | 'profile'
  | 'protected-path'
  | 'rule'
  | 'grant'
  | 'hook'
  | 'managed'
  | 'user-passthrough';

export interface DecisionSource {
  readonly stage: DecisionStage;
  /** Rule id, grant id, protected-path rule id, or the profile name. */
  readonly id: string;
}

export interface DecisionStep {
  readonly stage: DecisionStage;
  readonly id: string;
  readonly effect: DecisionOutcome | 'no-opinion';
  readonly note: string;
}

export interface PolicyDecision {
  readonly outcome: DecisionOutcome;
  readonly reason: string;
  readonly source: DecisionSource;
  /** The identity an approval must bind to. Also the audit key for the side effect. */
  readonly actionDigest: string;
  /** Human-readable form of the action; this is the text an approval dialog must show. */
  readonly description: string;
  /** Protected-path classifications that applied, for risk display. */
  readonly protectedMatches: readonly ProtectedMatch[];
  /** Every stage, in order. `doctor` prints this verbatim (PS-07). */
  readonly trace: readonly DecisionStep[];
}

export interface PolicyContext {
  readonly profile: PermissionProfile;
  readonly managedPolicy: ManagedPolicy;
  readonly rules: readonly PolicyRule[];
  readonly grants: readonly Grant[];
  /** Canonical absolute workspace root. */
  readonly workspaceRoot: string;
  /** Canonical absolute home directory. Supplied, never read from the environment. */
  readonly homeDir: string;
  /** Epoch ms, injected. Grant expiry is evaluated against this and nothing else. */
  readonly now: number;
  readonly actor: Actor;
  /** The outcome a hook already produced for this action, if any. */
  readonly hookOutcome?: HookOutcome | undefined;
}

interface Verdict {
  effect: Exclude<DecisionOutcome, 'passthrough'>;
  /** No later stage may loosen this. */
  sealed: boolean;
  /** Only a digest-bound grant may loosen this. */
  exactGrantOnly: boolean;
  source: DecisionSource;
  reason: string;
}

const RESTRICTIVENESS: Record<Exclude<DecisionOutcome, 'passthrough'>, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export class PolicyEngine {
  evaluate(action: NormalizedAction, ctx: PolicyContext): PolicyDecision {
    const digest = actionDigest(action);
    const trace: DecisionStep[] = [];
    const description = describeAction(action);

    // --- stage 0: input validation --------------------------------------------------------
    const canonicality = checkCanonicalAction(action);
    if (canonicality.length > 0) {
      const detail = canonicality.map((f) => `${f.path || '<none>'}: ${f.why}`).join('; ');
      trace.push({
        stage: 'input-validation',
        id: 'canonical-action',
        effect: 'deny',
        note: detail,
      });
      return {
        outcome: 'deny',
        reason: `action is not canonical (${detail})`,
        source: { stage: 'input-validation', id: 'canonical-action' },
        actionDigest: digest,
        description,
        protectedMatches: [],
        trace,
      };
    }
    trace.push({
      stage: 'input-validation',
      id: 'canonical-action',
      effect: 'no-opinion',
      note: 'action is canonical',
    });

    // --- stage 1: profile -----------------------------------------------------------------
    let verdict = this.#profileStage(action, ctx);
    trace.push({
      stage: 'profile',
      id: verdict.source.id,
      effect: verdict.effect,
      note: verdict.reason,
    });

    // --- stage 2: protected paths ---------------------------------------------------------
    const protectedMatches = this.#protectedMatches(action, ctx);
    if (protectedMatches.length > 0) {
      const first = protectedMatches[0] as ProtectedMatch;
      const summary = protectedMatches.map((m) => `${m.ruleId} (${m.class})`).join(', ');
      const protectedVerdict = this.#protectedStage(ctx.profile, first, summary);
      // A protected path can only ever TIGHTEN, except under `yolo`, where the profile already
      // said allow and the managed ceiling is the only thing left that may object.
      if (
        ctx.profile === 'yolo' ||
        RESTRICTIVENESS[protectedVerdict.effect] >= RESTRICTIVENESS[verdict.effect]
      ) {
        verdict = protectedVerdict;
      } else {
        verdict = { ...verdict, sealed: true };
      }
      trace.push({
        stage: 'protected-path',
        id: first.ruleId,
        effect: verdict.effect,
        note: `${summary}: ${first.why}`,
      });
    }

    // --- stage 3: rules -------------------------------------------------------------------
    const merged = mergeRules(ctx.rules, action, { homeDir: ctx.homeDir }, digest);
    for (const match of merged.matches) {
      if (match.downgradedFrom !== null) {
        trace.push({
          stage: 'rule',
          id: match.rule.id,
          effect: 'no-opinion',
          note: `scope '${match.rule.scope}' may not allow; repository content cannot add authority`,
        });
      }
    }
    if (merged.effect !== null && merged.winner !== null) {
      const rule = merged.winner.rule;
      const tightens = RESTRICTIVENESS[merged.effect] > RESTRICTIVENESS[verdict.effect];
      if (tightens) {
        verdict = {
          effect: merged.effect,
          sealed: merged.effect === 'deny',
          exactGrantOnly: verdict.exactGrantOnly,
          source: { stage: 'rule', id: rule.id },
          reason: rule.reason,
        };
        trace.push({ stage: 'rule', id: rule.id, effect: merged.effect, note: rule.reason });
      } else if (verdict.sealed || verdict.exactGrantOnly) {
        trace.push({
          stage: 'rule',
          id: rule.id,
          effect: 'no-opinion',
          note: verdict.exactGrantOnly
            ? 'protected path: only an exact approval can loosen this, not a rule'
            : 'verdict is sealed; a rule cannot loosen it',
        });
      } else if (merged.effect === 'allow' && verdict.effect === 'ask') {
        verdict = {
          effect: 'allow',
          sealed: false,
          exactGrantOnly: false,
          source: { stage: 'rule', id: rule.id },
          reason: rule.reason,
        };
        trace.push({ stage: 'rule', id: rule.id, effect: 'allow', note: rule.reason });
      } else {
        trace.push({
          stage: 'rule',
          id: rule.id,
          effect: 'no-opinion',
          note: 'the profile verdict is already at least this restrictive',
        });
      }
    }

    // --- stage 4: grants ------------------------------------------------------------------
    if (verdict.effect === 'ask') {
      const lookup = findGrant(ctx.grants, action, digest, {
        exactOnly: verdict.exactGrantOnly,
        now: ctx.now,
        homeDir: ctx.homeDir,
      });
      for (const rejection of lookup.rejected) {
        trace.push({
          stage: 'grant',
          id: rejection.grant.id,
          effect: 'no-opinion',
          note: `matched but unusable: ${rejection.reason}`,
        });
      }
      if (lookup.grant !== null) {
        verdict = {
          effect: 'allow',
          sealed: false,
          exactGrantOnly: false,
          source: { stage: 'grant', id: lookup.grant.id },
          reason: `granted (${lookup.grant.scope}): ${lookup.grant.reason}`,
        };
        trace.push({
          stage: 'grant',
          id: lookup.grant.id,
          effect: 'allow',
          note: `scope ${lookup.grant.scope}, granted by ${lookup.grant.grantedBy}`,
        });
      }
    } else if (ctx.grants.length > 0) {
      trace.push({
        stage: 'grant',
        id: 'grants',
        effect: 'no-opinion',
        note:
          verdict.effect === 'deny'
            ? 'a grant cannot authorize a denied action'
            : 'no approval needed',
      });
    }

    // --- stage 5: hooks -------------------------------------------------------------------
    if (ctx.hookOutcome !== undefined && ctx.hookOutcome !== 'passthrough') {
      const hook = ctx.hookOutcome;
      if (hook === 'allow') {
        trace.push({
          stage: 'hook',
          id: 'hook',
          effect: 'no-opinion',
          note: 'a hook allow never elevates permission; policy decides',
        });
      } else if (RESTRICTIVENESS[hook] > RESTRICTIVENESS[verdict.effect]) {
        verdict = {
          effect: hook,
          sealed: hook === 'deny',
          exactGrantOnly: verdict.exactGrantOnly,
          source: { stage: 'hook', id: 'hook' },
          reason: `a hook restricted this action to '${hook}'`,
        };
        trace.push({ stage: 'hook', id: 'hook', effect: hook, note: 'hook restricted the action' });
      } else {
        trace.push({
          stage: 'hook',
          id: 'hook',
          effect: 'no-opinion',
          note: 'policy is already at least this restrictive',
        });
      }
    }

    // --- stage 6: the managed ceiling, LAST -----------------------------------------------
    let managedForcedAsk = false;
    if (action.kind === 'network' && !ctx.managedPolicy.networkAllowed) {
      verdict = {
        effect: 'deny',
        sealed: true,
        exactGrantOnly: false,
        source: { stage: 'managed', id: 'managed.network-disabled' },
        reason: 'managed policy disables network access entirely',
      };
      trace.push({
        stage: 'managed',
        id: 'managed.network-disabled',
        effect: 'deny',
        note: 'managed ceiling: network is off',
      });
    }
    for (const rule of ctx.managedPolicy.rules) {
      if (!matchesAction(rule.match, action, { homeDir: ctx.homeDir }, digest)) continue;
      if (rule.effect === 'deny') {
        verdict = {
          effect: 'deny',
          sealed: true,
          exactGrantOnly: false,
          source: { stage: 'managed', id: rule.id },
          reason: rule.reason,
        };
        trace.push({ stage: 'managed', id: rule.id, effect: 'deny', note: rule.reason });
        break;
      }
      // A managed `ask` outranks even `yolo`'s no-prompt promise: the ceiling is not something a
      // profile gets to opt out of.
      if (verdict.effect === 'allow') {
        verdict = {
          effect: 'ask',
          sealed: false,
          exactGrantOnly: true,
          source: { stage: 'managed', id: rule.id },
          reason: rule.reason,
        };
        managedForcedAsk = true;
        trace.push({ stage: 'managed', id: rule.id, effect: 'ask', note: rule.reason });
      }
    }

    // --- stage 7: direct user action ------------------------------------------------------
    //
    // `!command` is the user acting, not the model. It does not go through the model-approval gate
    // (defaults.md, "TUI behavior defaults"), but everything above still ran: a managed deny, a
    // protected path, or a deny-rule stops it exactly as it would stop the model. Only a verdict
    // the PROFILE stage produced may become a passthrough.
    if (
      ctx.actor.kind === 'user' &&
      verdict.effect === 'allow' &&
      !verdict.sealed &&
      !managedForcedAsk &&
      verdict.source.stage === 'profile'
    ) {
      trace.push({
        stage: 'user-passthrough',
        id: ctx.actor.id,
        effect: 'passthrough',
        note: 'direct user action: no model-approval gate; isolation, audit and redaction still apply',
      });
      return {
        outcome: 'passthrough',
        reason: 'direct user action',
        source: { stage: 'user-passthrough', id: ctx.actor.id },
        actionDigest: digest,
        description,
        protectedMatches,
        trace,
      };
    }

    return {
      outcome: verdict.effect,
      reason: verdict.reason,
      source: verdict.source,
      actionDigest: digest,
      description,
      protectedMatches,
      trace,
    };
  }

  // -------------------------------------------------------------------------------------------

  #profileStage(action: NormalizedAction, ctx: PolicyContext): Verdict {
    const profile = ctx.profile;
    const id = `profile:${profile}`;

    // The user acting directly is not the model asking for permission. The profile's PROMPT
    // behavior is about the agent; a human typing a command does not prompt themselves.
    if (ctx.actor.kind === 'user') {
      return {
        effect: 'allow',
        sealed: false,
        exactGrantOnly: false,
        source: { stage: 'profile', id },
        reason: 'direct user action; the profile prompt gate applies to the agent, not the user',
      };
    }

    if (!isSideEffect(action)) {
      return {
        effect: 'allow',
        sealed: false,
        exactGrantOnly: false,
        source: { stage: 'profile', id },
        reason: 'read/search/analysis is available in every profile',
      };
    }

    if (profile === 'plan') {
      return {
        effect: 'deny',
        // SEALED. In `plan` a mutation is UNAVAILABLE, not "ask". No rule, grant, hook, MCP
        // server, subagent, or shell interpreter downstream of here can turn it back on.
        sealed: true,
        exactGrantOnly: false,
        source: { stage: 'profile', id },
        reason: `'${action.kind}' is unavailable in plan: plan exposes read, search and analysis only`,
      };
    }

    if (profile === 'yolo') {
      return {
        effect: 'allow',
        sealed: false,
        exactGrantOnly: false,
        source: { stage: 'profile', id },
        reason: 'yolo: no interactive prompts; the managed ceiling still applies',
      };
    }

    if (profile === 'auto-accept-edits') {
      const autoAllowed = this.#autoAcceptEditsAllows(action, ctx);
      if (autoAllowed.ok) {
        return {
          effect: 'allow',
          sealed: false,
          exactGrantOnly: false,
          source: { stage: 'profile', id },
          reason: 'dedicated workspace file tool inside the workspace root',
        };
      }
      return {
        effect: 'ask',
        sealed: false,
        exactGrantOnly: false,
        source: { stage: 'profile', id },
        reason: autoAllowed.why,
      };
    }

    return {
      effect: 'ask',
      sealed: false,
      exactGrantOnly: false,
      source: { stage: 'profile', id },
      reason: 'ask: every side effect prompts with its exact normalized parameters',
    };
  }

  /**
   * `auto-accept-edits` auto-allows ONE thing: a dedicated workspace FILE tool writing an ordinary
   * file inside the workspace. Everything else — shell (including `mkdir`, `mv`, `cp`, which this
   * product deliberately keeps in the ask path), network, external paths, MCP side effects,
   * destructive Git, and edits to executables/package manifests/Git hooks — still asks.
   */
  #autoAcceptEditsAllows(
    action: NormalizedAction,
    ctx: PolicyContext,
  ): { ok: true } | { ok: false; why: string } {
    if (action.kind === 'shell') {
      return {
        ok: false,
        why: 'shell commands always ask in auto-accept-edits, including mkdir, mv and cp',
      };
    }
    if (action.kind === 'network') {
      return { ok: false, why: 'network access always asks in auto-accept-edits' };
    }
    if (action.kind === 'git-write') {
      return {
        ok: false,
        why: action.destructive
          ? 'destructive Git always asks'
          : 'Git writes always ask in auto-accept-edits',
      };
    }
    if (action.kind === 'mcp') {
      return { ok: false, why: 'MCP side effects always ask in auto-accept-edits' };
    }

    // file-write / file-edit / patch
    const paths = actionPaths(action);
    for (const path of paths) {
      if (!isWithin(ctx.workspaceRoot, path)) {
        return { ok: false, why: `${path} is outside the workspace root; external paths ask` };
      }
    }
    const executable =
      action.kind === 'file-write' || action.kind === 'file-edit' || action.kind === 'patch'
        ? action.createsExecutable
        : false;
    for (const path of paths) {
      const reason = sensitiveEditReason(path, executable);
      if (reason !== null) {
        return { ok: false, why: `${path} is a ${reason}; it still asks in auto-accept-edits` };
      }
    }
    return { ok: true };
  }

  #protectedMatches(action: NormalizedAction, ctx: PolicyContext): readonly ProtectedMatch[] {
    const matches: ProtectedMatch[] = [];

    if (action.kind === 'network' && isMetadataHost(action.host)) {
      matches.push({
        ruleId: 'cloud-metadata-endpoint',
        class: 'metadata-endpoint',
        pattern: action.host,
        target: action.url,
        why: 'the cloud instance-metadata endpoint hands out instance credentials',
      });
    }

    // `git-read` is the dedicated validated Git tool: it exposes a SAFE PROJECTION (status, diff,
    // log), never arbitrary `.git` file content, so it does not trip the `.git/**` rule. A
    // `git-write` goes through the same validated tool, which is the documented exception to the
    // `.git/**` write protection.
    if (action.kind === 'git-read' || action.kind === 'git-write') return matches;

    const access = isWriteAction(action) ? 'write' : 'read';
    for (const path of actionPaths(action)) {
      matches.push(
        ...classifyPath(path, access, {
          workspaceRoot: ctx.workspaceRoot,
          homeDir: ctx.homeDir,
        }),
      );
    }

    // A shell command's declared cwd is not the thing it will touch. Its real reach is bounded by
    // the sandbox, not by this list — which is why shell never auto-allows outside `yolo`.
    return matches;
  }

  #protectedStage(profile: PermissionProfile, first: ProtectedMatch, summary: string): Verdict {
    const source: DecisionSource = { stage: 'protected-path', id: first.ruleId };
    if (profile === 'plan') {
      return {
        effect: 'deny',
        sealed: true,
        exactGrantOnly: false,
        source,
        reason: `plan denies protected access: ${summary}`,
      };
    }
    if (profile === 'yolo') {
      return {
        effect: 'allow',
        sealed: false,
        exactGrantOnly: false,
        source,
        reason: `yolo: ${summary} is reachable unless managed policy denies it`,
      };
    }
    return {
      effect: 'ask',
      sealed: true,
      exactGrantOnly: true,
      source,
      reason: `${summary} requires an exact approval for this specific action`,
    };
  }
}

/** The engine is stateless. One shared instance is safe and avoids allocating per evaluation. */
export const policyEngine = new PolicyEngine();
