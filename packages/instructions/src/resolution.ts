/**
 * Repository instruction resolution (IN-06) — the PURE half.
 *
 * The disk read lives in `discovery.ts` (this package is the declared I/O owner for instruction
 * files). Everything here is a pure function of what discovery found, so precedence and provenance
 * are testable without a filesystem.
 *
 * Two invariants this file exists to guarantee:
 *
 *   1. PROVENANCE — every resolved instruction names the exact file and scope it came from, so a
 *      reader (or `doctor`) can always answer "why is the model being told this?".
 *   2. INSTRUCTIONS ARE CONTEXT, NEVER AUTHORITY — a resolved instruction carries `content` (text)
 *      and nothing else. There is deliberately no field through which a repository file could set a
 *      permission, relax a managed value, or grant a tool. More-specific instructions win over
 *      less-specific ones as *text*; they can never out-vote policy (SC-02, PS-07).
 */

import { untrusted, type UntrustedText } from '@qwen-harness/protocol';
import { sep as pathSep, resolve as resolvePath } from 'node:path';

/**
 * Instruction scopes, ordered least-specific to most-specific. The array order IS the base
 * precedence: a `nested` instruction outranks a `repo-root` one, which outranks an `ancestor` one,
 * and so on. Within a single scope, a deeper directory (closer to the accessed file) wins.
 */
export const INSTRUCTION_SCOPES = ['global', 'user', 'ancestor', 'repo-root', 'nested'] as const;
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number];

export const SCOPE_PRECEDENCE: Record<InstructionScope, number> = {
  global: 0,
  user: 1,
  ancestor: 2,
  'repo-root': 3,
  nested: 4,
};

/**
 * A machine-checkable statement of the security posture: instruction files are context only.
 * Referenced by tests and by anyone tempted to add an authority-bearing field to a resolved
 * instruction — the answer is no, and this constant is where the "no" is written down.
 */
export const INSTRUCTIONS_ARE_CONTEXT_ONLY = true as const;

/** Where an instruction physically came from. Always present on a resolved instruction. */
export interface InstructionProvenance {
  /** Absolute path of the instruction file. */
  readonly path: string;
  readonly scope: InstructionScope;
  /** Directory that contains the file (absolute). For `nested`, this is also its path scope. */
  readonly dir: string;
  /** Number of path segments in `dir`. Deeper = more specific = higher precedence within a scope. */
  readonly depth: number;
}

/** The raw output of discovery: a file that was read, not yet ranked. */
export interface DiscoveredInstruction {
  readonly path: string;
  readonly scope: InstructionScope;
  readonly dir: string;
  readonly depth: number;
  readonly rawText: string;
  /**
   * The directory subtree this instruction governs, or `null` for always-on scopes. Non-null only
   * for `nested`/path-scoped instructions: they apply ONLY when a path under `pathScope` is
   * accessed (defaults.md: "Nested and path-scoped instructions reattach only after a matching
   * file/path is accessed").
   */
  readonly pathScope: string | null;
}

/** A discovered instruction with deterministic precedence and its content marked untrusted. */
export interface ResolvedInstruction {
  readonly provenance: InstructionProvenance;
  /**
   * Instruction text. Repository-authored, therefore UNTRUSTED context — it may be rendered and
   * sent to the model, but it is not renderable as trusted chrome and it is not authority.
   */
  readonly content: UntrustedText;
  /** Total order; higher wins. Derived from scope rank first, then directory depth. */
  readonly precedence: number;
  /** Same meaning as `DiscoveredInstruction.pathScope`. */
  readonly pathScope: string | null;
}

/**
 * The InstructionsLoaded-shaped result (HK-01: the `InstructionsLoaded` hook fires with this). It
 * is the complete picture of what a directory tree told us, split into the always-on instructions
 * (already composed into `rootText`) and the full ranked list including path-scoped ones.
 */
export interface InstructionsLoaded {
  /** Every resolved instruction, sorted ascending by precedence (most-specific last). */
  readonly instructions: readonly ResolvedInstruction[];
  /** Composed text of the always-on instructions (every scope except path-scoped `nested`). */
  readonly rootText: string;
  /** Provenance of exactly the instructions that fed `rootText`, in the same order. */
  readonly rootProvenance: readonly InstructionProvenance[];
}

/**
 * A large multiplier keeps scope the primary sort key and directory depth the tie-break: two
 * instructions in the same scope are ordered by depth, but no depth can ever lift a lower scope
 * above a higher one. `100_000` comfortably exceeds any real directory depth.
 */
const SCOPE_STRIDE = 100_000;

export function precedenceOf(scope: InstructionScope, depth: number): number {
  return SCOPE_PRECEDENCE[scope] * SCOPE_STRIDE + depth;
}

/** Absolute segment count of a directory, used as the depth tie-break. */
export function directoryDepth(dir: string): number {
  return resolvePath(dir)
    .split(pathSep)
    .filter((s) => s.length > 0).length;
}

/**
 * Rank discovered instructions into a stable, deterministic order. Ties on `(scope, depth)` are
 * broken by path so the result never depends on filesystem iteration order.
 */
export function resolveInstructions(
  discovered: readonly DiscoveredInstruction[],
): InstructionsLoaded {
  const resolved: ResolvedInstruction[] = discovered
    .map((d) => ({
      provenance: { path: d.path, scope: d.scope, dir: d.dir, depth: d.depth },
      content: untrusted(d.rawText),
      precedence: precedenceOf(d.scope, d.depth),
      pathScope: d.pathScope,
    }))
    .sort(compareInstructions);

  const root = resolved.filter((r) => r.pathScope === null);
  return {
    instructions: resolved,
    rootText: composeInstructionText(root),
    rootProvenance: root.map((r) => r.provenance),
  };
}

/** Ascending precedence; path breaks exact ties so ordering is total and reproducible. */
function compareInstructions(a: ResolvedInstruction, b: ResolvedInstruction): number {
  if (a.precedence !== b.precedence) return a.precedence - b.precedence;
  return a.provenance.path < b.provenance.path ? -1 : a.provenance.path > b.provenance.path ? 1 : 0;
}

/**
 * True when `accessedPath` lives under `dir`. Compared by resolved path segments (not raw string
 * prefix) so `/repo/apps` never matches `/repo/apps-legacy`.
 */
export function pathIsUnder(dir: string, accessedPath: string): boolean {
  const base = resolvePath(dir);
  const target = resolvePath(accessedPath);
  if (target === base) return true;
  return target.startsWith(base.endsWith(pathSep) ? base : base + pathSep);
}

/**
 * The instructions that apply for a given set of accessed paths: every always-on instruction, plus
 * any path-scoped instruction whose subtree contains at least one accessed path. Sorted ascending
 * by precedence, ready to compose. With no accessed paths, only the always-on instructions apply —
 * which is exactly the post-compaction rule (CX-05).
 */
export function applicableInstructions(
  loaded: InstructionsLoaded,
  accessedPaths: readonly string[] = [],
): readonly ResolvedInstruction[] {
  return loaded.instructions.filter((instruction) => {
    if (instruction.pathScope === null) return true;
    const scope = instruction.pathScope;
    return accessedPaths.some((accessed) => pathIsUnder(scope, accessed));
  });
}

/**
 * Compose instruction text in ascending precedence order (least specific first, most specific
 * last) with a provenance header per block. Last-wins ordering matches how a reader resolves
 * conflicting guidance: the closest, most-specific instruction has the final say — as TEXT.
 */
export function composeInstructionText(instructions: readonly ResolvedInstruction[]): string {
  return instructions
    .map((instruction) => {
      const { scope, path } = instruction.provenance;
      const body = (instruction.content as string).trim();
      return `<!-- instruction: scope=${scope} path=${path} -->\n${body}`;
    })
    .join('\n\n');
}
