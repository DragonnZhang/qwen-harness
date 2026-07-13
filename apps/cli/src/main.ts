import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveProfile, type CorrelationId, type ThreadId } from '@qwen-harness/protocol';
import type { ModelProvider } from '@qwen-harness/provider-core';
import { EnvCredentialSource } from '@qwen-harness/provider-dashscope';
import { EventStore } from '@qwen-harness/storage';

import { interactiveApprovalGate } from './approvals.ts';
import { runDoctor } from './doctor.ts';
import { loadRunAuthority, type RunAuthority } from './policy-from-config.ts';
import {
  exportSession,
  findPendingApproval,
  forkSession,
  listSessions,
  reconstructHistory,
} from './sessions.ts';
import { createHarnessRuntime, type TurnOutcome } from './wiring.ts';

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
    deps.stdout('  flags: --profile <plan|ask|auto-accept-edits|yolo>  --model <name>  --json');
    return 0;
  }

  if (command === 'doctor') {
    const report = runDoctor({ projectRoot: deps.cwd, env: deps.env });
    for (const line of report.lines) deps.stdout(line);
    return report.healthy ? 0 : 3;
  }

  if (command === 'run') {
    return runCommand(deps, rest, null);
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
    clock: { now: deps.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    ids: realIds,
    // The redactor needs the credential VALUE to scrub it out of anything we persist. We do not
    // read it from the environment here: `EnvCredentialSource` lives at the provider boundary, the
    // one place permitted to read it (threat model: exactly one reader). Reading `deps.env` — an
    // alias of `process.env` — would have quietly evaded that rule, so the architecture gate now
    // rejects aliased reads too.
    secrets: [new EnvCredentialSource(undefined, deps.env).read() ?? undefined],
  });

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

    const runtime = createHarnessRuntime({
      workspaceRoot: deps.cwd,
      authority,
      model,
      instructions:
        'You are a coding assistant working inside a sandboxed workspace. Use the available tools to inspect and edit files and run commands. Be concise.',
      homeDir: homedir(),
      clock: { now: deps.now },
      ids: realIds,
      store,
      ...(approvals ? { approvals } : {}),
      ...(deps.provider ? { provider: deps.provider } : {}),
    });

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
            userText: prompt,
            history,
          });

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
 * `sessions` / `fork` / `export` — reads over the durable log. None of these run the model; they
 * are pure inspections and transformations of what is already persisted.
 */
function sessionCommand(deps: CliDeps, command: string, args: readonly string[]): number {
  const stateDir = join(deps.cwd, '.qwen-harness');
  const store = new EventStore({
    path: join(stateDir, 'sessions.sqlite'),
    clock: { now: deps.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
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
