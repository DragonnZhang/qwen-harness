/**
 * Hook registration plus matcher/condition filtering (HK-02).
 *
 * A registration binds (event, matcher, handler). The registry answers ONE question deterministically:
 * "for this invocation, which handlers run, and in what order?" Order is (priority ascending, then
 * registration order) — stable and explained, because a hook that fires in a surprising order is a
 * hook whose security effect is surprising.
 */
import type { DecisionOutcome } from '@qwen-harness/policy';

import type { HookEvent } from './events.ts';
import { isHookEvent } from './events.ts';
import type { HookOutcome } from './outcome.ts';

/** What a function (in-process) hook receives. Read-only: a hook observes and returns, never mutates. */
export interface HookInvocation {
  readonly event: HookEvent;
  /** The tool this event concerns, when applicable (PreToolUse, PostToolUse, ...). */
  readonly toolName?: string;
  /** The tool input at this point. A `modify` outcome PROPOSES a replacement; it is never applied here. */
  readonly toolInput?: Readonly<Record<string, unknown>>;
  /** Canonical paths this action touches, for path-glob matching. */
  readonly paths?: readonly string[];
  /** The policy decision already reached for this action, which a hook may only make MORE restrictive. */
  readonly currentDecision?: DecisionOutcome;
  /** Event-specific payload handed verbatim to command/HTTP/agent hooks. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  /** Cancellation. Every handler joins the abort tree (RT-06). */
  readonly signal: AbortSignal;
}

// --- handler forms (HK-02) -------------------------------------------------------------------

export interface FunctionHandler {
  readonly kind: 'function';
  run(invocation: HookInvocation): HookOutcome | Promise<HookOutcome>;
}

export interface CommandHandler {
  readonly kind: 'command';
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /**
   * Extra environment for the child, on TOP of the minimal safe allowlist. The provider key is
   * NEVER here and cannot be — the executor builds the child env from an allowlist that excludes it.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface HttpHandler {
  readonly kind: 'http';
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface PromptHandler {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly timeoutMs?: number;
}

export interface AgentHandler {
  readonly kind: 'agent';
  readonly agent: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export type HookHandler =
  FunctionHandler | CommandHandler | HttpHandler | PromptHandler | AgentHandler;

/** Filters that decide whether a binding applies to a given invocation. */
export interface HookMatcher {
  /** Exact tool name or a glob (`*`, `**`, `?`). */
  readonly toolName?: string;
  /** Glob matched against any of the invocation's canonical paths. */
  readonly pathGlob?: string;
  /** Arbitrary predicate. Runs in-process; must be pure and fast. */
  readonly condition?: (invocation: HookInvocation) => boolean;
}

export interface HookRegistration {
  readonly id: string;
  readonly event: HookEvent;
  readonly handler: HookHandler;
  readonly matcher?: HookMatcher;
  /** Lower runs first. Ties break on registration order. Default 0. */
  readonly priority?: number;
}

interface StoredHook {
  readonly registration: HookRegistration;
  readonly seq: number;
}

/** Escape a literal char for use inside a RegExp. */
function escapeChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate a glob to an anchored RegExp. `**` crosses `/`, `*` does not, `?` is one non-slash
 * char. Cached because a matcher is evaluated for every invocation of its event.
 */
const globCache = new Map<string, RegExp>();
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        // `**/` should also match zero directories, so swallow a following slash.
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char !== undefined) {
      out += escapeChar(char);
    }
  }
  out += '$';
  const re = new RegExp(out);
  globCache.set(glob, re);
  return re;
}

function matcherApplies(matcher: HookMatcher | undefined, invocation: HookInvocation): boolean {
  if (matcher === undefined) return true;
  if (matcher.toolName !== undefined) {
    if (invocation.toolName === undefined) return false;
    if (!globToRegExp(matcher.toolName).test(invocation.toolName)) return false;
  }
  if (matcher.pathGlob !== undefined) {
    const paths = invocation.paths ?? [];
    const re = globToRegExp(matcher.pathGlob);
    if (!paths.some((path) => re.test(path))) return false;
  }
  if (matcher.condition !== undefined && !matcher.condition(invocation)) return false;
  return true;
}

export class HookRegistry {
  readonly #byEvent = new Map<HookEvent, StoredHook[]>();
  readonly #ids = new Set<string>();
  #seq = 0;

  /**
   * Bind a hook. Ids are unique within a registry so a hook is always attributable by a stable id
   * in the audit trail (HK-04). Registering an unknown event name is a programming error, not a
   * silent no-op.
   */
  register(registration: HookRegistration): void {
    // Narrowed to `never` on the false branch, so copy to a plain string for the message; a caller
    // that smuggles an invalid event name (e.g. via `as never`) still gets a readable error.
    const eventName: string = registration.event;
    if (!isHookEvent(eventName)) {
      throw new Error(`unknown hook event: ${eventName}`);
    }
    if (this.#ids.has(registration.id)) {
      throw new Error(`duplicate hook id: ${registration.id}`);
    }
    this.#ids.add(registration.id);
    const bucket = this.#byEvent.get(registration.event) ?? [];
    bucket.push({ registration, seq: this.#seq++ });
    this.#byEvent.set(registration.event, bucket);
  }

  unregister(id: string): boolean {
    if (!this.#ids.delete(id)) return false;
    for (const [event, bucket] of this.#byEvent) {
      const next = bucket.filter((stored) => stored.registration.id !== id);
      if (next.length !== bucket.length) this.#byEvent.set(event, next);
    }
    return true;
  }

  /** Every registration for an event, in deterministic run order. */
  forEvent(event: HookEvent): readonly HookRegistration[] {
    return this.#ordered(this.#byEvent.get(event) ?? []);
  }

  /** The registrations that actually fire for this invocation, in deterministic run order. */
  matching(invocation: HookInvocation): readonly HookRegistration[] {
    const bucket = this.#byEvent.get(invocation.event) ?? [];
    const applicable = bucket.filter((stored) =>
      matcherApplies(stored.registration.matcher, invocation),
    );
    return this.#ordered(applicable);
  }

  #ordered(stored: readonly StoredHook[]): readonly HookRegistration[] {
    return [...stored]
      .sort((a, b) => {
        const pa = a.registration.priority ?? 0;
        const pb = b.registration.priority ?? 0;
        return pa !== pb ? pa - pb : a.seq - b.seq;
      })
      .map((entry) => entry.registration);
  }
}
