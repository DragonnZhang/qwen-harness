import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import {
  CommandExecutor,
  HookEngine,
  HookRegistry,
  isHookEvent,
  type FoldedHookResult,
  type HookEvent,
  type HookInput,
  type HookRegistration,
} from '@qwen-harness/hooks';
import type { Clock } from '@qwen-harness/protocol';
import type { TurnHooks } from '@qwen-harness/runtime';
import { z } from 'zod';

/**
 * Hook configuration and the turn-path adapter (HK-01..HK-05).
 *
 * `@qwen-harness/hooks` implemented 30 events, five handler kinds, typed outcomes, the 30-second
 * timeout, the Stop re-entry guard, and the no-elevation invariant — and NO application ever fired
 * an event, because there was no hook config key and nothing constructed a `HookEngine`. This file
 * gives hooks a file to be declared in and a place to run.
 *
 * WHAT A HOOK MAY DO, restated at the boundary where users meet it:
 *
 *   A hook may RESTRICT. It may not ELEVATE. A `PreToolUse` hook that returns `block` stops the
 *   tool; a hook that returns `allow` for something policy denied is recorded as an ignored
 *   elevation and changes nothing. That invariant is enforced inside the hook engine (HK-04), not
 *   here, and this adapter is careful not to launder it: `preToolUse` below reads `blocked` and
 *   nothing else. There is no code path from a hook's opinion to a widened authority.
 *
 * WHY ONLY `command` HANDLERS ARE CONFIGURABLE. The engine supports five handler kinds. A config
 * file can declare `command` handlers, which run as real child processes through the package's
 * `CommandExecutor` (real timeout, real cancellation, scrubbed child environment). `http`, `prompt`,
 * and `agent` handlers remain library-only and are REJECTED by this schema with a message that says
 * so, rather than accepted and silently ignored. An `http` handler needs a POST-with-body egress
 * path, and `@qwen-harness/network`'s broker exposes only a guarded GET `fetch(url)` — so an HTTP
 * hook cannot be honestly backed today. Accepting the key and dropping the hook would be the worst
 * of the three options: the user would believe their security hook was running.
 */

const HandlerSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('command'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Default 30 s, per HK-02. Bounded so a wedged hook cannot hang a turn forever. */
    timeoutMs: z.int().positive().max(600_000).optional(),
  }),
]);

const MatcherSchema = z.strictObject({
  toolName: z.string().min(1).optional(),
  pathGlob: z.string().min(1).optional(),
});

const HookEntrySchema = z.strictObject({
  id: z.string().min(1).max(128),
  event: z.string().refine(isHookEvent, {
    message: 'not a known hook event (see HOOK_EVENTS in @qwen-harness/hooks)',
  }),
  handler: HandlerSchema,
  matcher: MatcherSchema.optional(),
  /** Higher runs first. Ordering is deterministic, so a security hook can be made to run early. */
  priority: z.int().optional(),
});

export const HookConfigSchema = z.strictObject({
  version: z.literal(1).optional(),
  hooks: z.array(HookEntrySchema),
});

export type HookConfig = z.infer<typeof HookConfigSchema>;

/** The file a scope declares its hooks in. */
export const HOOKS_FILENAME = 'hooks.json';

export class HookConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'HookConfigError';
  }
}

export interface HookSource {
  readonly path: string;
  readonly scope: 'managed' | 'user' | 'project';
}

/**
 * The three scopes hooks may be declared in, weakest first. A managed hook is deployed by an
 * administrator; a project hook comes from the repository and is therefore the least trusted — but
 * note that trust is not what bounds a hook here. A hook cannot elevate from ANY scope, so a hostile
 * repository hook's worst case is refusing to let its own repository be edited.
 */
export function hookSources(opts: { workspaceRoot: string; homeDir: string }): HookSource[] {
  return [
    { path: join('/etc/qwen-harness', HOOKS_FILENAME), scope: 'managed' },
    { path: join(opts.homeDir, '.qwen-harness', HOOKS_FILENAME), scope: 'user' },
    { path: join(opts.workspaceRoot, '.qwen-harness', HOOKS_FILENAME), scope: 'project' },
  ];
}

export interface LoadedHooks {
  readonly registrations: readonly HookRegistration[];
  /** The files that actually contributed, for `doctor`. */
  readonly sources: readonly { path: string; scope: string; count: number }[];
}

/**
 * Read every scope's hook file. A file that is absent contributes nothing; a file that is PRESENT
 * but malformed is a hard error, exactly as a malformed config file is. Skipping a broken hook file
 * would disable a user's security hook at the moment they most need it to run.
 */
export function loadHooks(opts: { workspaceRoot: string; homeDir: string }): LoadedHooks {
  const registrations: HookRegistration[] = [];
  const sources: { path: string; scope: string; count: number }[] = [];
  const seen = new Set<string>();

  for (const source of hookSources(opts)) {
    // Two scopes can resolve to the SAME file — most obviously when a user's home directory is also
    // the workspace root. Without this guard every hook in that file would be registered twice and
    // would therefore RUN twice per event: a notification hook would double-notify, and a hook with
    // a side effect would perform it twice. The strongest scope that names the file wins.
    const resolved = resolvePath(source.path);
    if (seen.has(resolved)) continue;

    let text: string;
    try {
      text = readFileSync(source.path, 'utf8');
    } catch {
      continue; // absent: contributes nothing
    }
    seen.add(resolved);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new HookConfigError(source.path, `not valid JSON (${(e as Error).message})`);
    }

    const parsed = HookConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HookConfigError(source.path, parsed.error.issues.map(issueText).join('; '));
    }

    for (const entry of parsed.data.hooks) {
      registrations.push({
        // Namespaced by scope, so a project hook can never collide with (and thereby displace) a
        // managed one that happens to share an id.
        id: `${source.scope}:${entry.id}`,
        event: entry.event,
        handler: {
          kind: 'command',
          command: entry.handler.command,
          ...(entry.handler.args ? { args: entry.handler.args } : {}),
          ...(entry.handler.cwd ? { cwd: entry.handler.cwd } : {}),
          ...(entry.handler.env ? { env: entry.handler.env } : {}),
          ...(entry.handler.timeoutMs ? { timeoutMs: entry.handler.timeoutMs } : {}),
        },
        ...(entry.matcher ? { matcher: cleanMatcher(entry.matcher) } : {}),
        ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
      });
    }
    sources.push({ path: source.path, scope: source.scope, count: parsed.data.hooks.length });
  }

  return { registrations, sources };
}

/**
 * Build the matcher without ever setting a key to `undefined`. Under `exactOptionalPropertyTypes`,
 * `{ toolName: undefined }` and `{}` are different types — and, more to the point, a matcher with an
 * explicit `undefined` toolName is a matcher that matches nothing rather than everything.
 */
function cleanMatcher(matcher: {
  toolName?: string | undefined;
  pathGlob?: string | undefined;
}): NonNullable<HookRegistration['matcher']> {
  return {
    ...(matcher.toolName !== undefined ? { toolName: matcher.toolName } : {}),
    ...(matcher.pathGlob !== undefined ? { pathGlob: matcher.pathGlob } : {}),
  };
}

function issueText(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/** Reported for every handler that ran, so the caller can persist a durable `hook-fired` event. */
export interface HookFired {
  readonly event: string;
  readonly handler: string;
  readonly outcome: 'continue' | 'block' | 'context' | 'modify' | 'stop';
  readonly durationMs: number;
}

export interface HookRuntime {
  /** The runtime port. Absent registrations means this is `null` and the engine gets no hooks. */
  readonly turnHooks: TurnHooks;
  /** Fire any of the 30 events directly — `SessionStart`, `InstructionsLoaded`, `Stop`, … */
  fire(event: HookEvent, input: HookInput): Promise<FoldedHookResult>;
  readonly registrations: readonly HookRegistration[];
}

/**
 * Build the hook runtime. `onFired` is called once per handler that actually ran, so the caller can
 * append the durable `hook-fired` event — the hook engine is a pure decision component and does not
 * own the event store.
 */
export function createHookRuntime(opts: {
  registrations: readonly HookRegistration[];
  clock: Clock;
  env: Record<string, string | undefined>;
  correlationId: string;
  onFired?: (fired: HookFired) => void;
}): HookRuntime | null {
  if (opts.registrations.length === 0) return null;

  const registry = new HookRegistry();
  for (const registration of opts.registrations) registry.register(registration);

  const engine = new HookEngine({
    registry,
    clock: opts.clock,
    // The executor scrubs the child environment down to an allowlist, so a hook process does not
    // inherit the model credential. That is the package's guarantee; we simply do not defeat it by
    // handing it a wider base environment than the process actually has.
    commandExecutor: new CommandExecutor({ baseEnv: opts.env }),
  });

  const run = async (event: HookEvent, input: HookInput): Promise<FoldedHookResult> => {
    const started = opts.clock.now();
    const result = await engine.run(event, input, { correlationId: opts.correlationId });
    const durationMs = opts.clock.now() - started;
    for (const record of result.audit) {
      if (record.outcome === 'skipped') continue;
      opts.onFired?.({
        event,
        handler: record.hookId,
        outcome: foldOutcome(record.outcome),
        durationMs,
      });
    }
    return result;
  };

  return {
    registrations: opts.registrations,
    fire: run,
    turnHooks: {
      preToolUse: async (call) => {
        const result = await run('PreToolUse', {
          toolName: call.toolName,
          toolInput: call.arguments,
        });
        // ONLY `blocked` is read. A hook's `allow` is not consulted, because consulting it is how a
        // hook would come to override a policy deny. Restriction flows; elevation does not.
        return {
          blocked: result.blocked,
          reason: result.blockReason?.reason.message ?? null,
        };
      },
      postToolUse: async (call) => {
        const result = await run(call.ok ? 'PostToolUse' : 'PostToolUseFailure', {
          toolName: call.toolName,
          data: { ok: call.ok },
        });
        // The engine keeps the completed tool result durable regardless; `stopped` only decides
        // whether the turn continues to another model round (HK-05, `resultDurable`).
        return { stopContinuation: result.stopped };
      },
      fireLifecycle: async (event, data) => {
        // Observe-only lifecycle events (e.g. PostToolBatch). The engine passes the event name as a
        // plain string; we run it through the real engine so a configured hook actually fires (HK-01).
        await run(event as HookEvent, { ...(data ? { data } : {}) });
      },
    },
  };
}

/**
 * Collapse a hook outcome onto the five values the durable `hook-fired` event models. A failure is
 * recorded as `continue` because that is what it DID — a failed hook does not block the tool (the
 * engine's failure isolation, HK-05) — and the failure itself is surfaced separately by the engine's
 * `failures` list rather than being disguised as a block.
 */
function foldOutcome(outcome: string): HookFired['outcome'] {
  switch (outcome) {
    case 'block':
    case 'deny':
      return 'block';
    case 'context':
      return 'context';
    case 'modify':
      return 'modify';
    case 'stop':
      return 'stop';
    default:
      return 'continue';
  }
}
