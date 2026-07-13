/**
 * Prompt modes (IN-09).
 *
 * The five modes and their observable behavior are FROZEN in docs/product/defaults.md:
 *
 *   minimal        identity, protocol, tool schemas, current policy, and safety only; no proactive
 *                  workflow guidance
 *   default        normal coding workflow: inspect, plan when needed, edit, verify, summarize
 *   proactive      may create tasks, use background work, and continue obvious next steps inside
 *                  current authority
 *   coordinator    lead performs planning, delegation, review, merge, and verification; direct
 *                  mutation tools are unavailable to the lead
 *   agent-defined  validated user/project prompt sections; inherits the same hard policy and only
 *                  explicitly granted tools
 *
 *   "Modes activate through config or `/prompt-mode`, emit ConfigChange, have deterministic prompt
 *    deltas/cache keys, and never change permission or isolation implicitly."
 *
 * WHY THIS LIVES IN `instructions`, NOT IN `skills`:
 *
 * A prompt mode is a function from runtime state to PROMPT SECTIONS — the exact thing `prompt.ts`
 * next door defines, caches, and orders. Its "prompt delta" is a section; its "cache behavior" is a
 * section cache key; its "tool availability" is a filter over the tool section. Putting it in
 * `skills` would force `skills` to depend on prompt assembly (or duplicate it), and would let a
 * skill — untrusted content — reach the machinery that decides what the system prompt says. Modes
 * are harness-level configuration; skills are content. They stay apart.
 *
 * THE SECURITY LINE: a mode changes TEXT and TOOL AVAILABILITY. It never changes permission,
 * isolation, or policy. `coordinator` REMOVES mutation tools; `agent-defined` RESTRICTS to granted
 * tools. Neither of them, nor any other mode, can add authority — `modeChangesAuthority()` returns
 * false for every mode, and a test asserts it for the whole table.
 */

import { z } from 'zod';

import { stableHash } from './hash.ts';
import type { PromptSection } from './prompt.ts';

export const PROMPT_MODES = [
  'minimal',
  'default',
  'proactive',
  'coordinator',
  'agent-defined',
] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

export const PromptModeSchema = z.enum(PROMPT_MODES);

/** How a mode may be turned on. Both are explicit user acts — a mode never activates itself. */
export const PROMPT_MODE_ACTIVATIONS = ['config', 'command'] as const;
export type PromptModeActivation = (typeof PROMPT_MODE_ACTIVATIONS)[number];

/** How the tool set is derived for a mode. */
export type ToolAvailability =
  /** Every tool the caller already holds. (Never MORE than that — a mode grants nothing.) */
  | 'all-held'
  /** Held tools minus every mutating tool. `coordinator`: the lead does not mutate directly. */
  | 'no-mutation'
  /** Only tools explicitly granted to the agent definition. */
  | 'explicitly-granted-only';

/** Behavioral capabilities a mode's PROMPT confers. Never authority — see `modeChangesAuthority`. */
export interface ModeCapabilities {
  readonly workflowGuidance: boolean;
  readonly mayCreateTasks: boolean;
  readonly mayUseBackgroundWork: boolean;
  readonly mayContinueObviousNextSteps: boolean;
  readonly mayDelegate: boolean;
}

export interface PromptModeSpec {
  readonly mode: PromptMode;
  readonly activation: readonly PromptModeActivation[];
  /** The prompt delta: the text this mode ADDS to the always-present sections. */
  readonly promptDelta: string;
  readonly tools: ToolAvailability;
  /**
   * Policy inheritance. FROZEN at `inherit-unchanged` for every mode: "never change permission or
   * isolation implicitly". This field exists so the property is DATA a test can assert over the
   * whole table, rather than a claim in a comment.
   */
  readonly policyInheritance: 'inherit-unchanged';
  /**
   * Cache behavior. The mode section is STABLE — it belongs to the cacheable prefix, because a mode
   * changes only when a user changes it. Switching modes invalidates the `mode` section's key (and,
   * when the tool set changes with it, the `tools` section's key) and NOTHING else.
   */
  readonly cache: 'stable-prefix';
  readonly capabilities: ModeCapabilities;
}

const NO_CAPABILITIES: ModeCapabilities = {
  workflowGuidance: false,
  mayCreateTasks: false,
  mayUseBackgroundWork: false,
  mayContinueObviousNextSteps: false,
  mayDelegate: false,
};

/**
 * THE table. One row per frozen mode, and every column is exactly a column of the defaults.md
 * table: activation, prompt delta, tool availability, policy inheritance, cache behavior, and the
 * observable capabilities. Data, so a test can walk it.
 */
export const PROMPT_MODE_TABLE: Record<PromptMode, PromptModeSpec> = {
  minimal: {
    mode: 'minimal',
    activation: ['config', 'command'],
    promptDelta:
      'Mode: minimal. Answer the request directly using the tools and policy already described. ' +
      'Do not volunteer workflow guidance, plans, or follow-up work.',
    tools: 'all-held',
    policyInheritance: 'inherit-unchanged',
    cache: 'stable-prefix',
    capabilities: { ...NO_CAPABILITIES },
  },
  default: {
    mode: 'default',
    activation: ['config', 'command'],
    promptDelta:
      'Mode: default. Follow the normal coding workflow: inspect the code, plan when the change ' +
      'warrants it, make the edit, verify it, and summarize what changed.',
    tools: 'all-held',
    policyInheritance: 'inherit-unchanged',
    cache: 'stable-prefix',
    capabilities: { ...NO_CAPABILITIES, workflowGuidance: true },
  },
  proactive: {
    mode: 'proactive',
    activation: ['config', 'command'],
    promptDelta:
      'Mode: proactive. Follow the normal coding workflow, and additionally you may create tasks, ' +
      'run work in the background, and continue obvious next steps — strictly inside the authority ' +
      'you already hold. Proactivity is never a reason to ask for, or assume, more permission.',
    tools: 'all-held',
    policyInheritance: 'inherit-unchanged',
    cache: 'stable-prefix',
    capabilities: {
      workflowGuidance: true,
      mayCreateTasks: true,
      mayUseBackgroundWork: true,
      mayContinueObviousNextSteps: true,
      mayDelegate: false,
    },
  },
  coordinator: {
    mode: 'coordinator',
    activation: ['config', 'command'],
    promptDelta:
      'Mode: coordinator. You are the lead: plan, delegate, review, merge, and verify. You do not ' +
      'mutate the workspace directly — direct mutation tools are not available to you; delegate ' +
      'the change and review the result.',
    tools: 'no-mutation',
    policyInheritance: 'inherit-unchanged',
    cache: 'stable-prefix',
    capabilities: {
      workflowGuidance: true,
      mayCreateTasks: true,
      mayUseBackgroundWork: true,
      mayContinueObviousNextSteps: false,
      mayDelegate: true,
    },
  },
  'agent-defined': {
    mode: 'agent-defined',
    activation: ['config', 'command'],
    promptDelta:
      'Mode: agent-defined. The sections below were supplied by the user or the project and have ' +
      'been validated. They are guidance only: the hard policy above still applies in full, and ' +
      'you hold only the tools explicitly granted to this agent.',
    tools: 'explicitly-granted-only',
    policyInheritance: 'inherit-unchanged',
    cache: 'stable-prefix',
    capabilities: { ...NO_CAPABILITIES, workflowGuidance: true },
  },
};

/**
 * The invariant, as a function: NO mode changes authority. Every mode inherits policy unchanged;
 * the only tool effects a mode has are SUBTRACTIVE (`no-mutation`, `explicitly-granted-only`).
 */
export function modeChangesAuthority(mode: PromptMode): false {
  const spec = PROMPT_MODE_TABLE[mode];
  if (spec.policyInheritance !== 'inherit-unchanged') {
    throw new Error(`prompt mode ${mode} claims to change policy inheritance; that is forbidden`);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Agent-defined sections: validated user/project prompt text
// ---------------------------------------------------------------------------------------------

/**
 * The `agent-defined` mode's sections come from a user or project file — i.e. from UNTRUSTED
 * content (SC-02). They are validated at this boundary: bounded count, bounded size, slug ids, and
 * no control characters (a prompt section is text; an escape sequence in it is either an attempt to
 * forge terminal chrome or to smuggle structure). They add TEXT. They can grant nothing: there is
 * deliberately no field here through which a project file could name a tool or a permission.
 */
export const AgentDefinedSectionSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'section id must be a slug'),
  content: z
    .string()
    .min(1)
    .max(8_000)

    .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), {
      message: 'section content must not contain control characters',
    }),
});

export const AgentDefinedPromptSchema = z.strictObject({
  sections: z.array(AgentDefinedSectionSchema).min(1).max(8),
  /** Tools the agent definition was EXPLICITLY granted. Intersected with what the caller holds. */
  grantedTools: z.array(z.string().min(1).max(64)).max(64).default([]),
});

export type AgentDefinedPrompt = z.infer<typeof AgentDefinedPromptSchema>;

/** Validate an agent definition. Throws a `ZodError` naming the field; never a partial acceptance. */
export function validateAgentDefinedPrompt(input: unknown): AgentDefinedPrompt {
  return AgentDefinedPromptSchema.parse(input);
}

// ---------------------------------------------------------------------------------------------
// Prompt delta and cache key
// ---------------------------------------------------------------------------------------------

export interface PromptModeState {
  readonly mode: PromptMode;
  /** Required exactly when `mode === 'agent-defined'`; ignored otherwise. */
  readonly agentDefined?: AgentDefinedPrompt;
}

/**
 * The mode's prompt section.
 *
 * STABLE (cacheable prefix), because a mode changes only when a human changes it. The cache key is
 * a pure function of the mode plus a digest of the agent-defined text, so:
 *   - the same mode always produces the same key (cache hit), and
 *   - editing one line of an agent-defined section changes the key (correct invalidation) and
 *     invalidates nothing else.
 */
export function promptModeSection(state: PromptModeState): PromptSection {
  const spec = PROMPT_MODE_TABLE[state.mode];

  if (state.mode === 'agent-defined') {
    const defined = state.agentDefined;
    if (defined === undefined) {
      throw new Error('prompt mode "agent-defined" requires validated agentDefined sections');
    }
    const body = defined.sections.map((s) => `## ${s.id}\n${s.content}`).join('\n\n');
    const digest = stableHash(body);
    return {
      id: 'mode',
      kind: 'stable',
      content: `${spec.promptDelta}\n\n${body}`,
      cacheKeyInputs: {
        mode: state.mode,
        agentDefinedDigest: digest,
        grantedTools: [...defined.grantedTools].sort().join(','),
      },
    };
  }

  return {
    id: 'mode',
    kind: 'stable',
    content: spec.promptDelta,
    cacheKeyInputs: { mode: state.mode, agentDefinedDigest: null, grantedTools: null },
  };
}

// ---------------------------------------------------------------------------------------------
// Tool availability
// ---------------------------------------------------------------------------------------------

/** The minimum a tool must tell us for a mode to filter it: its name and whether it mutates. */
export interface ModeToolDescriptor {
  readonly name: string;
  /** True for a tool that writes a file, runs a command, or otherwise changes the world. */
  readonly mutates: boolean;
}

/**
 * The tools available in a mode. ALWAYS a subset of `held` — this function can only remove.
 *
 * `coordinator` removes mutating tools (defaults.md: "direct mutation tools are unavailable to the
 * lead"). `agent-defined` keeps only tools that are BOTH held and explicitly granted; a granted
 * tool the caller does not hold is not conjured into existence.
 */
export function toolsForMode(
  state: PromptModeState,
  held: readonly ModeToolDescriptor[],
): readonly ModeToolDescriptor[] {
  const spec = PROMPT_MODE_TABLE[state.mode];
  switch (spec.tools) {
    case 'all-held':
      return held;
    case 'no-mutation':
      return held.filter((tool) => !tool.mutates);
    case 'explicitly-granted-only': {
      const granted = new Set(state.agentDefined?.grantedTools ?? []);
      return held.filter((tool) => granted.has(tool.name));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------

/**
 * The ConfigChange a mode switch emits (defaults.md: "Modes activate through config or
 * `/prompt-mode`, emit ConfigChange"). It records what changed and where it came from — and states,
 * as data, that permission and isolation did NOT change, so an auditor never has to infer it.
 */
export interface PromptModeChanged {
  readonly type: 'config-change';
  readonly key: 'prompt-mode';
  readonly from: PromptMode;
  readonly to: PromptMode;
  readonly activation: PromptModeActivation;
  readonly at: number;
  /** Always false. A mode is prompt text and tool visibility; it is never authority. */
  readonly permissionChanged: false;
  readonly isolationChanged: false;
  /** Section cache keys the switch invalidates. Deterministic, and exactly the ones that changed. */
  readonly invalidatedSections: readonly string[];
}

export interface ActivateModeOptions {
  readonly from: PromptMode;
  readonly to: PromptMode;
  readonly activation: PromptModeActivation;
  /** Injected time — no ambient `Date.now()`. */
  readonly now: number;
  /** Whether the tool set visible to the model differs between the two modes. */
  readonly toolSetChanged: boolean;
}

/** Activate a mode: validate it, and produce the ConfigChange the runtime persists and displays. */
export function activatePromptMode(options: ActivateModeOptions): PromptModeChanged {
  const to = PromptModeSchema.parse(options.to);
  const from = PromptModeSchema.parse(options.from);
  const spec = PROMPT_MODE_TABLE[to];
  if (!spec.activation.includes(options.activation)) {
    throw new Error(`prompt mode "${to}" cannot be activated via ${options.activation}`);
  }
  modeChangesAuthority(to); // throws if the table were ever edited to claim otherwise

  return {
    type: 'config-change',
    key: 'prompt-mode',
    from,
    to,
    activation: options.activation,
    at: options.now,
    permissionChanged: false,
    isolationChanged: false,
    invalidatedSections: options.toolSetChanged ? ['mode', 'tools'] : ['mode'],
  };
}
