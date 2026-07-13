import {
  MemoryStore,
  dedupKey,
  maybeExtract,
  recordsToCandidates,
  resolveMemoryDir,
  retrieve,
  type Env,
  type LoadedMemoryRecord,
  type Memory,
  type MemoryProposal,
  type MemoryScope,
  type RetrievalResult,
} from '@qwen-harness/memory';
import type { Clock } from '@qwen-harness/protocol';
import type { Redactor } from '@qwen-harness/storage';

/**
 * Long-term memory, made reachable (MM-01, MM-02, MM-05, MM-06).
 *
 * `@qwen-harness/memory` implemented the whole model — four persistent scopes, the 200-line/25 KiB
 * index bound, budgeted retrieval with a keyword fallback, extraction that REFUSES any candidate
 * containing a secret, atomic writes under a lock — and no application called it. There was no
 * `/memory` command and nothing ever read a memory into a prompt.
 *
 * The scopes and where they live are the package's business (`resolveMemoryDir`); this file's job is
 * to pick the ones a CLI run has: `project` (in the repo, shared by everyone who clones it), `user`
 * (this human, across repos), and `auto` (machine-local, shared by every worktree of one canonical
 * repository — MM-05). `team` needs a team, and `session` dies with the process, so neither is
 * loaded here.
 *
 * REDACTION IS NOT OPTIONAL. The store is constructed with the storage redactor seeded with the live
 * credential, and extraction re-checks every candidate against it. A memory is a file that outlives
 * the process that wrote it, so a secret in one is a secret on disk forever.
 */

/** The scopes a plain CLI run reads and writes. */
export const CLI_SCOPES: readonly MemoryScope[] = ['project', 'user', 'auto'];

export interface MemorySurfaceOptions {
  readonly workspaceRoot: string;
  readonly homeDir: string;
  readonly env: Env;
  readonly clock: Clock;
  readonly redactor: Redactor;
}

export interface MemorySurface {
  /** Every readable memory, with provenance. Backs the `memory` command (MM-01). */
  list(): Promise<{ records: LoadedMemoryRecord[]; errors: { path: string; error: Error }[] }>;
  /** Budgeted retrieval for one turn: at most 5 files / 50 KiB by default (MM-02). */
  retrieveFor(query: string): Promise<RetrievalResult>;
  /**
   * Store a memory through the SAME gates automatic extraction uses: schema validity, dedup, and
   * the absolute refusal to persist anything containing a secret (MM-03).
   */
  add(proposal: MemoryProposal, scope: MemoryScope): Promise<AddOutcome>;
  /** The directory a scope resolves to on this host, or null when it does not apply. */
  dirFor(scope: MemoryScope): string | null;
}

export type AddOutcome =
  | { readonly kind: 'stored'; readonly path: string; readonly memory: Memory }
  | { readonly kind: 'rejected'; readonly reason: string };

export function createMemorySurface(opts: MemorySurfaceOptions): MemorySurface {
  const store = new MemoryStore({ clock: opts.clock, redactor: opts.redactor });

  const dirFor = (scope: MemoryScope): string | null =>
    resolveMemoryDir(scope, {
      projectRoot: opts.workspaceRoot,
      // Auto memory is keyed by the CANONICAL repository, so every worktree of one repo shares it
      // (MM-05). The workspace root is the canonical root for a plain, non-worktree checkout.
      canonicalRepoRoot: opts.workspaceRoot,
      homeDir: opts.homeDir,
      env: opts.env,
    });

  const listAll = async (): Promise<{
    records: LoadedMemoryRecord[];
    errors: { path: string; error: Error }[];
  }> => {
    const records: LoadedMemoryRecord[] = [];
    const errors: { path: string; error: Error }[] = [];
    for (const scope of CLI_SCOPES) {
      const dir = dirFor(scope);
      if (dir === null) continue;
      // A scope whose directory does not exist yet contributes nothing. A scope whose FILES are
      // unreadable contributes its errors — recorded, never fatal (MM-02's failure isolation): one
      // corrupt memory file must not stop the other three scopes from loading.
      const result = await store.listMemories(dir, scope);
      records.push(...result.records);
      errors.push(...result.errors.map((e) => ({ path: e.path, error: e.error })));
    }
    return { records, errors };
  };

  return {
    dirFor,
    list: listAll,

    retrieveFor: async (query) => {
      const { records } = await listAll();
      return retrieve(query, recordsToCandidates(records));
    },

    add: async (proposal, scope) => {
      const dir = dirFor(scope);
      if (dir === null) {
        return { kind: 'rejected', reason: `scope '${scope}' does not resolve on this host` };
      }

      const { records } = await listAll();
      // Run the proposal through the REAL extraction gates rather than writing it directly. A
      // user-typed memory is no more trustworthy than a model-proposed one — a pasted log line can
      // carry a key just as easily — so it faces the same secret check, the same schema, and the
      // same dedup.
      const result = maybeExtract(
        { completed: true, cancelled: false },
        {
          propose: () => [proposal],
          redactor: opts.redactor,
          // The package's OWN key function. Computing a lookalike here (say, the name alone) would
          // silently never match, and dedup would appear wired while doing nothing.
          existing: records.map((r) => dedupKey(r.memory)),
        },
      );

      const rejection = result.rejected[0];
      if (rejection !== undefined) {
        return { kind: 'rejected', reason: describeRejection(rejection) };
      }
      const memory = result.extracted[0];
      if (memory === undefined) {
        return { kind: 'rejected', reason: result.skipped ?? 'produced no memory' };
      }

      const written = await store.writeMemory(dir, memory, scope);
      return { kind: 'stored', path: written.path, memory };
    },
  };
}

function describeRejection(rejection: {
  kind: 'contains-secret' | 'invalid' | 'duplicate';
  name: string;
  detail?: string;
}): string {
  switch (rejection.kind) {
    case 'contains-secret':
      // Deliberately says nothing about WHAT was matched. Echoing the offending substring back at
      // the user, in a terminal that scrolls into a log, would defeat the point of catching it.
      return `refused: '${rejection.name}' contains something that looks like a secret; a memory is a file on disk forever`;
    case 'duplicate':
      return `refused: '${rejection.name}' duplicates a memory that is already stored`;
    case 'invalid':
      return `refused: '${rejection.name}' is not a valid memory (${rejection.detail ?? 'schema'})`;
  }
}

/** Render retrieved memories into the prompt's dynamic `memory` section input (IN-08). */
export function memorySectionState(
  result: RetrievalResult,
): { digest: string; files: number } | null {
  if (result.memories.length === 0) return null;
  return {
    digest: result.memories.map((m) => `${m.name}: ${m.description}`).join('\n'),
    files: result.memories.length,
  };
}
