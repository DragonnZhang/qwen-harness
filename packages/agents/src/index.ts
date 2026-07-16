/**
 * @qwen-harness/agents
 *
 * Subagent delegation with bounded authority (section F). A subagent is a child turn with its own
 * history, prompt, tools, model, budget, and permission identity.
 *
 * The invariants that make delegation safe: a child never receives more authority than its parent
 * (its authority is requested ∩ parent-ceiling ∩ managed-policy); depth and count are bounded so a
 * child cannot spawn an unbounded tree; parent cancellation propagates; and ordinary completion
 * returns only a bounded, attributed CONCLUSION — not the child's whole transcript.
 */

export {
  SubagentSupervisor,
  SubagentError,
  DEFAULT_SUBAGENT_LIMITS,
  SUBAGENT_MODE_FRESH_FG,
  SUBAGENT_MODE_FORKED_FG,
  SUBAGENT_MODE_FRESH_BG,
  SUBAGENT_MODE_FORKED_BG,
} from './subagent.ts';
export type {
  SubagentSpec,
  SubagentMode,
  SubagentConclusion,
  SubagentRunner,
  SubagentHandle,
  SupervisorContext,
  SubagentBudgetLimits,
} from './subagent.ts';
