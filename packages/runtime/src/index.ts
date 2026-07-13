/**
 * @qwen-harness/runtime
 *
 * The headless agent-loop coordinator. LAYER 3, and PURE of host I/O.
 *
 * The runtime owns the turn state machine, budgets, stream normalization, and the loop that ties
 * a provider to tool execution. What it does NOT do is touch the host: it never spawns a process,
 * reads a file, invokes Git, or opens a socket. It coordinates the packages that do, through
 * injected interfaces. `pnpm architecture` fails the build if that ever stops being true.
 *
 * That constraint is what makes the whole product deterministic under test (RT-08): inject a fake
 * provider, a fake tool executor, a manual clock, and a sequential ID source, and a complete turn
 * replays identically every time.
 */

export { TurnMachine } from './turn-machine.ts';
export { BudgetTracker, DEFAULT_BUDGET } from './budget.ts';
export type { BudgetLimits, BudgetSnapshot, BudgetVerdict } from './budget.ts';
export { RoundNormalizer, normalizeRound } from './normalizer.ts';
export type { NormalizedRound, NormalizedToolCall } from './normalizer.ts';

export { TurnEngine } from './turn-engine.ts';
export type {
  TurnEngineDeps,
  RunTurnInput,
  ResumeTurnInput,
  TurnResult,
  EventSink,
  ToolExecutor,
  ToolEvaluation,
  ToolExecutionResult,
  TurnHooks,
  ApprovalGate,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalRisk,
} from './turn-engine.ts';
