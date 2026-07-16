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

export {
  createHarnessRuntime,
  defaultProvider,
  pipelineExecutor,
  riskOf,
  GrantStore,
} from './wiring.ts';
export type {
  HarnessRuntime,
  HarnessRuntimeOptions,
  TurnOutcome,
  UserShellOutcome,
} from './wiring.ts';
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
  acquireMcpToken,
  mcpSecretStore,
  createMcpOAuthClient,
  trustServer,
  loadTrustedServers,
  trustFilePath,
  McpFileSchema,
  McpConfigError,
  type McpConfiguration,
  type ConnectedMcp,
} from './mcp.ts';
export {
  compositeExecutor,
  type McpSurface,
  type ModelTool,
  type InProcessSurface,
} from './wiring.ts';
export {
  inProcessExecutor,
  inProcessSurface,
  inProcessToolSchemas,
  cliUserInteraction,
  headlessUserInteraction,
  IN_PROCESS_TOOL_NAMES,
  MAX_RETRIEVE_CHARS,
  type BlobPort,
  type UserInteraction,
} from './in-process-tools.ts';

// Durable work made reachable from the CLI: the task graph (WK-*), background lifecycle (BG-*), and
// Cron scheduler + supervisor (CR-*). Exported so they are tested against the real production path.
export {
  openTaskGraph,
  createTask,
  listTasks,
  getTask,
  claimTask,
  startTask,
  completeTask,
  releaseTask,
  deleteTask,
  renderTask,
  normalizeTodos,
} from './tasks.ts';
export {
  createSandboxRunner,
  buildBackgroundPipeline,
  createDurableBackgroundManager,
  runSandboxedShell,
  listDurableBackground,
  isBackgroundCategory,
  type ShellWorkload,
  type ShellRunResult,
  type DurableBackgroundRecord,
} from './background.ts';
export {
  openScheduler,
  addCron,
  listCron,
  runSupervisor,
  authorityOf,
  cronFireKey,
  parseCron,
  SCHEDULER_THREAD_ID,
  type AddCronInput,
  type FireOutcome,
  type SupervisorResult,
  type CronListItem,
} from './scheduler.ts';

// The multi-agent TEAM subsystem (golden path 5): a lead launches REAL sandboxed teammates in
// isolated git worktrees, routes plan/permission approvals over a durable protocol bus, resolves
// concurrent claiming, and shuts down cleanly. Exported so it is tested against the production path.
export {
  runLead,
  runTeammate,
  teamStatus,
  teamThreadId,
  teammateAuthority,
  readResults,
  parseTaskSpecs,
  LEAD_ID,
  type TeamDeps,
  type LeadOptions,
  type LeadSummary,
  type MemberSummary,
  type TeammateOptions,
  type TeammateSummary,
  type MemberStatus,
  type TeamResult,
  type TaskSpec,
} from './team.ts';
