/**
 * @qwen-harness/cli
 *
 * The headless composition root. It wires the real provider, sandbox, storage, and config into a
 * runnable harness and exposes them as commands. Apps are the only place allowed to touch every
 * I/O owner at once — every package below reached this point through its own boundary.
 *
 * This is deliberately headless (JSON/text, stable exit codes): CI and integrations must never
 * depend on terminal rendering (UI-15). The Ink TUI is a separate client of the same runtime.
 */

export { createHarnessRuntime, pipelineExecutor, riskOf, GrantStore } from './wiring.ts';
export type { HarnessRuntime, HarnessRuntimeOptions, TurnOutcome } from './wiring.ts';
export { runDoctor } from './doctor.ts';
export type { DoctorReport } from './doctor.ts';
export { main } from './main.ts';
export type { CliDeps } from './main.ts';
export { interactiveApprovalGate } from './approvals.ts';
export type { PromptIo } from './approvals.ts';
export { stdinLineReader } from './stdin.ts';
export {
  listSessions,
  reconstructHistory,
  forkSession,
  exportSession,
  findPendingApproval,
} from './sessions.ts';
export type { SessionSummary, PendingApprovalRecord } from './sessions.ts';

export {
  authorityFromConfig,
  authorityForProfile,
  loadRunAuthority,
  type RunAuthority,
} from './policy-from-config.ts';
