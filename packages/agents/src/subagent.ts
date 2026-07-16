import { intersect, isAtMost, type Authority } from '@qwen-harness/policy';
import type { ManagedPolicy } from '@qwen-harness/policy';
import type { AgentId, IdSource } from '@qwen-harness/protocol';
import type { ModelInputItem } from '@qwen-harness/provider-core';

/**
 * Subagent delegation with bounded authority (section F: AG-01..AG-04).
 *
 * A subagent is a child turn with its OWN history, prompt, tools, model, budget, and permission
 * identity. The invariants that make delegation safe:
 *
 *   - a child NEVER receives more authority than its parent — its authority is the intersection of
 *     what was requested, the parent's ceiling, and current managed policy (AG-03);
 *   - depth and count are bounded, so a child cannot spawn an unbounded tree of grandchildren;
 *   - parent cancellation propagates to the child through one abort tree;
 *   - ordinary completion returns only a BOUNDED, attributed conclusion to the parent — not the
 *     child's entire transcript (AG-01/AG-04).
 */

/**
 * A subagent mode is two ORTHOGONAL axes, never a flat enum. Conflating them (as the old
 * `'fresh'|'forked'|'sync'|'background'` did) hides the fact that context and timing vary
 * independently — a forked child can run in the background, a fresh child in the foreground, etc.
 */
export interface SubagentMode {
  /** fresh = isolated (child sees only its prompt); forked = inherits a seed of the parent's context (cache-friendly reuse of the parent's prefix). */
  readonly context: 'fresh' | 'forked';
  /** foreground = the parent awaits the conclusion; background = the parent continues and the conclusion is collected later. */
  readonly timing: 'foreground' | 'background';
}

/** Convenience constants for the four corners; the struct is canonical. */
export const SUBAGENT_MODE_FRESH_FG: SubagentMode = { context: 'fresh', timing: 'foreground' };
export const SUBAGENT_MODE_FORKED_FG: SubagentMode = { context: 'forked', timing: 'foreground' };
export const SUBAGENT_MODE_FRESH_BG: SubagentMode = { context: 'fresh', timing: 'background' };
export const SUBAGENT_MODE_FORKED_BG: SubagentMode = { context: 'forked', timing: 'background' };

export interface SubagentSpec {
  readonly label: string;
  readonly prompt: string;
  readonly mode: SubagentMode;
  /** The authority the PARENT is requesting for the child; it is intersected down before use. */
  readonly requestedAuthority: Authority;
  readonly model: string;
  /** Hard budget for the child, itself bounded by the parent's remaining budget. */
  readonly maxModelCalls: number;
  readonly maxWallMs: number;
  /**
   * The parent-context seed the parent supplies when `mode.context === 'forked'` — a cache-friendly
   * prefix of the parent's conversation the forked child reuses. IGNORED when `mode.context ===
   * 'fresh'` (a fresh child sees only its own prompt and never receives this seed).
   */
  readonly forkedContext?: readonly ModelInputItem[];
}

export interface SubagentBudgetLimits {
  /** Max simultaneously-active children (frozen default: 4). */
  readonly maxActiveChildren: number;
  /** Max children per parent turn (frozen default: 16). */
  readonly maxTotalChildren: number;
  /** Max nesting depth (frozen default: 2). */
  readonly maxDepth: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentBudgetLimits = {
  maxActiveChildren: 4,
  maxTotalChildren: 16,
  maxDepth: 2,
};

export class SubagentError extends Error {
  constructor(
    readonly code:
      'depth-exceeded' | 'count-exceeded' | 'active-exceeded' | 'authority-widened' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'SubagentError';
  }
}

/** A bounded conclusion — what a completed subagent returns to its parent (AG-01). */
export interface SubagentConclusion {
  readonly agentId: AgentId;
  readonly label: string;
  readonly ok: boolean;
  /** The attributed summary. Bounded — never the child's full transcript. */
  readonly summary: string;
  readonly modelCalls: number;
}

/** Runs one subagent turn. Injected, so this package does not depend on the concrete runtime. */
export interface SubagentRunner {
  run(input: {
    agentId: AgentId;
    prompt: string;
    authority: Authority;
    model: string;
    maxModelCalls: number;
    maxWallMs: number;
    signal: AbortSignal;
    /**
     * The parent-context seed — present ONLY for a forked-context child, and ABSENT for a fresh
     * child. This is how "fresh vs forked" becomes observable to the runner: a fresh child's runner
     * receives no seed at all; a forked child's runner receives the parent's supplied prefix.
     */
    forkedContext?: readonly ModelInputItem[];
  }): Promise<{ ok: boolean; summary: string; modelCalls: number }>;
}

/** A handle to a background subagent — the parent collects its conclusion later via `join()`. */
export interface SubagentHandle {
  readonly agentId: AgentId;
  /**
   * Awaits the child and returns its bounded conclusion. A background child whose runner REJECTS
   * surfaces here as a REJECTED promise (never as a silent `ok:false`) — the caller must handle it.
   */
  join(): Promise<SubagentConclusion>;
}

export interface SupervisorContext {
  /** This supervisor's own authority — the ceiling for any child it spawns. */
  readonly authority: Authority;
  readonly managed: ManagedPolicy;
  /** Current nesting depth (0 = top-level user turn). */
  readonly depth: number;
  readonly ids: IdSource;
  readonly limits?: SubagentBudgetLimits;
}

/**
 * Spawns and bounds subagents for one parent turn. It enforces the depth/count/active limits and
 * intersects every child's authority down before running it.
 */
export class SubagentSupervisor {
  readonly #ctx: SupervisorContext;
  readonly #limits: SubagentBudgetLimits;
  #totalSpawned = 0;
  #active = 0;
  /** In-flight background conclusions, in spawn order, so `joinAll` can await them. */
  readonly #background: Promise<SubagentConclusion>[] = [];

  constructor(ctx: SupervisorContext) {
    this.#ctx = ctx;
    this.#limits = ctx.limits ?? DEFAULT_SUBAGENT_LIMITS;
  }

  get activeCount(): number {
    return this.#active;
  }
  get totalSpawned(): number {
    return this.#totalSpawned;
  }

  /**
   * Compute the authority a child would actually get, intersecting requested ∩ parent ∩ managed.
   * Exposed so a caller can show the child's real (narrowed) authority before running it.
   */
  childAuthority(requested: Authority): Authority {
    const result = intersect(requested, this.#ctx.authority, this.#ctx.managed);
    // Defense in depth: the result must be at most the parent. If intersect ever returned something
    // wider (a bug), refuse rather than run a child with more authority than its parent (AG-03).
    if (!isAtMost(result, this.#ctx.authority)) {
      throw new SubagentError(
        'authority-widened',
        'computed child authority exceeds the parent ceiling',
      );
    }
    return result;
  }

  /**
   * The shared admission guards, run up front for BOTH timings: depth, total-count, active bound,
   * cancelled-before-start, and the authority intersection (which itself refuses a widened child).
   * Returns the intersected authority and the fresh agent id. Does NOT touch the counters.
   */
  #admit(spec: SubagentSpec, signal: AbortSignal): { authority: Authority; agentId: AgentId } {
    // Depth guard: a child at max depth cannot itself spawn children.
    if (this.#ctx.depth >= this.#limits.maxDepth) {
      throw new SubagentError(
        'depth-exceeded',
        `child depth ${this.#ctx.depth} reached the limit ${this.#limits.maxDepth}`,
      );
    }
    if (this.#totalSpawned >= this.#limits.maxTotalChildren) {
      throw new SubagentError(
        'count-exceeded',
        `already spawned ${this.#totalSpawned} children this turn (limit ${this.#limits.maxTotalChildren})`,
      );
    }
    if (this.#active >= this.#limits.maxActiveChildren) {
      throw new SubagentError(
        'active-exceeded',
        `already ${this.#active} active children (limit ${this.#limits.maxActiveChildren})`,
      );
    }
    if (signal.aborted)
      throw new SubagentError('cancelled', 'parent was cancelled before the child started');

    const authority = this.childAuthority(spec.requestedAuthority);
    const agentId = this.#ctx.ids.next('agt') as AgentId;
    return { authority, agentId };
  }

  /**
   * Build the runner input, passing `forkedContext` ONLY for a forked child that actually supplied
   * a seed. A fresh child's runner receives no `forkedContext` key at all (never an explicit
   * `undefined`, per exactOptionalPropertyTypes) — that absence is the observable fresh/forked line.
   */
  #runInput(
    spec: SubagentSpec,
    agentId: AgentId,
    authority: Authority,
    signal: AbortSignal,
  ): Parameters<SubagentRunner['run']>[0] {
    const base = {
      agentId,
      prompt: spec.prompt,
      authority,
      model: spec.model,
      maxModelCalls: spec.maxModelCalls,
      maxWallMs: spec.maxWallMs,
      signal,
    };
    if (spec.mode.context === 'forked' && spec.forkedContext !== undefined) {
      return { ...base, forkedContext: spec.forkedContext };
    }
    return base;
  }

  #conclusion(
    agentId: AgentId,
    label: string,
    result: { ok: boolean; summary: string; modelCalls: number },
  ): SubagentConclusion {
    return {
      agentId,
      label,
      ok: result.ok,
      // Bound the summary — a subagent returns a conclusion, not its whole transcript (AG-01).
      summary: result.summary.slice(0, 8000),
      modelCalls: result.modelCalls,
    };
  }

  /**
   * The FOREGROUND entry point: run the guards, run the child, and await its bounded conclusion.
   * Called with a background spec it throws (a plain Error, not a SubagentError code) — background
   * children go through `spawnBackground`, which returns a handle instead of awaiting.
   */
  async spawn(
    spec: SubagentSpec,
    runner: SubagentRunner,
    signal: AbortSignal,
  ): Promise<SubagentConclusion> {
    if (spec.mode.timing !== 'foreground') {
      throw new Error(
        'spawn() is the foreground entry point; use spawnBackground() for a background-timing spec',
      );
    }
    const { authority, agentId } = this.#admit(spec, signal);

    this.#totalSpawned++;
    this.#active++;
    try {
      const result = await runner.run(this.#runInput(spec, agentId, authority, signal));
      return this.#conclusion(agentId, spec.label, result);
    } finally {
      this.#active--;
    }
  }

  /**
   * The BACKGROUND entry point: run the SAME admission guards and increment the counters up front,
   * start the child WITHOUT awaiting, and return a handle immediately. The child counts toward
   * `#active` from now until it SETTLES (success OR failure) — that is what the active bound is for,
   * so `maxActiveChildren` background children in flight will make the next `spawnBackground` throw
   * `active-exceeded`. Called with a foreground spec it throws (a plain Error, not a SubagentError).
   */
  spawnBackground(spec: SubagentSpec, runner: SubagentRunner, signal: AbortSignal): SubagentHandle {
    if (spec.mode.timing !== 'background') {
      throw new Error(
        'spawnBackground() is the background entry point; use spawn() for a foreground-timing spec',
      );
    }
    const { authority, agentId } = this.#admit(spec, signal);

    this.#totalSpawned++;
    this.#active++;
    const running = (async () =>
      this.#conclusion(
        agentId,
        spec.label,
        await runner.run(this.#runInput(spec, agentId, authority, signal)),
      ))();
    // Release the active slot when the child SETTLES (not when this method returns), regardless of
    // whether anyone ever calls join(). Attaching this handler also marks `running` as consumed, so
    // a rejecting orphan never surfaces as an unhandled rejection; join() still sees the rejection.
    running
      .finally(() => {
        this.#active--;
      })
      .catch(() => {});
    this.#background.push(running);

    return { agentId, join: () => running };
  }

  /**
   * Awaits every background child spawned by this supervisor, in SPAWN order, and returns their
   * bounded conclusions. Rejects if any background child rejected (Promise.all semantics); each
   * child still settles its own active slot independently, so `#active` accounting is correct once
   * all children have settled.
   */
  joinAll(): Promise<readonly SubagentConclusion[]> {
    return Promise.all(this.#background);
  }

  /**
   * A child supervisor for the NEXT level down: same ceiling, depth+1. This is how the depth bound
   * actually propagates — a grandchild's supervisor knows it is deeper.
   */
  childSupervisor(childAuthority: Authority): SubagentSupervisor {
    return new SubagentSupervisor({
      authority: childAuthority,
      managed: this.#ctx.managed,
      depth: this.#ctx.depth + 1,
      ids: this.#ctx.ids,
      limits: this.#limits,
    });
  }
}
