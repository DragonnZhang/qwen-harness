import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { PolicyEngine, type Grant, type PolicyContext } from '@qwen-harness/policy';
import {
  resolveProfile,
  type Actor,
  type ActorId,
  type Clock,
  type CorrelationId,
  type PermissionProfile,
  type SideEffectId,
  type ThreadId,
  type TurnId,
} from '@qwen-harness/protocol';
import type { ModelProvider } from '@qwen-harness/provider-core';
import { DASHSCOPE_DEFAULTS, EnvCredentialSource } from '@qwen-harness/provider-dashscope';
import { PromptModeSchema, toolsForMode, type PromptMode } from '@qwen-harness/instructions';
import { BUILTIN_TOOLS } from '@qwen-harness/tools-builtin';
import { EventStore, createRedactor } from '@qwen-harness/storage';
import { createWorktree, WorktreeError } from '@qwen-harness/worktrees';

import { interactiveApprovalGate } from './approvals.ts';
import { contextUtilizationPercent, createContextManager } from './context.ts';
import { runDoctor } from './doctor.ts';
import { createHookRuntime, loadHooks, observeHook, type FireHook } from './hooks.ts';
import { composePrompt, loadGuidance } from './instructions.ts';
import { connectMcp, loadMcpConfiguration, trustServer } from './mcp.ts';
import { createMemorySurface, memorySectionState } from './memory.ts';
import { loadRunAuthority, type RunAuthority } from './policy-from-config.ts';
import {
  exportSession,
  findPendingApproval,
  forkSession,
  listSessions,
  reconstructHistory,
} from './sessions.ts';
import {
  createDurableBackgroundManager,
  buildBackgroundPipeline,
  isBackgroundCategory,
  listDurableBackground,
} from './background.ts';
import {
  addCron,
  authorityOf,
  listCron,
  openScheduler,
  parseCron,
  preapprovalRule,
  runSupervisor,
  SCHEDULER_THREAD_ID,
} from './scheduler.ts';
import { listStuck, recoverInterrupted, resolveSideEffect } from './side-effects.ts';
import {
  claimTask,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  normalizeTodos,
  openTaskGraph,
  releaseTask,
  renderTask,
  startTask,
} from './tasks.ts';
import { createSkillSurface, renderCatalog } from './skills.ts';
import {
  parseTaskSpecs,
  runLead,
  runTeammate,
  teamStatus,
  type LeadOptions,
  type TeamDeps,
} from './team.ts';
import { listTraceFiles, openTelemetry, readTraceFile } from './telemetry.ts';
import {
  cliUserInteraction,
  headlessUserInteraction,
  inProcessSurface,
} from './in-process-tools.ts';
import { createDelegateSurface } from './subagent-tool.ts';
import { DEFAULT_BUDGET } from '@qwen-harness/runtime';
import { createHarnessRuntime, type GrantStore, type TurnOutcome } from './wiring.ts';

/**
 * The CLI argument surface. Kept tiny and explicit; a real getopts layer is a checkpoint-09 polish
 * item. Stable exit codes: 0 success, 1 usage error, 2 runtime failure, 3 blocked/credential
 * (which includes "this turn is waiting for an approval nobody could answer").
 */
export interface CliDeps {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => number;
  /**
   * The interactive input channel. `bin.ts` backs it with stdin. When it is absent — or returns
   * `null` (EOF) — there is no approval channel, and an `ask` action leaves the turn durably
   * `awaiting-approval` rather than being approved or discarded.
   */
  readonly readLine?: (prompt: string) => Promise<string | null>;
  /**
   * Injected model provider. Production leaves it undefined and the composition root constructs the
   * DashScope adapter, which reads the credential at its OWN boundary. Tests inject a scripted
   * provider so a real second process can be driven deterministically.
   */
  readonly provider?: ModelProvider;
  /**
   * Override for the managed-policy file path. Injected ONLY for tests, exactly like `provider`:
   * `bin.ts` never sets it, so production always resolves the ceiling from the fixed system path and
   * no user-facing flag or env var can ever point the managed ceiling at a weaker file. A test that
   * needs to prove the ceiling binds scheduled/background work supplies a managed file here.
   */
  readonly managedPath?: string;
  /**
   * The worker script the team LEAD re-invokes (as a real, separate OS process) to run each teammate.
   * Injected exactly like `managedPath`: `bin.ts` never sets it, so a teammate is always a genuine
   * `process.execPath` child running `main('team teammate …')`, never an in-process fake. A `team run`
   * without it fails fast rather than pretending to launch teammates.
   */
  readonly teamWorker?: string;
}

/** The actor the model turn's context boundary/compaction items are attributed to. */
const MODEL_ACTOR: Actor = { kind: 'model', id: 'act_model1' as ActorId };

let idCounter = 0;
const realIds = {
  next(prefix: string): string {
    // Monotonic, collision-resistant enough for a single-process CLI run. The daemon uses a
    // durable high-water source; this is the headless one-shot equivalent.
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}`;
  },
};

export async function main(deps: CliDeps): Promise<number> {
  const [command, ...rest] = deps.argv;

  if (command === undefined || command === 'help' || command === '--help') {
    deps.stdout('qwen-harness <command>');
    deps.stdout('');
    deps.stdout(
      '  doctor                 report environment, config provenance, sandbox, credential presence',
    );
    deps.stdout(
      '  run <prompt>           run one turn in the current workspace and print the result',
    );
    deps.stdout('  sessions               list the sessions in this workspace');
    deps.stdout('  resume <id> [prompt]   continue a session; with no prompt, resume a pending');
    deps.stdout('                         approval and finish the SAME turn');
    deps.stdout('  fork <id>              create a new session forked from an existing one');
    deps.stdout('  export <id>            print a session as portable JSONL');
    deps.stdout('');
    deps.stdout('  trace [--json]         print the local trace (requires telemetry.enabled)');
    deps.stdout(
      '  side-effects <id>      list side effects whose outcome is UNKNOWN after a crash',
    );
    deps.stdout('  side-effects <id> resolve <sid> --found <completed|failed>');
    deps.stdout('  instructions           show the AGENTS.md files in effect, with provenance');
    deps.stdout('  skills                 list discoverable skills');
    deps.stdout(
      '  memory [add|consolidate]  show/store long-term memory, or dedup+conflict-resolve it',
    );
    deps.stdout('  mcp [trust <server>]   show configured MCP servers, or trust a project server');
    deps.stdout('');
    deps.stdout('  task create <subject> --active <form> [--blocked-by 1,2] [--desc ...]');
    deps.stdout(
      '  task list [--all] | get <id> | claim <id> --owner <o> | start/complete/release/delete <id>',
    );
    deps.stdout("  task todo '<json array>'   normalize a turn-local TodoWrite checklist");
    deps.stdout('  background start --category <c> [--thread <id>] -- <cmd> <argv...>');
    deps.stdout('  background list [--thread <id>] | status <id> | cancel <id>');
    deps.stdout(
      '  cron add --recurring "<expr>" | --one-shot --at <ms>|--in <sec>  --thread <id> [-- <cmd> ...]',
    );
    deps.stdout(
      '  cron list | remove <id> | run [--now <ms>]   run = one supervisor poll, fires due jobs',
    );
    deps.stdout('');
    deps.stdout(
      "  team run --team <n> --members <k> --tasks '<json>' [--profile <p>] [--keep-worktrees]",
    );
    deps.stdout(
      '       lead: create dependent tasks, launch isolated teammates in worktrees, approve, collect',
    );
    deps.stdout(
      '  team status --team <n> [--now <ms>]   member incarnations: running/lost/stopped',
    );
    deps.stdout('');
    deps.stdout('  flags: --profile <plan|ask|auto-accept-edits|yolo>  --model <name>  --json');
    deps.stdout(
      '         --prompt-mode <minimal|default|proactive|coordinator>  --worktree <slug>',
    );
    deps.stdout('         --skill <name>  run a skill by name');
    return 0;
  }

  if (command === 'doctor') {
    const report = runDoctor({ projectRoot: deps.cwd, env: deps.env, homeDir: homedir() });
    for (const line of report.lines) deps.stdout(line);
    return report.healthy ? 0 : 3;
  }

  if (command === 'run') {
    return runCommand(deps, rest, null);
  }

  if (
    command === 'trace' ||
    command === 'side-effects' ||
    command === 'instructions' ||
    command === 'skills' ||
    command === 'memory' ||
    command === 'mcp'
  ) {
    return inspectCommand(deps, command, rest);
  }

  if (command === 'resume') {
    const [threadArg, ...promptParts] = rest;
    if (threadArg === undefined) {
      deps.stderr('resume: a session id is required');
      return 1;
    }
    return runCommand(deps, promptParts, threadArg as ThreadId);
  }

  if (command === 'sessions' || command === 'fork' || command === 'export') {
    return sessionCommand(deps, command, rest);
  }

  if (command === 'task') {
    return await taskCommand(deps, rest);
  }

  if (command === 'background') {
    return backgroundCommand(deps, rest);
  }

  if (command === 'cron') {
    return cronCommand(deps, rest);
  }

  if (command === 'team') {
    return teamCommand(deps, rest);
  }

  if (command === 'maintenance') {
    return maintenanceCommand(deps, rest);
  }

  deps.stderr(`unknown command: ${command}`);
  return 1;
}

/**
 * Session-store maintenance (SS-07): retention pruning, VACUUM, and online backup. Operates on this
 * workspace's `.qwen-harness/sessions.sqlite`.
 */
async function maintenanceCommand(deps: CliDeps, rest: readonly string[]): Promise<number> {
  const { flags, positional } = parseFlags(rest);
  const sub = positional[0];
  const store = openStore(deps);
  try {
    if (sub === 'prune') {
      const days = Number(flags['older-than-days'] ?? '30');
      if (!Number.isFinite(days) || days <= 0) {
        deps.stderr('maintenance prune: --older-than-days must be a positive number');
        return 1;
      }
      const result = store.prune({ olderThanMs: days * 24 * 60 * 60 * 1000, now: deps.now() });
      deps.stdout(
        `pruned ${result.threadsPruned} session(s) older than ${days}d (${result.eventsPruned} events)`,
      );
      return 0;
    }
    if (sub === 'vacuum') {
      store.vacuum();
      deps.stdout('vacuum complete — freed space reclaimed');
      return 0;
    }
    if (sub === 'backup') {
      const dest = positional[1];
      if (dest === undefined) {
        deps.stderr('maintenance backup: a destination path is required');
        return 1;
      }
      await store.backup(dest);
      deps.stdout(`backup written to ${dest}`);
      return 0;
    }
    deps.stderr(
      'maintenance: expected `prune [--older-than-days N]`, `vacuum`, or `backup <path>`',
    );
    return 1;
  } finally {
    store.close();
  }
}

async function runCommand(
  deps: CliDeps,
  args: readonly string[],
  resumeThreadId: ThreadId | null,
): Promise<number> {
  const { flags, positional } = parseFlags(args);
  const prompt = positional.join(' ').trim();

  const asJson = 'json' in flags;
  // `--quiet` silences INFORMATIONAL chrome (status lines, recovery/MCP notes) for a machine caller;
  // it never silences the actual result (stdout) or a genuine error (those a script must still see).
  const quiet = 'quiet' in flags;

  // Prompt mode (IN-09). It is prompt text and tool VISIBILITY, never authority — so it is resolved
  // here, entirely outside `loadRunAuthority`. `agent-defined` needs a validated agent definition
  // (granted-tools list, section bodies) that a direct `run` has no source for, so it is rejected
  // rather than silently degraded to "no tools".
  let promptMode: PromptMode = 'default';
  if (flags['prompt-mode'] !== undefined) {
    const parsed = PromptModeSchema.safeParse(flags['prompt-mode']);
    if (!parsed.success) {
      deps.stderr(
        `run: unknown prompt mode "${flags['prompt-mode']}" ` +
          `(expected minimal|default|proactive|coordinator|agent-defined)`,
      );
      return 1;
    }
    if (parsed.data === 'agent-defined') {
      deps.stderr(
        `run: prompt mode "agent-defined" requires an agent definition; not available in a direct run`,
      );
      return 1;
    }
    promptMode = parsed.data;
  }

  // Configuration is LOADED, not assumed. Flags are just the highest-precedence config source, so
  // they flow through the same resolution as managed/user/project files — and are clamped by the
  // managed ceiling like everything else. A `--profile yolo` on a host whose administrator set
  // `maxProfile: ask` resolves to `ask`; it is not an escape hatch.
  let authority: RunAuthority;
  try {
    const cliOverrides: Record<string, unknown> = {};
    if (flags['profile'] !== undefined) {
      const requested = resolveProfile(flags['profile']);
      if (requested === undefined) {
        deps.stderr(`run: unknown profile "${flags['profile']}"`);
        return 1;
      }
      cliOverrides['permissionProfile'] = requested;
    }
    if (flags['model'] !== undefined) cliOverrides['model'] = flags['model'];

    authority = loadRunAuthority({
      projectRoot: deps.cwd,
      homeDir: homedir(),
      env: deps.env,
      cli: cliOverrides,
      ...(deps.managedPath ? { managedPath: deps.managedPath } : {}),
    });
  } catch (err) {
    // A broken or hostile config file must fail the run, never be skipped into permissive defaults.
    deps.stderr(`run: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const profile = authority.profile;
  const model = authority.config.model.value;

  // Say so when the ceiling actually bound the request. Silently downgrading authority is how a
  // user comes to believe a run had permissions it never had.
  if (flags['profile'] !== undefined && resolveProfile(flags['profile']) !== profile) {
    deps.stderr(
      `note: --profile ${flags['profile']} was clamped to "${profile}" by the managed ceiling ` +
        `(maxProfile=${authority.managedPolicy.maxProfile}).`,
    );
  }

  // State lives under the workspace so a run is self-contained and inspectable.
  const stateDir = join(deps.cwd, '.qwen-harness');
  mkdirSync(stateDir, { recursive: true });

  // Session-scoped worktree entry (GT-02): `--worktree <slug>` runs this session in a fresh git
  // worktree of the repo, so every tool resolves against the WORKTREE, not the main checkout. This is
  // DISTINCT from a teammate's cwd override (`team teammate --worktree`, where the LEAD assigns a
  // teammate its cwd): here the SESSION itself enters the worktree, while its durable state stays
  // under the repo. The worktree persists after the run for inspection; "exit" is `git worktree
  // remove` (or the `worktrees` recovery path), never a silent discard of work.
  let sessionWorkspace = deps.cwd;
  // Recorded here (before the hook runtime exists) so WorktreeCreate / CwdChanged can be fired once
  // the runtime is constructed below — the FACT is captured at the true site, the observe-only fire
  // happens as soon as there is something to fire it through.
  let enteredWorktree: { branch: string; path: string; from: string } | null = null;
  if (flags['worktree'] !== undefined) {
    try {
      const wt = createWorktree({ repoRoot: deps.cwd, slug: flags['worktree'], now: deps.now() });
      enteredWorktree = { branch: wt.branch, path: wt.path, from: sessionWorkspace };
      sessionWorkspace = wt.path;
      if (!quiet) deps.stderr(`note: session entered worktree ${wt.branch} at ${wt.path}`);
    } catch (e) {
      deps.stderr(`run: --worktree: ${e instanceof WorktreeError ? e.message : String(e)}`);
      return 1;
    }
  }
  const sessionsPath = join(stateDir, 'sessions.sqlite');
  // No session store yet → this is the first run in this workspace, which fires `Setup` below (HK-01).
  const firstRun = !existsSync(sessionsPath);
  const store = new EventStore({
    path: sessionsPath,
    clock: { now: deps.now, sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
    ids: realIds,
    // The redactor needs the credential VALUE to scrub it out of anything we persist. We do not
    // read it from the environment here: `EnvCredentialSource` lives at the provider boundary, the
    // one place permitted to read it (threat model: exactly one reader). Reading `deps.env` — an
    // alias of `process.env` — would have quietly evaded that rule, so the architecture gate now
    // rejects aliased reads too.
    secrets: [credential(deps) ?? undefined],
  });

  // CRASH RECOVERY, before anything else can consult `mayExecute` (SS-05).
  //
  // Any row the log still calls `in-flight` belongs to a process that no longer exists — we are the
  // process now, and we did not start it. It becomes `indeterminate`: honest, because we genuinely
  // do not know whether the write landed. It is NOT promoted to `known-failed`, and it is NEVER
  // replayed. The most this does is make a stuck side effect VISIBLE, so `side-effects` can list it
  // and a human can resolve it.
  const recovered = recoverInterrupted(store);
  if (recovered.promoted > 0 && !asJson && !quiet) {
    deps.stderr(
      `note: ${recovered.promoted} side effect(s) were interrupted by a previous crash and are now ` +
        `INDETERMINATE — their outcome is unknown and they will not be re-run. ` +
        `Inspect them with: qwen-harness side-effects <session>`,
    );
  }

  try {
    // Resume continues an existing thread; a fresh run creates one. Either way local history is
    // authoritative — resume reconstructs the model conversation from the durable log (PV-08).
    let threadId: ThreadId;
    let history: ReturnType<typeof reconstructHistory> = [];
    let pending = null as ReturnType<typeof findPendingApproval>;

    if (resumeThreadId !== null) {
      if (store.getThread(resumeThreadId) === undefined) {
        deps.stderr(`resume: no such session ${resumeThreadId}`);
        return 1;
      }
      threadId = resumeThreadId;
      history = reconstructHistory(store, threadId);
      pending = findPendingApproval(store, threadId);
      if (pending !== null && prompt.length > 0) {
        deps.stderr(
          `resume: this session is waiting for an approval (${pending.normalizedAction}). ` +
            `Answer it first with \`resume ${threadId}\` — an approval continues the same turn ` +
            `and is not a new message.`,
        );
        return 1;
      }
      if (pending === null && prompt.length === 0) {
        deps.stderr('resume: a prompt is required (this session has no pending approval)');
        return 1;
      }
    } else {
      if (prompt.length === 0) {
        deps.stderr('run: a prompt is required (e.g. `qwen-harness run "fix the failing test"`)');
        return 1;
      }
      threadId = realIds.next('thr') as ThreadId;
      store.append({
        threadId,
        correlationId: realIds.next('cor') as CorrelationId,
        permissionProfile: profile,
        actor: { kind: 'user', id: 'act_user01' as never },
        payload: { type: 'thread-created', cwd: deps.cwd, canonicalRepo: deps.cwd, name: null },
      });
    }

    // The approval channel. `--json` is a machine caller with nobody to ask, and so is a run with
    // no input channel at all: in both cases an `ask` action suspends the turn instead of being
    // silently allowed or silently dropped.
    const readLine = deps.readLine;
    const approvals =
      asJson || readLine === undefined
        ? undefined
        : interactiveApprovalGate({ stdout: deps.stdout, readLine });

    const homeDir = homedir();
    const clock = {
      now: deps.now,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };

    // --- telemetry (OB-01/OB-02) -------------------------------------------------------------
    // Opt-in: with `telemetry.enabled` false this constructs nothing and opens no file, and the
    // runtime below is handed no tracer, so not one decorator is installed.
    const telemetry = openTelemetry({
      enabled: authority.config.telemetry.value,
      level: authority.config.telemetryLevel.value,
      retentionDays: authority.config.telemetryRetentionDays.value,
      dir: join(stateDir, 'trace'),
      clock,
      secrets: [credential(deps) ?? undefined],
    });

    // --- hooks (HK-01..HK-05) ----------------------------------------------------------------
    const hookConfig = loadHooks({ workspaceRoot: deps.cwd, homeDir });
    const hooks = createHookRuntime({
      registrations: hookConfig.registrations,
      clock,
      env: deps.env,
      correlationId: threadId,
      // Every handler that ran becomes a durable `hook-fired` event, so a hook that blocked a tool
      // is in the audit trail rather than only in a log line.
      onFired: (fired) =>
        void store.append({
          threadId,
          correlationId: realIds.next('cor') as CorrelationId,
          permissionProfile: profile,
          actor: { kind: 'system', id: 'act_system' as never },
          payload: {
            type: 'hook-fired',
            event: fired.event,
            handler: fired.handler,
            outcome: fired.outcome,
            durationMs: Math.max(0, fired.durationMs),
          },
        }),
    });

    // The guarded, observe-only fire callback for the orchestration sites outside the turn engine.
    const fireHook = observeHook(hooks);

    // The very first run in this workspace fires Setup once (HK-01) — a hook can do one-time
    // provisioning before anything else happens.
    if (firstRun && hooks !== null) {
      await hooks.fire('Setup', { data: { workspace: deps.cwd } });
    }

    // A `--worktree` session genuinely created a worktree and moved this session's working directory
    // into it (GT-02). Fire WorktreeCreate and CwdChanged now that the hook runtime exists — the
    // creation/move already happened above; these observe-only events report it.
    if (enteredWorktree !== null) {
      await fireHook?.('WorktreeCreate', {
        branch: enteredWorktree.branch,
        path: enteredWorktree.path,
      });
      await fireHook?.('CwdChanged', { from: enteredWorktree.from, to: enteredWorktree.path });
    }

    // A prompt mode other than the default is a genuine configuration change for this run (IN-09):
    // `--prompt-mode` activates a mode that changes the model's tool visibility. ConfigChange reports
    // it (permission/isolation are unchanged — a mode is prompt text and tool visibility, never
    // authority). Observe-only; the mode was already selected above.
    if (flags['prompt-mode'] !== undefined) {
      await fireHook?.('ConfigChange', {
        key: 'prompt-mode',
        to: promptMode,
        permissionChanged: false,
        isolationChanged: false,
      });
    }

    // --- repository instructions (IN-06) ------------------------------------------------------
    const guidance = loadGuidance({ workspaceRoot: deps.cwd, homeDir });
    // IN-06: "loading emits InstructionsLoaded". It is a hook event, so a hook can observe exactly
    // which guidance the agent is about to follow — the point of the event is auditability.
    if (hooks !== null) {
      await hooks.fire('InstructionsLoaded', {
        paths: guidance.sources.map((s) => s.path),
        data: { count: guidance.sources.length },
      });
    }

    // --- skills (IN-01..IN-05) ---------------------------------------------------------------
    const skills = createSkillSurface({ workspaceRoot: deps.cwd, homeDir, clock });

    // --- memory (MM-01/MM-02/MM-05) -----------------------------------------------------------
    const redactor = createRedactor([credential(deps) ?? undefined]);
    const memory = createMemorySurface({
      workspaceRoot: deps.cwd,
      homeDir,
      env: deps.env,
      clock,
      redactor,
    });
    // Budgeted retrieval against THIS turn's prompt: at most 5 files / 50 KiB (MM-02).
    const retrieved = await memory.retrieveFor(prompt);

    // --- MCP (MC-01..MC-06) -------------------------------------------------------------------
    // One policy engine, shared. The MCP executor and the built-in pipeline are judged by the SAME
    // instance, so "no privileged MCP path" is a property of the object graph, not a promise.
    const policy = new PolicyEngine();

    // The MCP executor's policy context must see grants the human mints DURING the turn — and the
    // grant store is owned by the runtime, which does not exist yet because it needs the MCP surface.
    // The cycle is broken with a ref rather than by giving MCP its own grant store: two grant stores
    // would mean an approval granted for an MCP call was invisible to policy on the retry, and the
    // user would be asked the same question forever.
    const grantsRef: { current: GrantStore | null } = { current: null };
    const runtimeGrants = (): readonly Grant[] => grantsRef.current?.grants ?? [];
    const mcpConfig = loadMcpConfiguration({ workspaceRoot: deps.cwd, homeDir });
    const mcp = await connectMcp({
      configuration: mcpConfig,
      clock,
      ids: realIds,
      policy,
      policyContext: () => ({
        profile,
        managedPolicy: authority.managedPolicy,
        rules: authority.rules,
        grants: runtimeGrants(),
        workspaceRoot: deps.cwd,
        homeDir,
        now: deps.now(),
        actor: { kind: 'model', id: 'act_model1' as never },
      }),
      builtinNames: new Set(BUILTIN_TOOLS.map((t) => t.name)),
    });
    for (const failure of mcp?.failed ?? []) {
      // A broken MCP server degrades the run; it does not end it (MC-06). This is an informational
      // note on stderr, so `--quiet` (machine mode) suppresses it — the degradation is still
      // discoverable structurally; a script reads state, not stderr prose.
      if (!quiet)
        deps.stderr(`note: MCP server '${failure.server}' did not connect: ${failure.error}`);
    }

    // --- in-process tools (TL-02): retrieve_output + ask_user ---------------------------------
    // The third executor. `retrieve_output` reads the durable blob store (offloaded output, TL-10);
    // `ask_user` asks the human. Both run in-process because the sandbox worker can reach neither.
    // The user channel mirrors the approval channel's interactive-vs-headless choice EXACTLY: a
    // `--json` machine caller or a run with no input channel has nobody to ask, so `ask_user` gets a
    // headless channel that declines (never fabricates an answer); otherwise it prompts on the same
    // `readLine` the approval gate uses. It is judged by the SAME shared `policy` engine.
    const userInteraction =
      asJson || readLine === undefined
        ? headlessUserInteraction()
        : cliUserInteraction({ stdout: deps.stdout, readLine });
    const inProcessPolicyContext = (): PolicyContext => ({
      profile,
      managedPolicy: authority.managedPolicy,
      rules: authority.rules,
      grants: runtimeGrants(),
      workspaceRoot: sessionWorkspace,
      homeDir,
      now: deps.now(),
      actor: MODEL_ACTOR,
    });
    // --- subagent delegation (AG-02): the `delegate` in-process tool ---------------------------
    // A top-level (depth 0) `SubagentSupervisor` bounds this turn's children (depth/count/active +
    // authority intersection); the production runner drives each child through a nested `TurnEngine`
    // under a child authority that can never exceed this run's. The child's system prompt is the SAME
    // composed prompt as the parent — read lazily below, because the prompt is composed after this
    // surface is wired. Background children are collected via `supervisor.joinAll()` at turn end.
    let composedInstructions = '';
    const delegateSurface = createDelegateSurface({
      parentAuthority: authority,
      workspaceRoot: sessionWorkspace,
      homeDir,
      instructions: () => composedInstructions,
      clock: { now: deps.now },
      ids: realIds,
      store,
      policy,
      parentThreadId: threadId,
      model,
      parentModelCalls: DEFAULT_BUDGET.maxModelCallsPerTurn,
      parentWallMs: DEFAULT_BUDGET.maxWallMs,
      ...(deps.provider ? { provider: deps.provider } : {}),
      ...(fireHook ? { fireHook } : {}),
    });
    const inProcess = inProcessSurface({
      blob: store,
      userInteraction,
      policy,
      policyContext: inProcessPolicyContext,
      workspaceRoot: sessionWorkspace,
      clock: { now: deps.now },
      delegate: delegateSurface.delegate,
      ...(fireHook ? { fireHook } : {}),
    });

    // --- the system prompt (IN-07/IN-08/IN-10) -------------------------------------------------
    // Composed from sections built from REAL runtime state, each with a deterministic cache key —
    // not the single hard-coded string literal that used to live here.
    // Prompt-mode tool restriction (IN-09). A mode can only REMOVE tools, never add. `coordinator`
    // (no-mutation) drops every built-in that mutates the world — a tool "mutates" iff its contract's
    // annotations are not `readOnly`. The filtered set is applied to BOTH the model's offered tools
    // (below) AND the executable pipeline (`builtins`, further down), so the restriction is real, not
    // a cosmetic prompt edit: a coordinator that tries to write is refused by the pipeline itself.
    const modeAllowedBuiltins = new Set(
      toolsForMode(
        { mode: promptMode },
        BUILTIN_TOOLS.map((t) => ({ name: t.name, mutates: !t.annotations.readOnly })),
      ).map((d) => d.name),
    );
    const runBuiltins = BUILTIN_TOOLS.filter((t) => modeAllowedBuiltins.has(t.name));
    const toolNames = [
      ...runBuiltins.filter((t) => t.availableIn.includes(profile)).map((t) => t.name),
      ...(mcp?.surface.tools ?? []).map((t) => t.name),
      // The in-process tools (TL-02) are available in every mode, so the prompt's tool list names them.
      ...inProcess.tools.map((t) => t.name),
    ];
    const turnNumber = countTurns(store, threadId) + 1;

    // --- context / compaction (CX-01..CX-06) --------------------------------------------------
    // The number the CLI used to hard-code as `0`. It is now computed from the reconstructed
    // history against the provider's real context window (minus reserved headroom), so the prompt's
    // context section tells the model the truth. `compactions` is read from the durable log.
    const guidanceChars = guidance.sources.reduce((n, s) => n + s.chars, 0);
    const utilizationPercent = contextUtilizationPercent(
      history,
      DASHSCOPE_DEFAULTS.contextWindowSize,
      guidanceChars,
    );
    const compactions = countCompactions(store, threadId);

    const composed = composePrompt(guidance, {
      agentName: 'qwen-harness',
      model,
      profile,
      workspaceRoot: sessionWorkspace,
      repo: deps.cwd,
      toolNames,
      threadId,
      turn: turnNumber,
      memory: memorySectionState(retrieved),
      mcp:
        mcp && mcp.connected.length > 0
          ? {
              servers: mcp.connected.map((c) => c.server),
              schemaDigest: mcp.surface.tools.map((t) => t.name).join(','),
            }
          : null,
      context: { utilizationPercent, compactions },
      mode: promptMode,
    });
    // A delegated subagent's turn is composed with the SAME system prompt as this parent turn. The
    // delegate surface (wired above, before the prompt existed) reads this lazily at spawn time.
    composedInstructions = composed.instructions;

    // The context manager the engine calls before every model round. Large tool outputs offload to
    // the durable blob store, the transcript prunes, and compaction fires on real transcript growth
    // past the proactive threshold or on provider overflow — never a forced flag.
    const contextManager = createContextManager({
      store,
      contextWindow: DASHSCOPE_DEFAULTS.contextWindowSize,
      clock,
      ids: realIds,
      actor: MODEL_ACTOR,
      ...(fireHook ? { fireHook } : {}),
    });

    const runtime = createHarnessRuntime({
      workspaceRoot: sessionWorkspace,
      authority,
      model,
      // Sent on EVERY provider request (IN-10). Caching is an optimization over identical content;
      // it never changes what is transmitted.
      instructions: composed.instructions,
      homeDir,
      clock: { now: deps.now },
      ids: realIds,
      store,
      policy,
      // The mode-restricted built-in set (IN-09). `coordinator` hands the pipeline a registry with no
      // mutation tools, so the restriction is enforced where execution happens — not merely advertised.
      builtins: runBuiltins,
      context: contextManager,
      inProcess,
      ...(approvals ? { approvals } : {}),
      ...(deps.provider ? { provider: deps.provider } : {}),
      ...(telemetry.tracer ? { tracer: telemetry.tracer, detailedTrace: telemetry.detailed } : {}),
      ...(hooks ? { hooks: hooks.turnHooks } : {}),
      ...(mcp ? { mcp: mcp.surface } : {}),
    });
    grantsRef.current = runtime.grants;

    // --- skill invocation (IN-01/IN-05) --------------------------------------------------------
    // A skill is reached BY NAME through the registry, never by path. Its body is loaded only now —
    // discovery above read frontmatter only (two-level loading, IN-01). The prepared content is
    // UNTRUSTED text prepended to the user's turn: it instructs, it does not authorize. The
    // registry has already intersected the skill's `allowed-tools` with this run's authority, so a
    // skill asking for a shell inside a `plan` run simply does not get one.
    let userText = prompt;
    const skillName = flags['skill'];
    if (skillName !== undefined) {
      try {
        const invocation = skills.invoke({
          name: skillName,
          args: positional,
          invoker: 'user',
          profile,
          managed: authority.managedPolicy,
          toolNames,
        });
        const before = userText.length;
        userText = `${invocation.content}\n\n---\n\n${prompt}`.trim();
        // UserPromptExpansion (HK-01): a skill just expanded the user's prompt before the turn runs.
        // Observe-only — the expanded text is already assembled; the hook merely observes that it was.
        await fireHook?.('UserPromptExpansion', {
          kind: 'skill',
          name: skillName,
          charsBefore: before,
          charsAfter: userText.length,
        });
      } catch (e) {
        deps.stderr(`run: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }

    // A fresh (non-resumed) run begins a session; fire SessionStart symmetrically with SessionEnd so a
    // hook can set up per-session state (HK-01).
    if (hooks !== null && resumeThreadId === null && pending === null) {
      await hooks.fire('SessionStart', { data: { threadId: String(threadId) } });
    }

    if (hooks !== null && pending === null) {
      const submitted = await hooks.fire('UserPromptSubmit', { data: { chars: userText.length } });
      if (submitted.blocked) {
        deps.stderr(
          `run: blocked by hook ${submitted.blockReason?.hookId ?? '(unknown)'}: ` +
            `${submitted.blockReason?.reason.message ?? 'no reason given'}`,
        );
        return 2;
      }
    }

    const result: TurnOutcome =
      pending !== null
        ? await runtime.resumeTurn({
            threadId,
            turnId: pending.turnId,
            correlationId: pending.correlationId,
            history,
            pendingCalls: pending.pendingCalls,
          })
        : await runtime.runTurn({
            threadId,
            correlationId: realIds.next('cor') as CorrelationId,
            userText,
            history,
          });

    // Collect any BACKGROUND subagents this turn started (AG-02): the parent continued while they
    // ran, and `joinAll` awaits them in spawn order so nothing leaks an active slot. A child that
    // failed surfaces as `ok:false` in its conclusion (not a rejection); a genuinely broken runner
    // would reject, which we report rather than swallow.
    try {
      const backgroundConclusions = await delegateSurface.supervisor.joinAll();
      for (const c of backgroundConclusions) {
        // A settled background task is exactly the canonical Notification (HK-01): the system informs
        // the user that work they were not awaiting has completed. Observe-only.
        await fireHook?.('Notification', {
          kind: 'background-subagent-settled',
          agentId: c.agentId,
          label: c.label,
          ok: c.ok,
        });
        if (!quiet) {
          deps.stderr(
            `note: background subagent ${c.label} (${c.agentId}) finished ` +
              `${c.ok ? 'ok' : 'with failure'}: ${c.summary.slice(0, 200)}`,
          );
        }
      }
    } catch (e) {
      if (!quiet) {
        deps.stderr(
          `note: a background subagent failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (hooks !== null) {
      await hooks.fire('SessionEnd', { data: { state: result.state } });
    }
    await mcp?.close();

    // On a non-clean end, surface the underlying failure the engine recorded, so the user (and the
    // logs) see WHY, not just "failed".
    const detail =
      result.state === 'completed'
        ? null
        : (store
            .readThread(threadId)
            .map((e) => e.payload)
            .filter(
              (p): p is Extract<typeof p, { type: 'model-request-failed' }> =>
                p.type === 'model-request-failed',
            )
            .at(-1)?.message ?? null);

    const awaiting = result.state === 'awaiting-approval' ? result.pendingApproval : null;

    if (asJson) {
      deps.stdout(
        JSON.stringify({
          threadId,
          turnId: result.turnId,
          state: result.state,
          reason: result.reason,
          finalText: result.finalText,
          detail,
          pendingApproval: awaiting
            ? {
                callId: awaiting.callId,
                toolName: awaiting.toolName,
                action: awaiting.description,
                risk: awaiting.risk,
              }
            : null,
        }),
      );
    } else if (awaiting !== null) {
      deps.stdout(`this turn is waiting for an approval: ${awaiting.description}`);
      // The trailing "how to resume" chrome is decoration duplicating exit code 3; `--quiet` drops it.
      if (!quiet) {
        deps.stderr(
          `\n[awaiting-approval]  session ${threadId}\n` +
            `answer it with: qwen-harness resume ${threadId}`,
        );
      }
    } else {
      // MessageDisplay (HK-01): the assistant's final text is about to be rendered to the user.
      // Observe-only — fired only when there is genuine assistant text to display.
      if (result.finalText) {
        await fireHook?.('MessageDisplay', { chars: result.finalText.length });
      }
      deps.stdout(result.finalText || '(no text output)');
      // The trailing status line duplicates the exit code (and the JSON `state`/`reason`); drop it
      // under `--quiet` so a machine caller's stderr carries only genuine errors.
      if (!quiet) {
        deps.stderr(`\n[${result.state}: ${result.reason ?? 'done'}]  session ${threadId}`);
        if (detail) deps.stderr(`detail: ${detail}`);
      }
    }

    if (result.state === 'completed') return 0;
    // An unanswered approval is not a failure: it is a turn that is still alive and resumable.
    if (result.state === 'awaiting-approval') return 3;
    return 2;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A missing credential is a distinct, actionable exit code.
    if (/DASHSCOPE_API_KEY|credential|api key/i.test(message)) {
      deps.stderr(`run: ${message}`);
      return 3;
    }
    deps.stderr(`run failed: ${message}`);
    return 2;
  } finally {
    store.close();
  }
}

/**
 * The ONE read of the credential value in this app, and it happens at the provider's own boundary.
 * `EnvCredentialSource` lives in `provider-dashscope`, the only package permitted to read the key
 * (threat model: exactly one reader; `pnpm architecture` rule 6 enforces it, including for aliased
 * environments like `deps.env`). The value is used solely to seed redactors — it is never printed,
 * persisted, or traced.
 */
function credential(deps: CliDeps): string | null | undefined {
  return new EnvCredentialSource(undefined, deps.env).read();
}

/** How many turns this thread has already had, so the prompt's `session` section is accurate. */
function countTurns(store: EventStore, threadId: ThreadId): number {
  return store.readThread(threadId).filter((e) => e.payload.type === 'turn-started').length;
}

/** How many compactions this thread has recorded, for the prompt's real context status (CX-01). */
function countCompactions(store: EventStore, threadId: ThreadId): number {
  return store
    .readThread(threadId)
    .filter((e) => e.payload.type === 'item-appended' && e.payload.item.type === 'compaction')
    .length;
}

/**
 * The read-only inspection surface (OB-02, OB-03, SS-05, IN-06, MM-01, MC-05).
 *
 * Every subsystem this agent wired needed somewhere a human could SEE it. A trace nobody can read,
 * an indeterminate side effect nobody can list, an `AGENTS.md` whose influence nobody can explain —
 * each of those is a capability that exists in the code and not in the product.
 */
async function inspectCommand(
  deps: CliDeps,
  command: string,
  args: readonly string[],
): Promise<number> {
  const { flags, positional } = parseFlags(args);
  const asJson = 'json' in flags;
  const homeDir = homedir();
  const stateDir = join(deps.cwd, '.qwen-harness');
  const clock = {
    now: deps.now,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };

  if (command === 'trace') {
    const dir = join(stateDir, 'trace');
    const files = listTraceFiles(dir);
    if (files.length === 0) {
      deps.stdout(
        'no trace files. Telemetry is opt-in: set `telemetry.enabled: true` in .qwen-harness/config.json',
      );
      return 0;
    }
    // Newest day last, which is the order a reader wants.
    for (const file of files) {
      const { records, malformed } = readTraceFile(join(dir, file));
      if (malformed > 0) {
        // Never quietly swallowed: a trace with an unmentioned hole in it is worse than no trace.
        deps.stderr(`warning: ${file} has ${malformed} unparseable line(s)`);
      }
      for (const record of records) {
        if (asJson) {
          deps.stdout(JSON.stringify(record));
        } else {
          const fields = Object.entries(record.fields)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(' ');
          deps.stdout(
            `${new Date(record.ts).toISOString()} ${record.level.padEnd(5)} ${record.category}  ${record.message}${fields ? `  ${fields}` : ''}`,
          );
        }
      }
    }
    return 0;
  }

  if (command === 'instructions') {
    const guidance = loadGuidance({ workspaceRoot: deps.cwd, homeDir });
    if (asJson) {
      deps.stdout(JSON.stringify({ sources: guidance.sources }));
      return 0;
    }
    if (guidance.sources.length === 0) {
      deps.stdout('no AGENTS.md found (global, user, ancestor, repo-root, or nested)');
      return 0;
    }
    deps.stdout('repository instructions in effect (least specific first):');
    for (const source of guidance.sources) {
      deps.stdout(`  [${source.scope}] ${source.path}  (${source.chars} chars)`);
    }
    deps.stdout('');
    deps.stdout('these are CONTEXT, never authority: they cannot grant a tool or lift a deny.');
    return 0;
  }

  if (command === 'skills') {
    const skills = createSkillSurface({ workspaceRoot: deps.cwd, homeDir, clock });
    if (asJson) {
      deps.stdout(
        JSON.stringify({
          skills: skills.skills.map((s) => ({ name: s.name, source: s.source })),
          errors: skills.errors,
        }),
      );
      return 0;
    }
    if (skills.skills.length === 0) {
      deps.stdout('no skills found (looked for SKILL.md under .qwen-harness/skills/)');
    } else {
      deps.stdout('skills:');
      for (const line of renderCatalog(skills.catalog())) deps.stdout(`  ${line}`);
      deps.stdout('');
      deps.stdout('run one with: qwen-harness run --skill <name> "<prompt>"');
    }
    for (const error of skills.errors) {
      // A skill that failed validation is REPORTED. Silently omitting it would leave the user
      // wondering why their skill "does nothing".
      deps.stderr(`  ✗ ${error.name}: ${error.message}`);
    }
    return 0;
  }

  if (command === 'memory') {
    const redactor = createRedactor([credential(deps) ?? undefined]);
    const canonicalRepoRoot = canonicalRepoRootOf(deps.cwd);
    const memory = createMemorySurface({
      workspaceRoot: deps.cwd,
      homeDir,
      env: deps.env,
      clock,
      redactor,
      ...(canonicalRepoRoot ? { canonicalRepoRoot } : {}),
    });

    if (positional[0] === 'add') {
      const name = flags['name'];
      const description = flags['description'] ?? '';
      const body = positional.slice(1).join(' ').trim();
      if (name === undefined || body === '') {
        deps.stderr('memory add: --name <name> and a body are required');
        return 1;
      }
      const outcome = await memory.add(
        {
          name,
          description,
          type: (flags['type'] ?? 'project') as never,
          body,
        },
        (flags['scope'] ?? 'project') as never,
      );
      if (outcome.kind === 'rejected') {
        deps.stderr(`memory add: ${outcome.reason}`);
        return 1;
      }
      deps.stdout(`stored ${outcome.memory.name} -> ${outcome.path}`);
      return 0;
    }

    if (positional[0] === 'consolidate') {
      const result = await memory.consolidate();
      if (asJson) {
        deps.stdout(
          JSON.stringify({
            kept: result.kept,
            conflicts: result.conflicts.length,
            retired: result.retired.length,
            removed: result.removed.length,
          }),
        );
        return 0;
      }
      deps.stdout(
        `consolidated: ${result.kept} kept, ${result.conflicts.length} conflict(s) resolved, ` +
          `${result.retired.length} retired, ${result.removed.length} file(s) removed`,
      );
      for (const conflict of result.conflicts) {
        deps.stdout(
          `  conflict '${conflict.name}': kept by ${conflict.resolvedBy}, ${conflict.losers.length} superseded`,
        );
      }
      return 0;
    }

    const { records, errors } = await memory.list();
    if (asJson) {
      deps.stdout(
        JSON.stringify({
          memories: records.map((r) => ({
            name: r.memory.name,
            type: r.memory.type,
            scope: r.provenance.scope,
            path: r.provenance.path,
          })),
          errors: errors.map((e) => ({ path: e.path, error: e.error.message })),
        }),
      );
      return 0;
    }
    if (records.length === 0) deps.stdout('no memories stored');
    for (const record of records) {
      deps.stdout(
        `  [${record.provenance.scope}] ${record.memory.name} (${record.memory.type})  ${record.provenance.path}`,
      );
    }
    for (const error of errors) deps.stderr(`  ✗ ${error.path}: ${error.error.message}`);
    return 0;
  }

  if (command === 'mcp') {
    const configuration = loadMcpConfiguration({ workspaceRoot: deps.cwd, homeDir });

    if (positional[0] === 'trust') {
      const server = positional[1];
      if (server === undefined) {
        deps.stderr('mcp trust: a server name is required');
        return 1;
      }
      trustServer({ workspaceRoot: deps.cwd, homeDir, server });
      deps.stdout(`trusted MCP server '${server}' for ${deps.cwd}`);
      deps.stdout('(recorded in your home directory — a repository cannot trust its own server)');
      return 0;
    }

    if (asJson) {
      deps.stdout(
        JSON.stringify({
          servers: configuration.resolved.map((s) => ({
            name: s.config.name,
            source: s.source,
            trusted: s.trusted,
            active: s.active,
            inactiveReason: s.inactiveReason,
          })),
          sources: configuration.sources,
        }),
      );
      return 0;
    }
    if (configuration.resolved.length === 0) {
      deps.stdout('no MCP servers configured (.qwen-harness/mcp.json)');
      return 0;
    }
    for (const server of configuration.resolved) {
      const status = server.active ? '✓ active' : `· inactive (${server.inactiveReason})`;
      deps.stdout(`  ${server.config.name}  [${server.source}]  ${status}`);
    }
    return 0;
  }

  // side-effects
  const [threadArg, sub, sideEffectId] = positional;
  if (threadArg === undefined) {
    deps.stderr('side-effects: a session id is required');
    return 1;
  }
  const threadId = threadArg as ThreadId;
  const store = new EventStore({
    path: join(stateDir, 'sessions.sqlite'),
    clock,
    ids: realIds,
    secrets: [credential(deps) ?? undefined],
  });

  try {
    if (store.getThread(threadId) === undefined) {
      deps.stderr(`side-effects: no such session ${threadId}`);
      return 1;
    }

    // Promote anything a dead process left `in-flight`, so the list below is complete.
    recoverInterrupted(store);

    if (sub === 'resolve') {
      const found = flags['found'];
      if (sideEffectId === undefined || (found !== 'completed' && found !== 'failed')) {
        deps.stderr(
          'side-effects resolve: usage: side-effects <session> resolve <side-effect-id> ' +
            '--found <completed|failed>',
        );
        return 1;
      }
      try {
        const outcome = resolveSideEffect(store, {
          threadId,
          sideEffectId,
          finding: found,
          correlationId: realIds.next('cor') as CorrelationId,
          actorId: 'act_user01',
        });
        deps.stdout(`${sideEffectId} recorded as ${outcome.state}`);
        if (found === 'failed') {
          deps.stderr(
            'note: this action may now be re-run. If it had in fact SUCCEEDED, re-running it will ' +
              'apply it a second time.',
          );
        }
        return 0;
      } catch (e) {
        deps.stderr(`side-effects: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }

    const stuck = listStuck(store, threadId);
    if (asJson) {
      deps.stdout(JSON.stringify({ threadId, indeterminate: stuck }));
      return 0;
    }
    if (stuck.length === 0) {
      deps.stdout('no indeterminate side effects in this session');
      return 0;
    }
    deps.stdout('side effects whose outcome is UNKNOWN (a process died while they were running):');
    deps.stdout('');
    for (const effect of stuck) {
      deps.stdout(
        `  ${effect.id}  ${effect.destructive ? '[DESTRUCTIVE]' : '[non-destructive]'}  ${effect.normalizedAction}`,
      );
    }
    deps.stdout('');
    deps.stdout('These will NOT be re-run, and nothing will guess what happened. Go and look at');
    deps.stdout('the workspace, then record what you FOUND:');
    deps.stdout('');
    deps.stdout(`  qwen-harness side-effects ${threadId} resolve <id> --found completed`);
    deps.stdout(`  qwen-harness side-effects ${threadId} resolve <id> --found failed`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `sessions` / `fork` / `export` — reads over the durable log. None of these run the model; they
 * are pure inspections and transformations of what is already persisted.
 */
function sessionCommand(deps: CliDeps, command: string, args: readonly string[]): number {
  const stateDir = join(deps.cwd, '.qwen-harness');
  const store = new EventStore({
    path: join(stateDir, 'sessions.sqlite'),
    clock: { now: deps.now, sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
    ids: realIds,
    // The redactor needs the credential VALUE to scrub it out of anything we persist. We do not
    // read it from the environment here: `EnvCredentialSource` lives at the provider boundary, the
    // one place permitted to read it (threat model: exactly one reader). Reading `deps.env` — an
    // alias of `process.env` — would have quietly evaded that rule, so the architecture gate now
    // rejects aliased reads too.
    secrets: [new EnvCredentialSource(undefined, deps.env).read() ?? undefined],
  });

  try {
    if (command === 'sessions') {
      const sessions = listSessions(store);
      if (sessions.length === 0) {
        deps.stdout('no sessions in this workspace');
        return 0;
      }
      for (const s of sessions) {
        const lineage = s.forkedFrom ? ` (forked from ${s.forkedFrom})` : '';
        const pending = findPendingApproval(store, s.threadId);
        const waiting = pending ? `  [awaiting approval: ${pending.normalizedAction}]` : '';
        deps.stdout(
          `${s.threadId}  turns=${s.turns}  ${s.name ?? '(unnamed)'}${lineage}${waiting}`,
        );
      }
      return 0;
    }

    const [id] = args;
    if (id === undefined) {
      deps.stderr(`${command}: a session id is required`);
      return 1;
    }
    const threadId = id as ThreadId;

    if (command === 'export') {
      try {
        deps.stdout(exportSession(store, threadId, deps.now()));
        return 0;
      } catch (e) {
        deps.stderr(`export: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }

    // fork
    try {
      const newThreadId = realIds.next('thr') as ThreadId;
      const result = forkSession(store, threadId, newThreadId, {
        now: deps.now(),
        actorId: 'act_system',
        ids: realIds,
      });
      deps.stdout(
        `forked ${result.fromThreadId} -> ${result.newThreadId} (${result.copiedEvents} events copied)`,
      );
      return 0;
    } catch (e) {
      deps.stderr(`fork: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Durable work: task graph (WK-*), background lifecycle (BG-*), Cron (CR-*).
//
// Each of these opens the SAME event store `run` uses and reconstructs its state from the durable
// log — a task, a job, or a background result exists across a restart because it is never held only
// in memory. Every one loads the managed ceiling through `loadRunAuthority`, so scheduled and
// background work is bound by exactly the policy a normal run is bound by (nothing may exceed it).
// ---------------------------------------------------------------------------------------------

const CLI_USER: Actor = { kind: 'user', id: 'act_user01' as ActorId };
const CLI_SYSTEM: Actor = { kind: 'system', id: 'act_system' as ActorId };
/** The default thread a background task notifies when the caller names none. */
const BACKGROUND_THREAD = 'thr_background0' as ThreadId;

function clockOf(deps: CliDeps): Clock {
  return { now: deps.now, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
}

function openStore(deps: CliDeps): EventStore {
  const stateDir = join(deps.cwd, '.qwen-harness');
  mkdirSync(stateDir, { recursive: true });
  return new EventStore({
    path: join(stateDir, 'sessions.sqlite'),
    clock: clockOf(deps),
    ids: realIds,
    secrets: [credential(deps) ?? undefined],
  });
}

/**
 * The guarded, observe-only hook fire for a standalone durable-work command (e.g. `task`). Mirrors the
 * `run` path's hook construction so an event fired here goes through the SAME real engine — a
 * configured hook actually runs — rather than a test-only stub. Returns `undefined` when no hooks are
 * declared, so the command pays nothing when hooks are absent.
 */
function commandFireHook(deps: CliDeps): FireHook | undefined {
  const loaded = loadHooks({ workspaceRoot: deps.cwd, homeDir: homedir() });
  const runtime = createHookRuntime({
    registrations: loaded.registrations,
    clock: clockOf(deps),
    env: deps.env,
    correlationId: realIds.next('cor'),
  });
  return observeHook(runtime);
}

/** Load the run authority (the managed ceiling) for a durable-work command, honouring `--profile`. */
function authorityForCommand(
  deps: CliDeps,
  flags: Record<string, string>,
): ReturnType<typeof loadRunAuthority> {
  const cliOverrides: Record<string, unknown> = {};
  if (flags['profile'] !== undefined) {
    const requested = resolveProfile(flags['profile']);
    if (requested !== undefined) cliOverrides['permissionProfile'] = requested;
  }
  return loadRunAuthority({
    projectRoot: deps.cwd,
    homeDir: homedir(),
    env: deps.env,
    cli: cliOverrides,
    ...(deps.managedPath ? { managedPath: deps.managedPath } : {}),
  });
}

function ensureThread(
  store: EventStore,
  threadId: ThreadId,
  deps: CliDeps,
  profile: PermissionProfile,
): void {
  if (store.getThread(threadId) !== undefined) return;
  store.append({
    threadId,
    correlationId: realIds.next('cor') as CorrelationId,
    permissionProfile: profile,
    actor: CLI_SYSTEM,
    payload: { type: 'thread-created', cwd: deps.cwd, canonicalRepo: deps.cwd, name: null },
  });
}

/** Split a token list at the first bare `--`: everything after it is a literal command + argv. */
function splitDoubleDash(args: readonly string[]): { pre: string[]; post: string[] } {
  const idx = args.indexOf('--');
  if (idx === -1) return { pre: [...args], post: [] };
  return { pre: args.slice(0, idx), post: args.slice(idx + 1) };
}

/** `task ...` — the durable dependency graph plus the ephemeral todo normalizer (WK-01..WK-08). */
async function taskCommand(deps: CliDeps, args: readonly string[]): Promise<number> {
  const { flags, positional } = parseFlags(args);
  const asJson = 'json' in flags;
  const [sub, ...rest] = positional;

  // `task todo` is turn-local working memory — no store, no persistence (WK-01/WK-02).
  if (sub === 'todo') {
    const json = rest.join(' ').trim();
    if (json.length === 0) {
      deps.stderr("task todo: a JSON array of todos is required (e.g. task todo '[{...}]')");
      return 1;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) throw new Error('todo input must be a JSON array');
      const projection = normalizeTodos(parsed as never);
      deps.stdout(JSON.stringify(projection));
      return 0;
    } catch (e) {
      deps.stderr(`task todo: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  const store = openStore(deps);
  const fireHook = commandFireHook(deps);
  try {
    const graph = openTaskGraph(store, clockOf(deps));
    switch (sub) {
      case 'create': {
        const subject = rest.join(' ').trim();
        const activeForm = flags['active'];
        if (subject.length === 0 || activeForm === undefined) {
          deps.stderr('task create: a subject and --active <activeForm> are required');
          return 1;
        }
        const blockedBy =
          flags['blocked-by'] !== undefined
            ? flags['blocked-by']
                .split(',')
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isInteger(n))
            : [];
        const task = await createTask(
          graph,
          {
            subject,
            activeForm,
            ...(flags['desc'] !== undefined ? { description: flags['desc'] } : {}),
            ...(blockedBy.length > 0 ? { blockedBy } : {}),
          },
          fireHook,
        );
        deps.stdout(asJson ? JSON.stringify(task) : renderTask(task));
        return 0;
      }
      case 'list': {
        const tasks = listTasks(graph, 'all' in flags);
        if (asJson) {
          deps.stdout(JSON.stringify({ tasks }));
          return 0;
        }
        if (tasks.length === 0) deps.stdout('no tasks');
        for (const task of tasks) deps.stdout(renderTask(task));
        return 0;
      }
      case 'get': {
        const id = Number(rest[0]);
        const task = Number.isInteger(id) ? getTask(graph, id) : undefined;
        if (task === undefined) {
          deps.stderr(`task get: no such task ${rest[0]}`);
          return 1;
        }
        deps.stdout(asJson ? JSON.stringify(task) : renderTask(task));
        return 0;
      }
      case 'claim': {
        const id = Number(rest[0]);
        const owner = flags['owner'];
        if (!Number.isInteger(id) || owner === undefined) {
          deps.stderr('task claim: a task id and --owner <name> are required');
          return 1;
        }
        const result = claimTask(graph, id, owner);
        if (!result.ok) {
          deps.stdout(asJson ? JSON.stringify(result) : `claim failed: ${result.reason}`);
          return 3;
        }
        deps.stdout(asJson ? JSON.stringify(result.task) : renderTask(result.task));
        return 0;
      }
      case 'start':
      case 'release': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) {
          deps.stderr(`task ${sub}: a task id is required`);
          return 1;
        }
        const task = sub === 'start' ? startTask(graph, id) : releaseTask(graph, id);
        deps.stdout(asJson ? JSON.stringify(task) : renderTask(task));
        return 0;
      }
      case 'complete':
      case 'delete': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) {
          deps.stderr(`task ${sub}: a task id is required`);
          return 1;
        }
        const result =
          sub === 'complete' ? await completeTask(graph, id, fireHook) : deleteTask(graph, id);
        if (asJson) {
          deps.stdout(JSON.stringify(result));
        } else {
          deps.stdout(renderTask(result.task));
          for (const t of result.newlyUnblocked) deps.stdout(`  unblocked ${renderTask(t)}`);
        }
        return 0;
      }
      default:
        deps.stderr('task: expected create|list|get|claim|start|complete|release|delete|todo');
        return 1;
    }
  } catch (e) {
    // A domain rejection (illegal transition, cycle, missing reference) is a user error, not a crash.
    deps.stderr(`task: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    store.close();
  }
}

/** `background ...` — start a sandboxed background task and inspect durable results (BG-01..BG-06). */
async function backgroundCommand(deps: CliDeps, args: readonly string[]): Promise<number> {
  const { pre, post } = splitDoubleDash(args);
  const { flags, positional } = parseFlags(pre);
  const asJson = 'json' in flags;
  const [sub, ...rest] = positional;
  const store = openStore(deps);

  try {
    if (sub === 'start') {
      const category = flags['category'] ?? 'local-shell';
      if (!isBackgroundCategory(category)) {
        deps.stderr(`background start: unknown category "${category}"`);
        return 1;
      }
      const [command, ...argv] = post;
      if (command === undefined) {
        deps.stderr('background start: a command is required after `--` (e.g. -- node -e "…")');
        return 1;
      }
      const authority = authorityForCommand(deps, flags);
      const threadId = (flags['thread'] ?? BACKGROUND_THREAD) as ThreadId;
      ensureThread(store, threadId, deps, authority.profile);

      // The operator launched exactly this command, so its ceiling preapproves it for unattended,
      // channel-less execution (CR-07). The managed ceiling still binds: a `plan` clamp seals shell.
      const runAuthority = authorityOf(authority, deps.cwd, [preapprovalRule(command, argv)]);
      const manager = createDurableBackgroundManager({
        store,
        threadId,
        turnId: realIds.next('trn') as TurnId,
        correlationId: realIds.next('cor') as CorrelationId,
        permissionProfile: authority.profile,
        actor: CLI_USER,
        clock: clockOf(deps),
        ids: realIds,
        pipeline: buildBackgroundPipeline(),
        homeDir: homedir(),
      });

      // A background task returns its id immediately (BG-02); a headless CLI then awaits its
      // settlement so the invocation reports a concrete outcome. The durable sink has already
      // recorded start and (on settle) completion, so the RESULT outlives this process.
      const view = manager.start({
        category,
        owner: CLI_USER,
        placement: 'background',
        permissionContext: runAuthority,
        payload: { command, argv, cwd: deps.cwd, authority: runAuthority },
      });
      const settled = await manager.awaitTask(view.id);

      if (asJson) {
        deps.stdout(
          JSON.stringify({
            taskId: settled.id,
            category: settled.category,
            threadId,
            status: settled.status,
            outputPreview: settled.outputPreview,
            exit: settled.exit,
          }),
        );
      } else {
        deps.stdout(`${settled.id}  [${settled.status}]  category=${settled.category}`);
        if (settled.outputPreview) deps.stdout(settled.outputPreview.trimEnd());
      }
      return settled.status === 'succeeded' ? 0 : 2;
    }

    if (sub === 'list') {
      const threadId = (flags['thread'] ?? BACKGROUND_THREAD) as ThreadId;
      const records = listDurableBackground(store, threadId);
      if (asJson) {
        deps.stdout(JSON.stringify({ threadId, tasks: records }));
        return 0;
      }
      if (records.length === 0) deps.stdout('no background tasks on this thread');
      for (const r of records) deps.stdout(`${r.taskId}  [${r.state}]  category=${r.category}`);
      return 0;
    }

    if (sub === 'status') {
      const taskId = rest[0];
      const threadId = (flags['thread'] ?? BACKGROUND_THREAD) as ThreadId;
      if (taskId === undefined) {
        deps.stderr('background status: a task id is required');
        return 1;
      }
      const record = listDurableBackground(store, threadId).find((r) => r.taskId === taskId);
      if (record === undefined) {
        deps.stderr(`background status: no task ${taskId} on ${threadId}`);
        return 1;
      }
      deps.stdout(asJson ? JSON.stringify(record) : `${record.taskId}  [${record.state}]`);
      return 0;
    }

    if (sub === 'cancel') {
      const taskId = rest[0];
      const threadId = (flags['thread'] ?? BACKGROUND_THREAD) as ThreadId;
      if (taskId === undefined) {
        deps.stderr('background cancel: a task id is required');
        return 1;
      }
      const record = listDurableBackground(store, threadId).find((r) => r.taskId === taskId);
      if (record === undefined) {
        deps.stderr(`background cancel: no task ${taskId} on ${threadId}`);
        return 1;
      }
      // A CLI process cannot signal a task hosted by an already-exited process (BG-07: the process
      // and the record are distinct lifetimes). What it CAN do is settle the DURABLE record: a task
      // still `in-flight` is cancelled by recording a terminal failure by its own side-effect id, so
      // it is no longer counted as running. An `indeterminate` task (a crash we cannot judge) is left
      // to the sanctioned `side-effects` inspection path (SS-05); a settled task is already done.
      if (record.state === 'in-flight') {
        const thread = store.getThread(threadId);
        store.append({
          threadId,
          turnId: realIds.next('trn') as TurnId,
          correlationId: realIds.next('cor') as CorrelationId,
          permissionProfile: thread?.permissionProfile ?? 'plan',
          actor: CLI_USER,
          payload: {
            type: 'side-effect-settled',
            sideEffectId: record.sideEffectId as SideEffectId,
            state: 'known-failed',
            resultDigest: null,
          },
        });
        deps.stdout(asJson ? JSON.stringify({ taskId, cancelled: true }) : `${taskId} cancelled`);
        return 0;
      }
      deps.stdout(
        asJson
          ? JSON.stringify({ taskId, cancelled: false, state: record.state })
          : `${taskId} is ${record.state}; not cancellable from a one-shot CLI`,
      );
      return 0;
    }

    deps.stderr('background: expected start|list|status|cancel');
    return 1;
  } catch (e) {
    deps.stderr(`background: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    store.close();
  }
}

/** `cron ...` — durable Cron jobs and the single-poll supervisor (CR-01..CR-07). */
async function cronCommand(deps: CliDeps, args: readonly string[]): Promise<number> {
  const { pre, post } = splitDoubleDash(args);
  const { flags, positional } = parseFlags(pre);
  const asJson = 'json' in flags;
  const [sub, ...rest] = positional;
  const store = openStore(deps);

  try {
    const authority = authorityForCommand(deps, flags);
    const ctx = openScheduler({
      store,
      ids: realIds,
      clock: clockOf(deps),
      permissionProfile: authority.profile,
      workspaceRoot: deps.cwd,
    });

    switch (sub) {
      case 'add': {
        const owner = flags['owner'] ?? 'cli';
        const threadId = (flags['thread'] ?? SCHEDULER_THREAD_ID) as ThreadId;
        ensureThread(store, threadId, deps, authority.profile);
        const tag = flags['tag'] ?? 'cli-cron';
        const [command, ...argv] = post;
        // A scheduled command is preapproved for unattended execution (CR-07); the ceiling still binds.
        const ceiling = authorityOf(
          authority,
          deps.cwd,
          command !== undefined ? [preapprovalRule(command, argv)] : [],
        );

        if (flags['recurring'] !== undefined) {
          try {
            parseCron(flags['recurring']);
          } catch (e) {
            deps.stderr(
              `cron add: invalid expression: ${e instanceof Error ? e.message : String(e)}`,
            );
            return 1;
          }
          const job = addCron(ctx, {
            kind: 'recurring',
            cronExpr: flags['recurring'],
            owner,
            threadId,
            tag,
            command: command ?? null,
            argv,
            authorityCeiling: ceiling,
          });
          deps.stdout(
            asJson ? JSON.stringify(job) : `${job.id}  recurring "${flags['recurring']}"`,
          );
          return 0;
        }

        // One-shot: an absolute `--at <epoch-ms>` or a relative `--in <seconds>` from `now`.
        let fireAt: number | undefined;
        if (flags['at'] !== undefined) fireAt = Number(flags['at']);
        else if (flags['in'] !== undefined) fireAt = deps.now() + Number(flags['in']) * 1000;
        if (fireAt === undefined || !Number.isFinite(fireAt)) {
          deps.stderr('cron add: --recurring "<expr>" or --one-shot with --at <ms> / --in <sec>');
          return 1;
        }
        const job = addCron(ctx, {
          kind: 'one-shot',
          fireAt,
          owner,
          threadId,
          tag,
          command: command ?? null,
          argv,
          authorityCeiling: ceiling,
        });
        deps.stdout(asJson ? JSON.stringify(job) : `${job.id}  one-shot @ ${fireAt}`);
        return 0;
      }

      case 'list': {
        const items = listCron(ctx, deps.now());
        if (asJson) {
          deps.stdout(JSON.stringify({ jobs: items }));
          return 0;
        }
        if (items.length === 0) deps.stdout('no cron jobs');
        for (const j of items) {
          const when = j.kind === 'recurring' ? `"${j.cronSource}"` : `@ ${j.fireAt}`;
          deps.stdout(`${j.id}  [${j.status}]  ${j.kind} ${when}  -> ${j.threadId}`);
        }
        return 0;
      }

      case 'remove': {
        const id = rest[0];
        if (id === undefined) {
          deps.stderr('cron remove: a job id is required');
          return 1;
        }
        const removed = ctx.scheduler.delete(id);
        deps.stdout(
          asJson
            ? JSON.stringify({ id, removed })
            : removed
              ? `removed ${id}`
              : `no such job ${id}`,
        );
        return removed ? 0 : 1;
      }

      case 'run': {
        // A crash during an earlier fire leaves an in-flight ledger row; surface it as indeterminate
        // before polling, exactly as `run` does, so a stuck fire is visible rather than silently stuck.
        store.recoverInterrupted();
        const now = flags['now'] !== undefined ? Number(flags['now']) : deps.now();
        if (!Number.isFinite(now)) {
          deps.stderr('cron run: --now must be an epoch-ms instant');
          return 1;
        }
        const result = await runSupervisor(ctx, {
          now,
          managed: authority.managedPolicy,
          homeDir: homedir(),
          workspaceRoot: deps.cwd,
        });
        if (asJson) {
          deps.stdout(JSON.stringify(result));
        } else {
          deps.stdout(`fired ${result.fired.length} job(s) as of ${now}`);
          for (const f of result.fired) {
            deps.stdout(
              `  ${f.jobId} -> ${f.threadId}  instant=${f.scheduledInstant}  ` +
                `profile=${f.effectiveProfile}  ${f.executed ? (f.ok ? 'ok' : `failed: ${f.detail ?? ''}`) : 'already-fired'}`,
            );
          }
        }
        return 0;
      }

      default:
        deps.stderr('cron: expected add|list|remove|run');
        return 1;
    }
  } catch (e) {
    deps.stderr(`cron: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    store.close();
  }
}

/** `team ...` — the multi-agent team subsystem (golden path 5): lead, teammate worker, and status. */
async function teamCommand(deps: CliDeps, args: readonly string[]): Promise<number> {
  const { flags, positional } = parseFlags(args);
  const asJson = 'json' in flags;
  const [sub] = positional;

  if (sub === 'status') {
    const team = flags['team'];
    if (team === undefined) {
      deps.stderr('team status: --team <name> is required');
      return 1;
    }
    const store = openStore(deps);
    try {
      const now = flags['now'] !== undefined ? Number(flags['now']) : deps.now();
      const members = teamStatus(store, team, Number.isFinite(now) ? now : deps.now());
      if (asJson) {
        deps.stdout(JSON.stringify({ team, members }));
        return 0;
      }
      if (members.length === 0) deps.stdout('no team members recorded');
      for (const m of members) {
        deps.stdout(`${m.member}  [${m.state}]  incarnation=${m.incarnation}`);
      }
      return 0;
    } finally {
      store.close();
    }
  }

  const store = openStore(deps);
  try {
    const authority = authorityForCommand(deps, flags);
    const teamFireHook = commandFireHook(deps);
    const teamDeps: TeamDeps = {
      store,
      ids: realIds,
      clock: clockOf(deps),
      homeDir: homedir(),
      cwd: deps.cwd,
      ...(teamFireHook ? { fireHook: teamFireHook } : {}),
    };

    if (sub === 'teammate') {
      const member = flags['member'];
      const incarnation = flags['incarnation'];
      const worktree = flags['worktree'];
      const team = flags['team'];
      if (
        member === undefined ||
        incarnation === undefined ||
        worktree === undefined ||
        team === undefined
      ) {
        deps.stderr('team teammate: --team, --member, --incarnation, --worktree are required');
        return 1;
      }
      // The lead-granted profile is re-clamped to managed policy HERE, so the ceiling binds this
      // process even if the launching lead were compromised. `authorityOf` builds the ceiling.
      const grantedAuthority = authorityOf(authority, worktree);
      const summary = await runTeammate(teamDeps, {
        team,
        member,
        incarnation,
        worktree,
        grantedAuthority,
        now: deps.now(),
      });
      deps.stdout(JSON.stringify(summary));
      return 0;
    }

    if (sub === 'run') {
      const team = flags['team'];
      if (team === undefined) {
        deps.stderr('team run: --team <name> is required');
        return 1;
      }
      if (deps.teamWorker === undefined) {
        deps.stderr(
          'team run: no teammate worker configured (a teammate must run as a REAL separate process)',
        );
        return 2;
      }
      const members = Number(flags['members'] ?? '2');
      if (!Number.isInteger(members) || members < 1) {
        deps.stderr('team run: --members must be a positive integer');
        return 1;
      }
      let tasks: ReturnType<typeof parseTaskSpecs>;
      try {
        tasks = parseTaskSpecs(flags['tasks'] ?? '[]');
      } catch (e) {
        deps.stderr(`team run: invalid --tasks: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      if (tasks.length === 0) {
        deps.stderr('team run: --tasks must declare at least one task');
        return 1;
      }
      const requested =
        flags['teammate-profile'] !== undefined
          ? (resolveProfile(flags['teammate-profile']) ?? authority.profile)
          : authority.profile;
      const leadOpts: LeadOptions = {
        team,
        tasks,
        members,
        requestedProfile: requested,
        worker: deps.teamWorker,
        now: deps.now(),
        ...(deps.managedPath !== undefined ? { managedPath: deps.managedPath } : {}),
        ...('keep-worktrees' in flags ? { keepWorktrees: true } : {}),
      };
      const summary = await runLead(teamDeps, authority, leadOpts);
      if (asJson) {
        deps.stdout(JSON.stringify(summary));
      } else {
        deps.stdout(
          `team ${summary.team}: ${summary.tasksCompleted}/${summary.tasksCreated} tasks completed`,
        );
        for (const m of summary.members) {
          deps.stdout(
            `  ${m.member}  profile=${m.grantedProfile}  exit=${m.exitCode}  removed=${m.worktreeRemoved}`,
          );
        }
      }
      // A clean run leaves no leaked worktree and completes every task; that is exit 0.
      const clean =
        summary.cleanShutdown &&
        summary.worktreesLeaked === 0 &&
        summary.tasksCompleted === summary.tasksCreated;
      return clean ? 0 : 2;
    }

    deps.stderr('team: expected run|teammate|status');
    return 1;
  } catch (e) {
    deps.stderr(`team: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    store.close();
  }
}

/**
 * The canonical repository root of `cwd` — the MAIN worktree, so every linked worktree of one repo
 * keys to the same `auto` memory store (MM-05). Git reports the shared common dir (`<main>/.git`) even
 * from a linked worktree; the canonical root is its parent. Returns undefined outside a repo (or on any
 * git failure), where the caller falls back to the workspace root as its own canonical root.
 */
function canonicalRepoRootOf(cwd: string): string | undefined {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    // Only the standard `<root>/.git` layout yields a canonical root by taking the parent; a bare repo
    // or unusual gitdir is left to the workspace-root fallback rather than guessed at.
    return commonDir && basename(commonDir) === '.git' ? dirname(commonDir) : undefined;
  } catch {
    return undefined;
  }
}

/** Flags that never take a value. Everything else consumes the following token. */
const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'no-color', 'keep-worktrees']);

export function parseFlags(args: readonly string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        // `--key=value` form is unambiguous.
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      // A boolean flag must NOT swallow the next token — that is how `run --json "prompt"` used to
      // lose its prompt. Only a value flag consumes what follows.
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = 'true';
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
