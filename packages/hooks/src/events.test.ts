import { describe, expect, it } from 'vitest';

import { HOOK_EVENTS, isHookEvent, isPostToolEvent } from './events.ts';

/**
 * HK-01: the 30 events verbatim. This list IS the specification — if a future change adds, drops,
 * or renames one, this test fails, which is the point.
 */
const EXPECTED = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'Setup',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'UserPromptExpansion',
  'MessageDisplay',
  'PostToolBatch',
];

describe('hook events (HK-01)', () => {
  it('defines exactly 30 events', () => {
    expect(HOOK_EVENTS).toHaveLength(30);
  });

  it('all events are unique', () => {
    expect(new Set(HOOK_EVENTS).size).toBe(30);
  });

  it('matches the frozen HK-01 list exactly and in order', () => {
    expect([...HOOK_EVENTS]).toEqual(EXPECTED);
  });

  it('validates event names with isHookEvent', () => {
    expect(isHookEvent('PreToolUse')).toBe(true);
    expect(isHookEvent('Stop')).toBe(true);
    expect(isHookEvent('NotAnEvent')).toBe(false);
    expect(isHookEvent('pretooluse')).toBe(false);
  });

  it('classifies the post-tool events (HK-05)', () => {
    expect(isPostToolEvent('PostToolUse')).toBe(true);
    expect(isPostToolEvent('PostToolUseFailure')).toBe(true);
    expect(isPostToolEvent('PostToolBatch')).toBe(true);
    expect(isPostToolEvent('PreToolUse')).toBe(false);
    expect(isPostToolEvent('Stop')).toBe(false);
  });
});
