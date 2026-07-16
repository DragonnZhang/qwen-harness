import { join } from 'node:path';

import {
  buildStandardSections,
  composeSystemPrompt,
  instructionStringForRequest,
  loadInstructions,
  promptModeSection,
  type ComposedSystemPrompt,
  type InstructionsLoaded,
  type PromptMode,
  type SystemPromptState,
} from '@qwen-harness/instructions';
import type { PermissionProfile } from '@qwen-harness/protocol';

/**
 * Repository instructions and system-prompt composition (IN-06, IN-07, IN-08, IN-10).
 *
 * What this replaces: `main.ts` passed the engine ONE hard-coded string literal —
 * "You are a coding assistant working inside a sandboxed workspace…" — as the entire system prompt.
 * `AGENTS.md` was never read. A repository could not instruct the agent at all, there was no
 * provenance for guidance the model was following, and the prompt was a single mutable string
 * rather than composed sections with cache keys. `@qwen-harness/instructions` implemented all of
 * that and no application called it.
 *
 * The two halves, kept separate because they fail differently:
 *
 *   INSTRUCTIONS (IN-06) are UNTRUSTED CONTEXT. They are discovered from the filesystem with
 *   deterministic precedence (global < user < ancestor < repo-root < nested, ties broken by
 *   directory depth) and carry provenance so a user can ask "why is it doing that?" and get a file
 *   path. They can never grant a tool, lift a deny, or change a managed value — the package's
 *   `INSTRUCTIONS_ARE_CONTEXT_ONLY` posture, and nothing here weakens it. Repository content the
 *   user merely `git clone`d must not be able to escalate itself.
 *
 *   THE SYSTEM PROMPT (IN-07/IN-08) is composed from independently-tested sections built from real
 *   runtime state — identity, tools, workspace (stable); memory, session, MCP, context (dynamic) —
 *   each with a deterministic cache key. The stable sections form a cacheable prefix that a dynamic
 *   change does not invalidate.
 *
 * IN-10: the composed prompt plus the instruction text is passed to `TurnEngine.run` on EVERY turn
 * and therefore reaches `ModelRequest.instructions` on every provider request. Caching is an
 * optimization over identical content; it never changes what is sent.
 */

/** Where a machine-wide instruction file lives, if an administrator deployed one. */
export const GLOBAL_INSTRUCTIONS = '/etc/qwen-harness/AGENTS.md';

/**
 * How many directories ABOVE the workspace root are scanned for `ancestor` instructions. Bounded:
 * an unbounded walk to `/` would read files from directories that have nothing to do with the user's
 * project and would make discovery depend on where the repo happens to be checked out.
 */
export const ANCESTOR_DEPTH = 3;

export interface LoadedGuidance {
  readonly loaded: InstructionsLoaded;
  /** Every file that contributed, most-specific last. Printed by `doctor` and `instructions`. */
  readonly sources: readonly { path: string; scope: string; chars: number }[];
}

/**
 * Discover the repository's instruction files. A read failure on a file that EXISTS is fatal inside
 * the package (`InstructionReadError` names the path) — an unreadable `AGENTS.md` must not silently
 * degrade into "the repo had no instructions", because the agent would then confidently ignore
 * guidance the user believes it is following.
 */
export function loadGuidance(opts: { workspaceRoot: string; homeDir: string }): LoadedGuidance {
  const loaded = loadInstructions({
    repoRoot: opts.workspaceRoot,
    globalPaths: [GLOBAL_INSTRUCTIONS],
    userPaths: [join(opts.homeDir, '.qwen-harness', 'AGENTS.md')],
    ancestorDepth: ANCESTOR_DEPTH,
  });

  return {
    loaded,
    sources: loaded.instructions.map((i) => ({
      path: i.provenance.path,
      scope: i.provenance.scope,
      chars: i.content.length,
    })),
  };
}

export interface PromptInputs {
  readonly agentName: string;
  readonly model: string;
  readonly profile: PermissionProfile;
  readonly workspaceRoot: string;
  readonly repo: string | null;
  readonly toolNames: readonly string[];
  readonly threadId: string;
  readonly turn: number;
  /** Loaded memory for this turn, or `null` when memory retrieved nothing. */
  readonly memory: { digest: string; files: number } | null;
  /** Connected MCP servers, or `null` when none are. */
  readonly mcp: { servers: readonly string[]; schemaDigest: string } | null;
  /**
   * Real context status for this turn (CX-01), computed from the reconstructed history and the
   * durable compaction record. Omitted only by callers that have no store; defaults to zeroes.
   */
  readonly context?: { utilizationPercent: number; compactions: number };
  /**
   * The active prompt mode (IN-09). Omitted is treated as `default` and adds no mode section — the
   * prior behavior. A non-default mode contributes a `mode` section (its frozen prompt delta) to the
   * cacheable stable prefix; the mode NEVER changes authority (see `modeChangesAuthority`), and any
   * tool restriction the mode implies is applied by the caller before `toolNames` is passed in.
   */
  readonly mode?: PromptMode;
}

export interface ComposedPrompt {
  readonly composed: ComposedSystemPrompt;
  /**
   * Exactly what goes into `ModelRequest.instructions`: the composed system prompt followed by the
   * always-on repository instruction text. Sent on every request (IN-10).
   */
  readonly instructions: string;
}

/**
 * Build the system prompt for one turn.
 *
 * `accessedPaths` is what unlocks NESTED, path-scoped instructions (CX-05, defaults.md): a nested
 * `AGENTS.md` applies only once a file under its directory has actually been touched. On a fresh
 * turn nothing has been accessed yet, so only root/unscoped guidance is attached — which is exactly
 * the frozen reattachment rule, and it keeps an unrelated subtree's instructions out of a prompt
 * that has no business carrying them.
 */
export function composePrompt(
  guidance: LoadedGuidance,
  inputs: PromptInputs,
  accessedPaths: readonly string[] = [],
): ComposedPrompt {
  const state: SystemPromptState = {
    identity: { agentName: inputs.agentName, model: inputs.model, profile: inputs.profile },
    tools: inputs.toolNames.map((name) => ({ name })),
    workspace: { cwd: inputs.workspaceRoot, repo: inputs.repo },
    memory: inputs.memory,
    session: { threadId: inputs.threadId, turn: inputs.turn },
    mcp: inputs.mcp,
    // Real context status (CX-01). `context.ts` computes utilization from the reconstructed history
    // against the provider window, and the compaction count from the durable log. A caller that
    // supplies no context (an inspection with no store) falls back to honest zeroes.
    context: inputs.context ?? { utilizationPercent: 0, compactions: 0 },
  };

  // The mode section (IN-09) is a STABLE section: it belongs to the cacheable prefix because a mode
  // changes only when a user changes it. `default` adds nothing (the prior behavior); any other mode
  // contributes exactly its frozen prompt delta. `compareSections` places the `mode` id after the
  // known stable sections deterministically, so no ordering table needs to know about it.
  const sections = buildStandardSections(state);
  if (inputs.mode !== undefined && inputs.mode !== 'default') {
    sections.push(promptModeSection({ mode: inputs.mode }));
  }
  const composed = composeSystemPrompt(sections);

  const instructions = instructionStringForRequest(guidance.loaded, {
    systemPrompt: composed.text,
    accessedPaths,
  });

  return { composed, instructions };
}
