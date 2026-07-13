import { intersect, isAtMost, type Authority } from '@qwen-harness/policy';
import type { ManagedPolicy } from '@qwen-harness/policy';
import type { AgentId, IdSource } from '@qwen-harness/protocol';

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

export type SubagentMode = 'fresh' | 'forked' | 'sync' | 'background';

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
  }): Promise<{ ok: boolean; summary: string; modelCalls: number }>;
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

  async spawn(
    spec: SubagentSpec,
    runner: SubagentRunner,
    signal: AbortSignal,
  ): Promise<SubagentConclusion> {
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

    const authority = this.childAuthority(spec.requestedAuthority);
    const agentId = this.#ctx.ids.next('agt') as AgentId;

    this.#totalSpawned++;
    this.#active++;
    try {
      if (signal.aborted)
        throw new SubagentError('cancelled', 'parent was cancelled before the child started');

      const result = await runner.run({
        agentId,
        prompt: spec.prompt,
        authority,
        model: spec.model,
        maxModelCalls: spec.maxModelCalls,
        maxWallMs: spec.maxWallMs,
        signal,
      });

      return {
        agentId,
        label: spec.label,
        ok: result.ok,
        // Bound the summary — a subagent returns a conclusion, not its whole transcript (AG-01).
        summary: result.summary.slice(0, 8000),
        modelCalls: result.modelCalls,
      };
    } finally {
      this.#active--;
    }
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
