import {
  DEFAULT_SUBAGENT_LIMITS,
  SubagentSupervisor,
  type SubagentBudgetLimits,
  type SubagentRunner,
  type SubagentSpec,
} from '@qwen-harness/agents';
import { isAtMost, type Authority } from '@qwen-harness/policy';
import type { PolicyEngine, PolicyContext } from '@qwen-harness/policy';
import type { Actor, ActorId, CorrelationId, ThreadId } from '@qwen-harness/protocol';
import type { ModelProvider } from '@qwen-harness/provider-core';
import { DEFAULT_BUDGET, type BudgetLimits } from '@qwen-harness/runtime';
import type { EventStore } from '@qwen-harness/storage';
import type { BuiltinTool } from '@qwen-harness/tools-builtin';

import type { FireHook } from './hooks.ts';
import type { DelegatePort } from './in-process-tools.ts';
import { headlessUserInteraction, inProcessSurface } from './in-process-tools.ts';
import type { RunAuthority } from './policy-from-config.ts';
import { reconstructHistory } from './sessions.ts';
import { createHarnessRuntime } from './wiring.ts';

/**
 * The production `delegate` mechanism (AG-02): a `delegate` tool call spawns a REAL subagent — a
 * nested `TurnEngine` running one bounded turn under a child authority the supervisor intersected
 * down — and returns only its bounded CONCLUSION to the parent.
 *
 * Two invariants are load-bearing here and neither is a promise, both are structural:
 *
 *   - **A child never exceeds its parent.** The child's authority is the `SubagentSupervisor`'s
 *     intersected result (requested ∩ parent-ceiling ∩ managed), which the supervisor itself asserts
 *     `isAtMost` the parent. We build the child `RunAuthority` from THAT intersected authority for
 *     profile/isolation/network/rules, and inherit the parent's managed ceiling and config verbatim —
 *     the ceiling can only tighten, never widen (a redundant `isAtMost` check fails closed if the
 *     intersection ever regressed).
 *   - **Depth is bounded.** The child's supervisor is `parent.childSupervisor(authority)` (depth+1),
 *     and a child only receives its OWN `delegate` tool when its depth is still below `maxDepth`; the
 *     supervisor's depth-exceeded guard is the backstop even if that choice were wrong.
 */

const MODEL_ACTOR: Actor = { kind: 'model', id: 'act_model1' as ActorId };
const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'act_system' as ActorId };

/** A child gets a slice of the parent's budget, never the whole thing (AG-02). */
const CHILD_BUDGET_FRACTION = 0.5;
/** A floor so a child always gets at least a couple of model rounds to do useful work. */
const MIN_CHILD_MODEL_CALLS = 4;

/**
 * The building blocks needed to construct a CHILD runtime. These are the parent's owned I/O — the
 * same provider, clock, ids, store, and policy engine — plus the parent's authority and config, which
 * the child inherits (its ceiling) but never widens. `instructions` is a thunk because the composed
 * system prompt is built after this surface is wired; it is read at spawn time, not construction time.
 */
export interface SubagentRuntimeDeps {
  readonly parentAuthority: RunAuthority;
  readonly workspaceRoot: string;
  readonly homeDir: string;
  /** Read at spawn time — the composed prompt is assembled after the delegate surface is wired. */
  readonly instructions: () => string;
  readonly clock: { now(): number };
  readonly ids: { next(prefix: string): string };
  readonly store: EventStore;
  readonly policy: PolicyEngine;
  readonly provider?: ModelProvider;
  /** The mode-restricted built-in set the parent runs, so a child cannot see a tool the parent lost. */
  readonly builtins?: readonly BuiltinTool[];
  readonly limits?: SubagentBudgetLimits;
  /**
   * Guarded, observe-only hook fire (HK-01). SubagentStart fires immediately BEFORE a child turn runs
   * and SubagentStop immediately AFTER, from the runner that owns the child's id and outcome. It is a
   * plain callback so `@qwen-harness/agents` never learns about hooks; it cannot gate the child.
   */
  readonly fireHook?: FireHook;
}

/**
 * Turn a `RunAuthority` into the `Authority` shape the supervisor intersects. The parent run's
 * authority is the CEILING a delegate requests; the supervisor intersects requested ∩ ceiling ∩
 * managed, so passing the parent authority as the request yields exactly the parent's own (clamped)
 * authority as the child's ceiling — never wider.
 */
export function runAuthorityToAuthority(ra: RunAuthority, workspaceRoot: string): Authority {
  return {
    profile: ra.profile,
    isolation: ra.isolation,
    networkAllowed: ra.networkAllowed,
    workspaceRoots: [workspaceRoot],
    rules: ra.rules,
    grants: [],
    maxChildDepth: ra.managedPolicy.maxChildDepth,
  };
}

/**
 * Build the child `RunAuthority` from the supervisor's intersected `Authority`. Profile, isolation,
 * network, and rules come from the INTERSECTED authority (already ≤ parent); the managed ceiling and
 * the resolved config are inherited from the parent verbatim (the ceiling never widens). This is the
 * single place the child's policy identity is derived, so there is no second, divergent clamp.
 */
export function childRunAuthority(parent: RunAuthority, intersected: Authority): RunAuthority {
  return {
    managedPolicy: parent.managedPolicy,
    rules: intersected.rules,
    profile: intersected.profile,
    isolation: intersected.isolation,
    networkAllowed: intersected.networkAllowed,
    config: parent.config,
  };
}

/** Count the model rounds a child actually completed, straight from its durable thread. */
function countModelCalls(store: EventStore, threadId: ThreadId): number {
  return store.readThread(threadId).filter((e) => e.payload.type === 'model-request-completed')
    .length;
}

/**
 * A production `SubagentRunner`: one nested turn against a real `TurnEngine`.
 *
 * `depth` is the depth of the supervisor that will drive this runner. The child it runs sits at
 * `depth + 1`; that child receives its own `delegate` tool only while `depth + 1 < maxDepth`, so the
 * recursion terminates at the depth bound (and the supervisor's guard backstops it regardless).
 */
export function createSubagentRunner(
  deps: SubagentRuntimeDeps,
  supervisor: SubagentSupervisor,
  depth: number,
): SubagentRunner {
  const limits = deps.limits ?? DEFAULT_SUBAGENT_LIMITS;

  return {
    run: async (input) => {
      // The child authority is the supervisor's intersected result. Assert (again) it does not exceed
      // the parent ceiling before we hand it to a runtime — a widened child is a crash, not a run.
      const parentAuthority = runAuthorityToAuthority(deps.parentAuthority, deps.workspaceRoot);
      if (!isAtMost(input.authority, parentAuthority)) {
        return {
          ok: false,
          summary: 'refused: computed child authority exceeds the parent ceiling',
          modelCalls: 0,
        };
      }
      const childAuthority = childRunAuthority(deps.parentAuthority, input.authority);

      // The child gets its OWN durable thread in the SAME store — its events are auditable and its
      // history reconstructs independently of the parent's.
      const childThreadId = deps.ids.next('thr') as ThreadId;
      deps.store.append({
        threadId: childThreadId,
        correlationId: deps.ids.next('cor') as CorrelationId,
        permissionProfile: childAuthority.profile,
        actor: SYSTEM_ACTOR,
        payload: {
          type: 'thread-created',
          cwd: deps.workspaceRoot,
          canonicalRepo: deps.workspaceRoot,
          name: `subagent ${input.agentId}`,
        },
      });

      // A child's supervisor is one level deeper; a child only gets a spawnable delegate while below
      // the depth bound. The supervisor's depth-exceeded guard is the backstop either way.
      const childSupervisor = supervisor.childSupervisor(input.authority);
      const childDepth = depth + 1;
      const childGetsDelegate = childDepth < limits.maxDepth;

      const childPolicyContext = (): PolicyContext => ({
        profile: childAuthority.profile,
        managedPolicy: childAuthority.managedPolicy,
        rules: childAuthority.rules,
        grants: [],
        workspaceRoot: deps.workspaceRoot,
        homeDir: deps.homeDir,
        now: deps.clock.now(),
        actor: MODEL_ACTOR,
      });

      // The child's in-process surface: retrieve_output + ask_user always (ask_user is headless — a
      // subagent has no human to ask), and delegate ONLY while below the depth bound.
      const delegate: DelegatePort | undefined = childGetsDelegate
        ? createDelegatePort({
            ...deps,
            parentAuthority: childAuthority,
            parentThreadId: childThreadId,
            parentModelCalls: input.maxModelCalls,
            parentWallMs: input.maxWallMs,
            model: input.model,
            supervisor: childSupervisor,
            runner: createSubagentRunner(
              { ...deps, parentAuthority: childAuthority },
              childSupervisor,
              childDepth,
            ),
          })
        : undefined;

      const childInProcess = inProcessSurface({
        blob: deps.store,
        userInteraction: headlessUserInteraction(),
        policy: deps.policy,
        policyContext: childPolicyContext,
        workspaceRoot: deps.workspaceRoot,
        clock: deps.clock,
        ...(delegate ? { delegate } : {}),
      });

      // A child budget bounded by the allowance the supervisor passed (itself a fraction of the
      // parent's). Other limits keep the frozen defaults.
      const childBudget: BudgetLimits = {
        ...DEFAULT_BUDGET,
        maxModelCallsPerTurn: Math.max(1, input.maxModelCalls),
        maxWallMs: Math.max(1, input.maxWallMs),
      };

      const childRuntime = createHarnessRuntime({
        workspaceRoot: deps.workspaceRoot,
        authority: childAuthority,
        model: input.model,
        instructions: deps.instructions(),
        homeDir: deps.homeDir,
        clock: deps.clock,
        ids: deps.ids,
        store: deps.store,
        policy: deps.policy,
        inProcess: childInProcess,
        budget: childBudget,
        ...(deps.builtins ? { builtins: deps.builtins } : {}),
        ...(deps.provider ? { provider: deps.provider } : {}),
      });

      // SubagentStart (HK-01): the child turn is about to run. Observe-only and guarded upstream.
      await deps.fireHook?.('SubagentStart', {
        agentId: input.agentId,
        threadId: String(childThreadId),
      });

      let outcome;
      try {
        outcome = await childRuntime.runTurn({
          threadId: childThreadId,
          correlationId: deps.ids.next('cor') as CorrelationId,
          userText: input.prompt,
          // Forked mode seeds the child with the parent's reconstructed conversation; fresh gets none.
          history: input.forkedContext ?? [],
          signal: input.signal,
        });
      } catch (err) {
        // A genuinely broken runtime is a normal child failure, not a thrown runner: report ok:false.
        await deps.fireHook?.('SubagentStop', { agentId: input.agentId, ok: false });
        return {
          ok: false,
          summary: `subagent failed: ${err instanceof Error ? err.message : String(err)}`,
          modelCalls: countModelCalls(deps.store, childThreadId),
        };
      }

      const modelCalls = countModelCalls(deps.store, childThreadId);
      if (outcome.state === 'completed') {
        // SubagentStop (HK-01): the child finished cleanly.
        await deps.fireHook?.('SubagentStop', { agentId: input.agentId, ok: true });
        return {
          ok: true,
          summary: outcome.finalText || '(subagent produced no text)',
          modelCalls,
        };
      }
      // A non-clean end is a child failure the parent can read and keep going from.
      await deps.fireHook?.('SubagentStop', {
        agentId: input.agentId,
        ok: false,
        state: outcome.state,
      });
      const reason = outcome.reason ?? outcome.state;
      const summary = outcome.finalText
        ? `${outcome.finalText}\n[subagent ended ${outcome.state}: ${reason}]`
        : `subagent ended ${outcome.state}: ${reason}`;
      return { ok: false, summary, modelCalls };
    },
  };
}

/** Everything the delegate port needs to turn tool args into a spawned subagent. */
export interface DelegatePortDeps extends SubagentRuntimeDeps {
  readonly supervisor: SubagentSupervisor;
  readonly runner: SubagentRunner;
  readonly parentThreadId: ThreadId;
  readonly model: string;
  /** The parent turn's per-turn model-call/wall allowance; the child gets a bounded fraction. */
  readonly parentModelCalls: number;
  readonly parentWallMs: number;
}

/**
 * Build the `DelegatePort` the in-process `delegate` tool calls. It maps tool arguments to a
 * `SubagentSpec` (requesting the parent authority as the ceiling), reads the parent thread's
 * persisted conversation for a forked seed, and drives the supervisor's foreground/background path.
 */
export function createDelegatePort(deps: DelegatePortDeps): DelegatePort {
  const childModelCalls = Math.max(
    MIN_CHILD_MODEL_CALLS,
    Math.floor(deps.parentModelCalls * CHILD_BUDGET_FRACTION),
  );
  const childWallMs = Math.max(1, Math.floor(deps.parentWallMs * CHILD_BUDGET_FRACTION));

  const buildSpec = (args: {
    label: string;
    prompt: string;
    context: 'fresh' | 'forked';
    timing: 'foreground' | 'background';
  }): SubagentSpec => {
    // Forked context via the STORE (no engine change): the parent thread's persisted items are
    // reduced to model-input items exactly as resume/fork do, and passed as the child's seed. Fresh
    // mode passes no seed at all (the key is absent under exactOptionalPropertyTypes).
    const forked =
      args.context === 'forked' ? reconstructHistory(deps.store, deps.parentThreadId) : undefined;
    const base = {
      label: args.label,
      prompt: args.prompt,
      mode: { context: args.context, timing: args.timing },
      // Request the parent's OWN authority as the ceiling; the supervisor intersects it down.
      requestedAuthority: runAuthorityToAuthority(deps.parentAuthority, deps.workspaceRoot),
      model: deps.model,
      maxModelCalls: childModelCalls,
      maxWallMs: childWallMs,
    };
    return forked !== undefined && forked.length > 0 ? { ...base, forkedContext: forked } : base;
  };

  return {
    run: async (args, signal) => {
      const spec = buildSpec(args);
      if (args.timing === 'background') {
        const handle = deps.supervisor.spawnBackground(spec, deps.runner, signal);
        return {
          ok: true,
          modelText: `subagent ${args.label} started in background as ${handle.agentId}`,
        };
      }
      const conclusion = await deps.supervisor.spawn(spec, deps.runner, signal);
      return { ok: conclusion.ok, modelText: conclusion.summary };
    },
  };
}

/**
 * Assemble the top-level (depth 0) supervisor, production runner, and delegate port for a parent run.
 * Returns the `DelegatePort` to plug into the in-process surface, plus the supervisor so the caller
 * can `joinAll()` any background children at turn end.
 */
export function createDelegateSurface(
  deps: SubagentRuntimeDeps & {
    readonly parentThreadId: ThreadId;
    readonly model: string;
    readonly parentModelCalls: number;
    readonly parentWallMs: number;
  },
): { supervisor: SubagentSupervisor; delegate: DelegatePort } {
  const parentAuthority = runAuthorityToAuthority(deps.parentAuthority, deps.workspaceRoot);
  const supervisor = new SubagentSupervisor({
    authority: parentAuthority,
    managed: deps.parentAuthority.managedPolicy,
    depth: 0,
    ids: deps.ids,
    ...(deps.limits ? { limits: deps.limits } : {}),
  });
  const runner = createSubagentRunner(deps, supervisor, 0);
  const delegate = createDelegatePort({
    ...deps,
    supervisor,
    runner,
  });
  return { supervisor, delegate };
}
