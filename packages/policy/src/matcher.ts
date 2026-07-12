/**
 * One matcher shape, used by managed rules, ordinary rules, and narrow rule-grants. Having a
 * single matcher means an administrator, a user, and an approval dialog all describe an action set
 * the same way — and it means there is exactly one place where matching can be wrong.
 *
 * Semantics: a matcher is an AND over the fields that are PRESENT, and an OR within each list.
 * An empty matcher (no fields) matches nothing. That is deliberate: a rule that accidentally
 * matches everything is a catastrophe when its effect is `allow`, and a no-op when its effect is
 * `deny`. Failing closed on an empty matcher makes the catastrophic direction impossible.
 */

import type { ActionKind, NormalizedAction } from './action.ts';
import { actionDigest, actionPaths } from './action.ts';
import { expandHome, matchGlob } from './paths.ts';

export interface ActionMatcher {
  readonly kinds?: readonly ActionKind[];
  /** Globs over canonical absolute paths. Matches if ANY of the action's paths matches. */
  readonly paths?: readonly string[];
  /** Globs over argv[0] of a shell/git action (`git`, `npm`, `/usr/bin/rm`, ...). */
  readonly commands?: readonly string[];
  /** Globs over the full shell command line. Matching a STRING is not a sandbox; it is a filter. */
  readonly commandLines?: readonly string[];
  /** Globs over a network host. */
  readonly hosts?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly mcpTools?: readonly string[];
  /** Exact `actionDigest`. The narrowest possible match. */
  readonly digest?: string;
}

function anyGlob(patterns: readonly string[], values: readonly string[]): boolean {
  return patterns.some((pattern) => values.some((value) => matchGlob(pattern, value)));
}

/**
 * Path globs in a matcher may use `~`, exactly like a protected-path pattern. Expansion happens
 * against an explicitly supplied home directory — this package reads no environment, so a rule can
 * never mean two different things in two different processes.
 */
export interface MatchContext {
  readonly homeDir: string;
}

export function isEmptyMatcher(matcher: ActionMatcher): boolean {
  return (
    matcher.kinds === undefined &&
    matcher.paths === undefined &&
    matcher.commands === undefined &&
    matcher.commandLines === undefined &&
    matcher.hosts === undefined &&
    matcher.mcpServers === undefined &&
    matcher.mcpTools === undefined &&
    matcher.digest === undefined
  );
}

export function matchesAction(
  matcher: ActionMatcher,
  action: NormalizedAction,
  ctx: MatchContext,
  digest: string = actionDigest(action),
): boolean {
  if (isEmptyMatcher(matcher)) return false;

  if (matcher.digest !== undefined && matcher.digest !== digest) return false;
  if (matcher.kinds !== undefined && !matcher.kinds.includes(action.kind)) return false;

  if (matcher.paths !== undefined) {
    const paths = actionPaths(action);
    const patterns = matcher.paths.map((p) => expandHome(p, ctx.homeDir));
    if (paths.length === 0 || !anyGlob(patterns, paths)) return false;
  }

  if (matcher.commands !== undefined) {
    const argv0 =
      action.kind === 'shell'
        ? action.argv[0]
        : action.kind === 'git-write'
          ? 'git'
          : action.kind === 'git-read'
            ? 'git'
            : undefined;
    if (argv0 === undefined || !anyGlob(matcher.commands, [argv0])) return false;
  }

  if (matcher.commandLines !== undefined) {
    if (action.kind !== 'shell' || !anyGlob(matcher.commandLines, [action.command])) return false;
  }

  if (matcher.hosts !== undefined) {
    if (action.kind !== 'network' || !anyGlob(matcher.hosts, [action.host])) return false;
  }

  if (matcher.mcpServers !== undefined) {
    if (action.kind !== 'mcp' || !anyGlob(matcher.mcpServers, [action.server])) return false;
  }

  if (matcher.mcpTools !== undefined) {
    if (action.kind !== 'mcp' || !anyGlob(matcher.mcpTools, [action.tool])) return false;
  }

  return true;
}
