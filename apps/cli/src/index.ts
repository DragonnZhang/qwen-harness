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

// The subsystems this composition root makes reachable. Exported so they can be tested against the
// real production path (and embedded), never as a second, test-only entry point into the runtime.
export {
  openTelemetry,
  pruneTraces,
  readTraceFile,
  listTraceFiles,
  traceFileName,
  traceEvent,
  tracedProvider,
  tracedExecutor,
  TELEMETRY_OFF,
  type TelemetryHandle,
} from './telemetry.ts';
export {
  recoverInterrupted,
  listStuck,
  resolveSideEffect,
  SideEffectNotFound,
  type StuckSideEffect,
  type Finding,
} from './side-effects.ts';
export {
  loadGuidance,
  composePrompt,
  type LoadedGuidance,
  type ComposedPrompt,
} from './instructions.ts';
export {
  loadHooks,
  createHookRuntime,
  HookConfigSchema,
  HookConfigError,
  type HookRuntime,
  type LoadedHooks,
} from './hooks.ts';
export { createSkillSurface, renderCatalog, type SkillSurface } from './skills.ts';
export {
  createMemorySurface,
  memorySectionState,
  type MemorySurface,
  type AddOutcome,
} from './memory.ts';
export {
  loadMcpConfiguration,
  connectMcp,
  trustServer,
  loadTrustedServers,
  trustFilePath,
  McpFileSchema,
  McpConfigError,
  type McpConfiguration,
  type ConnectedMcp,
} from './mcp.ts';
export { compositeExecutor, type McpSurface, type ModelTool } from './wiring.ts';
