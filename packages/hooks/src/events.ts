/**
 * The 30 hook events (HK-01).
 *
 * This is a REGISTRY OF NAMES, nothing more. Each event is a point in the runtime where hooks may
 * observe or steer behaviour; the actual emission of every event is wired by the DOMAIN that owns
 * that point (a tool call site emits PreToolUse, the compaction path emits PreCompact, and so on).
 * Defining the names here — and only the names — is deliberate: an engine that "emitted" all 30
 * from nowhere would be the no-op emitter the spec forbids, proving nothing about real behaviour.
 *
 * The list is frozen. A test asserts there are exactly 30, all unique, matching HK-01 verbatim.
 */
export const HOOK_EVENTS = [
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
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** O(1) membership for validating an event name that arrived as an untrusted string. */
export const HOOK_EVENT_SET: ReadonlySet<HookEvent> = new Set(HOOK_EVENTS);

export function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENT_SET.has(value as HookEvent);
}

/**
 * Events that fire AFTER a tool has already run and produced a durable result (HK-05). A hook on
 * one of these can prevent the NEXT step, but it can never un-complete or corrupt the result that
 * already happened — the engine enforces that distinction, not the hook author.
 */
export const POST_TOOL_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
]);

export function isPostToolEvent(event: HookEvent): boolean {
  return POST_TOOL_EVENTS.has(event);
}
