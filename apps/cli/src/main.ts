import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PolicyEngine, type Grant } from '@qwen-harness/policy';
import {
  resolveProfile,
  type Actor,
  type ActorId,
  type CorrelationId,
  type ThreadId,
} from '@qwen-harness/protocol';
import type { ModelProvider } from '@qwen-harness/provider-core';
import { DASHSCOPE_DEFAULTS, EnvCredentialSource } from '@qwen-harness/provider-dashscope';
import { BUILTIN_TOOLS } from '@qwen-harness/tools-builtin';
import { EventStore, createRedactor } from '@qwen-harness/storage';

import { interactiveApprovalGate } from './approvals.ts';
import { contextUtilizationPercent, createContextManager } from './context.ts';
import { runDoctor } from './doctor.ts';
import { createHookRuntime, loadHooks } from './hooks.ts';
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
import { listStuck, recoverInterrupted, resolveSideEffect } from './side-effects.ts';
import { createSkillSurface, renderCatalog } from './skills.ts';
import { listTraceFiles, openTelemetry, readTraceFile } from './telemetry.ts';
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
    deps.stdout('  memory [add ...]       show long-term memory with provenance, or store one');
    deps.stdout('  mcp [trust <server>]   show configured MCP servers, or trust a project server');
    deps.stdout('');
    deps.stdout('  flags: --profile <plan|ask|auto-accept-edits|yolo>  --model <name>  --json');
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

  deps.stderr(`unknown command: ${command}`);
  return 1;
}

async function runCommand(
  deps: CliDeps,
  args: readonly string[],
  resumeThreadId: ThreadId | null,
): Promise<number> {
  const { flags, positional } = parseFlags(args);
  const prompt = positional.join(' ').trim();

  const asJson = 'json' in flags;

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
  const store = new EventStore({
    path: join(stateDir, 'sessions.sqlite'),
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
  if (recovered.promoted > 0 && !asJson) {
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
      // A broken MCP server degrades the run; it does not end it (MC-06).
      deps.stderr(`note: MCP server '${failure.server}' did not connect: ${failure.error}`);
    }

    // --- the system prompt (IN-07/IN-08/IN-10) -------------------------------------------------
    // Composed from sections built from REAL runtime state, each with a deterministic cache key —
    // not the single hard-coded string literal that used to live here.
    const toolNames = [
      ...BUILTIN_TOOLS.filter((t) => t.availableIn.includes(profile)).map((t) => t.name),
      ...(mcp?.surface.tools ?? []).map((t) => t.name),
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
      workspaceRoot: deps.cwd,
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
    });

    // The context manager the engine calls before every model round. Large tool outputs offload to
    // the durable blob store, the transcript prunes, and compaction fires on real transcript growth
    // past the proactive threshold or on provider overflow — never a forced flag.
    const contextManager = createContextManager({
      store,
      contextWindow: DASHSCOPE_DEFAULTS.contextWindowSize,
      clock,
      ids: realIds,
      actor: MODEL_ACTOR,
    });

    const runtime = createHarnessRuntime({
      workspaceRoot: deps.cwd,
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
      context: contextManager,
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
        userText = `${invocation.content}\n\n---\n\n${prompt}`.trim();
      } catch (e) {
        deps.stderr(`run: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
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
      deps.stderr(
        `\n[awaiting-approval]  session ${threadId}\n` +
          `answer it with: qwen-harness resume ${threadId}`,
      );
    } else {
      deps.stdout(result.finalText || '(no text output)');
      deps.stderr(`\n[${result.state}: ${result.reason ?? 'done'}]  session ${threadId}`);
      if (detail) deps.stderr(`detail: ${detail}`);
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
    const memory = createMemorySurface({
      workspaceRoot: deps.cwd,
      homeDir,
      env: deps.env,
      clock,
      redactor,
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

/** Flags that never take a value. Everything else consumes the following token. */
const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'no-color']);

function parseFlags(args: readonly string[]): {
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
