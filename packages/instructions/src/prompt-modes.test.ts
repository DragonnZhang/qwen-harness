import { describe, expect, it } from 'vitest';

import {
  activatePromptMode,
  modeChangesAuthority,
  promptModeSection,
  PROMPT_MODES,
  PROMPT_MODE_TABLE,
  toolsForMode,
  validateAgentDefinedPrompt,
  type ModeToolDescriptor,
  type PromptMode,
} from './prompt-modes.ts';
import { composeSystemPrompt, sectionCacheKey, buildStandardSections } from './prompt.ts';

const HELD: ModeToolDescriptor[] = [
  { name: 'read_file', mutates: false },
  { name: 'grep', mutates: false },
  { name: 'write_file', mutates: true },
  { name: 'shell', mutates: true },
  { name: 'delegate', mutates: false },
];

describe('the frozen prompt-mode table (IN-09)', () => {
  it('has exactly the five modes defaults.md freezes', () => {
    expect([...PROMPT_MODES]).toEqual([
      'minimal',
      'default',
      'proactive',
      'coordinator',
      'agent-defined',
    ]);
    expect(Object.keys(PROMPT_MODE_TABLE).sort()).toEqual([...PROMPT_MODES].sort());
  });

  it('activates every mode through config AND /prompt-mode, and no mode changes authority', () => {
    for (const mode of PROMPT_MODES) {
      const spec = PROMPT_MODE_TABLE[mode];
      expect([...spec.activation].sort()).toEqual(['command', 'config']);
      expect(spec.policyInheritance).toBe('inherit-unchanged');
      expect(spec.cache).toBe('stable-prefix');
      expect(modeChangesAuthority(mode)).toBe(false);
    }
  });

  it('gives every mode a distinct, non-empty prompt delta', () => {
    const deltas = PROMPT_MODES.map((m) => PROMPT_MODE_TABLE[m].promptDelta);
    expect(new Set(deltas).size).toBe(PROMPT_MODES.length);
    for (const delta of deltas) expect(delta.length).toBeGreaterThan(20);
  });

  it('minimal carries no workflow guidance; default and proactive do', () => {
    expect(PROMPT_MODE_TABLE.minimal.capabilities.workflowGuidance).toBe(false);
    expect(PROMPT_MODE_TABLE.default.capabilities.workflowGuidance).toBe(true);
    expect(PROMPT_MODE_TABLE.proactive.capabilities).toMatchObject({
      mayCreateTasks: true,
      mayUseBackgroundWork: true,
      mayContinueObviousNextSteps: true,
    });
    // Only proactive/coordinator may create tasks or use background work.
    expect(PROMPT_MODE_TABLE.default.capabilities.mayCreateTasks).toBe(false);
    expect(PROMPT_MODE_TABLE.minimal.capabilities.mayUseBackgroundWork).toBe(false);
  });
});

describe('tool availability per mode', () => {
  it('minimal, default and proactive see every tool the caller holds — and never more', () => {
    for (const mode of ['minimal', 'default', 'proactive'] as PromptMode[]) {
      const tools = toolsForMode({ mode }, HELD);
      expect(tools.map((t) => t.name)).toEqual(HELD.map((t) => t.name));
    }
  });

  it('coordinator loses every direct mutation tool', () => {
    const tools = toolsForMode({ mode: 'coordinator' }, HELD);
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'grep', 'delegate']);
    expect(tools.some((t) => t.mutates)).toBe(false);
  });

  it('agent-defined keeps only tools that are BOTH held and explicitly granted', () => {
    const agentDefined = validateAgentDefinedPrompt({
      sections: [{ id: 'style', content: 'Prefer small diffs.' }],
      // `deploy` is granted but not held: a mode may never conjure a tool into existence.
      grantedTools: ['read_file', 'deploy'],
    });
    const tools = toolsForMode({ mode: 'agent-defined', agentDefined }, HELD);
    expect(tools.map((t) => t.name)).toEqual(['read_file']);
  });

  it('no mode can ever return a tool the caller does not hold', () => {
    for (const mode of PROMPT_MODES) {
      const agentDefined = validateAgentDefinedPrompt({
        sections: [{ id: 'x', content: 'y' }],
        grantedTools: ['write_file', 'root_shell', 'exfiltrate'],
      });
      const tools = toolsForMode({ mode, agentDefined }, HELD);
      for (const tool of tools) {
        expect(HELD.map((t) => t.name)).toContain(tool.name);
      }
    }
  });
});

describe('agent-defined sections are validated untrusted content', () => {
  it('accepts a bounded, well-formed definition', () => {
    const parsed = validateAgentDefinedPrompt({
      sections: [{ id: 'house-style', content: 'Use tabs. Never commit secrets.' }],
    });
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.grantedTools).toEqual([]);
  });

  it('rejects control characters, over-long content, and unknown keys', () => {
    expect(() =>
      validateAgentDefinedPrompt({ sections: [{ id: 'x', content: 'a\u001B[31mred' }] }),
    ).toThrow();
    expect(() =>
      validateAgentDefinedPrompt({ sections: [{ id: 'x', content: 'a'.repeat(8_001) }] }),
    ).toThrow();
    expect(() =>
      validateAgentDefinedPrompt({
        sections: [{ id: 'x', content: 'ok', profile: 'yolo' }],
      }),
    ).toThrow();
    // There is no field through which a definition could grant permission or isolation.
    expect(() =>
      validateAgentDefinedPrompt({ sections: [{ id: 'x', content: 'ok' }], profile: 'yolo' }),
    ).toThrow();
  });

  it('requires validated sections before agent-defined can produce a prompt section', () => {
    expect(() => promptModeSection({ mode: 'agent-defined' })).toThrow(/requires validated/);
  });
});

describe('prompt delta and cache behavior', () => {
  it('the mode section is stable and joins the cacheable prefix', () => {
    const section = promptModeSection({ mode: 'proactive' });
    expect(section.kind).toBe('stable');
    const composed = composeSystemPrompt([...buildStandardSections(state()), section]);
    expect(composed.stablePrefix).toContain('Mode: proactive');
    expect(composed.text.startsWith(composed.stablePrefix)).toBe(true);
  });

  it('the cache key is deterministic per mode and differs across modes', () => {
    const keys = PROMPT_MODES.filter((m) => m !== 'agent-defined').map((mode) =>
      sectionCacheKey(promptModeSection({ mode })),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(sectionCacheKey(promptModeSection({ mode: 'minimal' }))).toBe(
      sectionCacheKey(promptModeSection({ mode: 'minimal' })),
    );
  });

  it('editing an agent-defined section invalidates only the mode section key', () => {
    const a = validateAgentDefinedPrompt({ sections: [{ id: 's', content: 'one' }] });
    const b = validateAgentDefinedPrompt({ sections: [{ id: 's', content: 'two' }] });
    const keyA = sectionCacheKey(promptModeSection({ mode: 'agent-defined', agentDefined: a }));
    const keyB = sectionCacheKey(promptModeSection({ mode: 'agent-defined', agentDefined: b }));
    expect(keyA).not.toBe(keyB);

    // Every other section's key is untouched by the mode's content.
    const before = composeSystemPrompt([
      ...buildStandardSections(state()),
      promptModeSection({ mode: 'agent-defined', agentDefined: a }),
    ]);
    const after = composeSystemPrompt([
      ...buildStandardSections(state()),
      promptModeSection({ mode: 'agent-defined', agentDefined: b }),
    ]);
    for (const id of ['identity', 'tools', 'workspace', 'memory', 'session', 'mcp', 'context']) {
      expect(after.cacheKeys[id]).toBe(before.cacheKeys[id]);
    }
    expect(after.cacheKeys['mode']).not.toBe(before.cacheKeys['mode']);
  });
});

describe('activation emits ConfigChange and never touches permission or isolation', () => {
  it('emits a ConfigChange with an injected timestamp', () => {
    const event = activatePromptMode({
      from: 'default',
      to: 'coordinator',
      activation: 'command',
      now: 1_700_000_000_000,
      toolSetChanged: true,
    });
    expect(event).toEqual({
      type: 'config-change',
      key: 'prompt-mode',
      from: 'default',
      to: 'coordinator',
      activation: 'command',
      at: 1_700_000_000_000,
      permissionChanged: false,
      isolationChanged: false,
      invalidatedSections: ['mode', 'tools'],
    });
  });

  it('invalidates only the mode section when the tool set is unchanged', () => {
    const event = activatePromptMode({
      from: 'default',
      to: 'proactive',
      activation: 'config',
      now: 1,
      toolSetChanged: false,
    });
    expect(event.invalidatedSections).toEqual(['mode']);
    expect(event.permissionChanged).toBe(false);
    expect(event.isolationChanged).toBe(false);
  });

  it('rejects an unknown mode at the boundary', () => {
    expect(() =>
      activatePromptMode({
        from: 'default',
        // Untrusted input: a config file or a slash-command argument.
        to: 'root' as PromptMode,
        activation: 'config',
        now: 1,
        toolSetChanged: false,
      }),
    ).toThrow();
  });
});

function state() {
  return {
    identity: { agentName: 'qwen-harness', model: 'qwen3.7-max', profile: 'ask' as const },
    tools: [{ name: 'read_file' }],
    workspace: { cwd: '/repo', repo: '/repo' },
    memory: null,
    session: { threadId: 'thr_000001', turn: 1 },
    mcp: null,
    context: { utilizationPercent: 10, compactions: 0 },
  };
}
