/**
 * Skill sources and their precedence (IN-03).
 *
 * The matrix freezes the ten sources; this file freezes the ORDER between them, as DATA. Precedence
 * is a table, not a chain of `if`s, so it can be asserted as data in a test and read by a human in
 * one glance. Two skills may legitimately share a name (a project skill that specializes a bundled
 * one, for instance); exactly one of them must win, always the same one, for reasons anyone can
 * state.
 *
 * The order below is derived from the CONFIGURATION PRECEDENCE frozen in docs/product/defaults.md:
 *
 *     explicit CLI/session override > local project > shared project > user settings > built-in
 *     ... all of it under an immutable MANAGED ceiling that "cannot be relaxed by any lower source"
 *
 * mapped onto where skills come from:
 *
 *   managed (1000)              administrator-installed. IMMUTABLE CEILING: it always wins, and a
 *                               lower source may not shadow it — see `MANAGED_IS_IMMUTABLE`. This is
 *                               the row defaults.md forces: managed cannot be relaxed by anything.
 *   dynamic (900)               registered at runtime by the session/SDK — the "explicit session
 *                               override" row, and the only source with no file on disk.
 *   project (800)               the repository's own skills (the local/shared project rows).
 *   additional-directory (700)  a directory the user added to THIS session (`--add-dir`-style). It
 *                               is deliberate and session-scoped, so it outranks the user's global
 *                               config but not the repository the user is actually working in.
 *   user (600)                  the user's global skills.
 *   conditional (500)           context-activated overlays contributed by a conditional provider.
 *                               First-party but not explicitly configured, so it sits below user
 *                               config and above every third-party source.
 *   plugin (400)                installed plugins.
 *   mcp (300)                   skills advertised by an MCP server.
 *   legacy-command (200)        the legacy `commands/*.md` format, kept working (IN-03) but never
 *                               allowed to shadow a real skill.
 *   bundled (100)               what ships with the harness. The floor: anything can specialize it.
 *
 * The single security-relevant rule: a THIRD-PARTY source (plugin, mcp) can never shadow a
 * first-party one, and NOTHING can shadow managed.
 */

/** The ten sources, in the order the capability matrix lists them. */
export const SKILL_SOURCES = [
  'managed',
  'user',
  'project',
  'additional-directory',
  'legacy-command',
  'bundled',
  'plugin',
  'mcp',
  'dynamic',
  'conditional',
] as const;

export type SkillSource = (typeof SKILL_SOURCES)[number];

/** THE precedence table. Higher wins. Data, not control flow — a test asserts it as data. */
export const SOURCE_PRECEDENCE: Record<SkillSource, number> = {
  managed: 1000,
  dynamic: 900,
  project: 800,
  'additional-directory': 700,
  user: 600,
  conditional: 500,
  plugin: 400,
  mcp: 300,
  'legacy-command': 200,
  bundled: 100,
};

/**
 * Managed policy is "an immutable upper safety bound [that] cannot be relaxed by any lower source"
 * (defaults.md). For skills that means: a managed skill's name is RESERVED. A project, plugin, or
 * MCP skill with the same name does not replace it and does not merge with it — it is shadowed, and
 * the shadowing is reported.
 */
export const MANAGED_IS_IMMUTABLE = true as const;

/** True when `challenger` may replace `incumbent` for the same name. Never true against managed. */
export function outranks(challenger: SkillSource, incumbent: SkillSource): boolean {
  if (incumbent === 'managed') return false;
  return SOURCE_PRECEDENCE[challenger] > SOURCE_PRECEDENCE[incumbent];
}

/** Anything with a name, a source, and a stable tiebreak key can go through the resolver. */
export interface PrecedenceCandidate {
  readonly name: string;
  readonly source: SkillSource;
  /** A stable, unique identifier used ONLY to break a tie deterministically (usually a path). */
  readonly tiebreak: string;
}

/** A candidate that lost. Reported, never dropped: a shadowed skill is something a user must see. */
export interface ShadowedSkill<T extends PrecedenceCandidate> {
  readonly loser: T;
  readonly winner: T;
  readonly reason: 'lower-precedence' | 'managed-is-immutable' | 'tiebreak';
}

export interface PrecedenceResolution<T extends PrecedenceCandidate> {
  /** One winner per name, in ascending name order. Deterministic. */
  readonly effective: readonly T[];
  readonly shadowed: readonly ShadowedSkill<T>[];
}

/**
 * Resolve name collisions deterministically.
 *
 * Determinism has to hold even for two candidates from the SAME source with the same name (two
 * directories on the search path, say). Precedence cannot separate them, so the lexicographically
 * smaller `tiebreak` wins — arbitrary, but total, reproducible, and reported as a `tiebreak`
 * shadowing so nobody has to guess why one of the two disappeared.
 */
export function resolvePrecedence<T extends PrecedenceCandidate>(
  candidates: readonly T[],
): PrecedenceResolution<T> {
  const winners = new Map<string, T>();
  const shadowed: ShadowedSkill<T>[] = [];

  // Sort first so the outcome depends on the DATA, never on the order discovery happened to walk.
  const ordered = [...candidates].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const rank = SOURCE_PRECEDENCE[b.source] - SOURCE_PRECEDENCE[a.source];
    if (rank !== 0) return rank;
    return a.tiebreak < b.tiebreak ? -1 : a.tiebreak > b.tiebreak ? 1 : 0;
  });

  for (const candidate of ordered) {
    const incumbent = winners.get(candidate.name);
    if (incumbent === undefined) {
      winners.set(candidate.name, candidate);
      continue;
    }
    // `ordered` puts the winner first, so anything reaching here lost. Only the REASON varies.
    const reason: ShadowedSkill<T>['reason'] =
      incumbent.source === 'managed' && candidate.source !== 'managed'
        ? 'managed-is-immutable'
        : incumbent.source === candidate.source
          ? 'tiebreak'
          : 'lower-precedence';
    shadowed.push({ loser: candidate, winner: incumbent, reason });
  }

  return { effective: [...winners.values()], shadowed };
}
