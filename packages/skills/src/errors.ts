/**
 * Typed, actionable skill errors.
 *
 * Every failure in this package names the FILE and, where it exists, the FIELD. That is a hard
 * requirement (IN-04): a skill that cannot be trusted must fail loudly and explain itself. The two
 * outcomes we refuse are:
 *
 *   - a crash (an untyped `TypeError` deep inside a parser tells a user nothing), and
 *   - a silently-ignored skill (a skill that vanishes from the catalog because its frontmatter had
 *     a typo is indistinguishable, from the outside, from a skill an attacker suppressed).
 *
 * So discovery COLLECTS these instead of throwing, and the collection is part of its observable
 * result. The caller must decide what to do; it can never fail to notice.
 */

/** A frontmatter that failed to parse or failed the schema. Always names the file. */
export class SkillFrontmatterError extends Error {
  override readonly name = 'SkillFrontmatterError';
  /** Absolute path of the offending file. */
  readonly file: string;
  /** The frontmatter field at fault, or `null` when the document structure itself is wrong. */
  readonly field: string | null;
  /** 1-based line inside the file, when known. */
  readonly line: number | null;

  constructor(
    file: string,
    detail: string,
    options: { field?: string | null; line?: number | null } = {},
  ) {
    const field = options.field ?? null;
    const line = options.line ?? null;
    const where = line === null ? file : `${file}:${line}`;
    super(`invalid skill ${where}${field === null ? '' : ` (field "${field}")`}: ${detail}`);
    this.file = file;
    this.field = field;
    this.line = line;
  }
}

/** Why a path was refused. Each value is a distinct, testable attack shape. */
export type SkillScopeRejection =
  | 'empty'
  | 'too-long'
  | 'nul-byte'
  | 'absolute-path'
  | 'traversal'
  | 'escapes-root'
  | 'missing'
  | 'not-a-file'
  | 'no-root';

/**
 * A resource reference that did not resolve INSIDE the validated skill root (IN-02). This is the
 * security boundary of the package: it is thrown, never swallowed, and never downgraded to a
 * "best effort" resolution.
 */
export class SkillScopeError extends Error {
  override readonly name = 'SkillScopeError';
  readonly skill: string;
  /** The path exactly as it was requested, for the audit trail. Never re-resolved by the caller. */
  readonly requested: string;
  /** The canonical skill root the request had to stay inside, or `null` for a rootless skill. */
  readonly root: string | null;
  readonly rejection: SkillScopeRejection;

  constructor(args: {
    skill: string;
    requested: string;
    root: string | null;
    rejection: SkillScopeRejection;
    detail: string;
  }) {
    super(
      `skill "${args.skill}" resource ${JSON.stringify(args.requested)} rejected (${args.rejection}): ${args.detail}`,
    );
    this.skill = args.skill;
    this.requested = args.requested;
    this.root = args.root;
    this.rejection = args.rejection;
  }
}

/** A name that is not in the registry. The ONLY way to ask for a skill is by name (IN-02). */
export class SkillNotFoundError extends Error {
  override readonly name = 'SkillNotFoundError';
  readonly skill: string;
  constructor(skill: string, known: readonly string[]) {
    super(
      `no skill named "${skill}" is registered${known.length > 0 ? ` (known: ${known.join(', ')})` : ''}`,
    );
    this.skill = skill;
  }
}

/** A load that would exceed the loaded-content token budget (IN-05). Loud, never a silent drop. */
export class SkillBudgetError extends Error {
  override readonly name = 'SkillBudgetError';
  readonly skill: string;
  readonly budget: 'loaded-content-total';
  readonly usedTokens: number;
  readonly requestedTokens: number;
  readonly limitTokens: number;

  constructor(args: {
    skill: string;
    usedTokens: number;
    requestedTokens: number;
    limitTokens: number;
  }) {
    super(
      `loading skill "${args.skill}" needs ${args.requestedTokens} tokens but only ` +
        `${Math.max(0, args.limitTokens - args.usedTokens)} of the ${args.limitTokens}-token ` +
        `loaded-content budget remain (${args.usedTokens} already used)`,
    );
    this.skill = args.skill;
    this.budget = 'loaded-content-total';
    this.usedTokens = args.usedTokens;
    this.requestedTokens = args.requestedTokens;
    this.limitTokens = args.limitTokens;
  }
}

/** An invocation the skill's own declarations forbid (e.g. a user invoking a model-only skill). */
export class SkillInvocationError extends Error {
  override readonly name = 'SkillInvocationError';
  readonly skill: string;
  readonly reason: 'not-user-invocable' | 'fork-depth-exhausted';
  constructor(
    skill: string,
    reason: 'not-user-invocable' | 'fork-depth-exhausted',
    detail: string,
  ) {
    super(`skill "${skill}" cannot be invoked (${reason}): ${detail}`);
    this.skill = skill;
    this.reason = reason;
  }
}

/** A skill file that exists but could not be read. Always names the path (parity with config). */
export class SkillReadError extends Error {
  override readonly name = 'SkillReadError';
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(
      `skill file ${path}: read failed (${cause instanceof Error ? cause.message : String(cause)})`,
      {
        cause,
      },
    );
    this.path = path;
  }
}
