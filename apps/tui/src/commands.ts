/**
 * The slash-command registry (UI-04, UI-16).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the interactive commands the editor exposes when the
 * input buffer begins with `/`. It is deliberately pure and host-free: it names commands, describes
 * them, and runs each one through a small injected {@link CommandContext} that the editor builds from
 * the REAL app state and callbacks (the same `cycleMode`, `exit`, and status the rest of the UI uses).
 * There are no stub commands here — every entry drives a real effect or reads real state.
 *
 * SECURITY (the `S` evidence class). Execution is gated on an EXACT match against this registry:
 *
 *   - {@link lookupCommand} resolves a name only when it is byte-for-byte a registered command. There
 *     is no fuzzy acceptance, no prefix acceptance, and above all no `eval` — arbitrary text typed
 *     after `/` (`/notacommand`, `/../etc`, `/help; rm -rf`) resolves to `undefined` and can never
 *     run. The only value ever handed to `run()` is a {@link SlashCommand} object taken from this
 *     frozen list; injected user text is never itself treated as a command.
 *   - {@link matchCommands} is a PREFIX filter used ONLY to populate the completion menu. Matching
 *     something for display is not executing it; the editor still runs only the highlighted registry
 *     object the user explicitly selects.
 *
 * Command names and descriptions are TRUSTED CHROME the app authors (never model/tool text). Values
 * that a command surfaces from untrusted origins — the model name, the workspace path — arrive on the
 * context as {@link SafeText} (already sanitized) and are rendered inert.
 */

import type { PermissionProfile, SafeText } from '@qwen-harness/protocol';

import type { Activity } from './types.ts';

/**
 * The imperative surface a command may drive. The editor constructs this from the props it already
 * holds — so a command's effect is the SAME real effect the corresponding keybinding or status field
 * produces. `notice` renders a transient panel below the editor (help/model/status output).
 */
export interface CommandContext {
  /** The live permission profile (for display, e.g. `/status`). */
  readonly mode: PermissionProfile;
  /** The model this session talks to. Untrusted provider string → already `SafeText`. */
  readonly model: SafeText;
  /** The workspace directory. Untrusted path → already `SafeText`. */
  readonly cwd: SafeText;
  /** Whether a turn is currently running. */
  readonly activity: Activity;
  /** Cycle the approval mode one step — the exact `onCycleMode` the Shift+Tab binding calls. */
  cycleMode(): void;
  /** Exit the session and restore the terminal — the exact `onExit` Ctrl-C-twice calls. */
  exit(): void;
  /** Show an informational panel of lines below the editor (trusted chrome + inert `SafeText`). */
  notice(lines: readonly string[]): void;
}

/** A single registered command. `name` never carries the leading slash. */
export interface SlashCommand {
  /** Invocation name WITHOUT the leading slash, e.g. `help`. Lowercase `[a-z]`/`-` only. */
  readonly name: string;
  /** One-line human description shown in the completion menu and by `/help`. Trusted chrome. */
  readonly description: string;
  /** Perform the command's real effect through the injected context. */
  run(ctx: CommandContext): void;
}

/**
 * The registry, in menu order. Frozen so the menu, `/help`, exact lookup, and prefix filtering all
 * read ONE list — a command can never appear in the menu but be missing from lookup, or vice versa.
 */
const COMMANDS: readonly SlashCommand[] = Object.freeze([
  {
    name: 'help',
    description: 'List the available slash commands',
    run(ctx) {
      ctx.notice([
        'Slash commands:',
        ...COMMANDS.map((c) => `  /${c.name.padEnd(8)} ${c.description}`),
      ]);
    },
  },
  {
    name: 'mode',
    description: 'Cycle the approval mode (plan → ask → auto-accept-edits → yolo)',
    run(ctx) {
      // Real effect: re-derives authority and re-renders the status line, exactly like Shift+Tab.
      ctx.cycleMode();
    },
  },
  {
    name: 'model',
    description: 'Show the model this session is talking to',
    run(ctx) {
      ctx.notice([`model: ${ctx.model}`]);
    },
  },
  {
    name: 'status',
    description: 'Show the current model, approval mode, and workspace',
    run(ctx) {
      ctx.notice([
        `model:     ${ctx.model}`,
        `mode:      ${ctx.mode}`,
        `workspace: ${ctx.cwd}`,
        `activity:  ${ctx.activity}`,
      ]);
    },
  },
  {
    name: 'quit',
    description: 'Exit the session and restore the terminal',
    run(ctx) {
      ctx.exit();
    },
  },
]);

/** All commands, in menu order. The menu and lookup share this one source of truth. */
export function listCommands(): readonly SlashCommand[] {
  return COMMANDS;
}

/**
 * EXACT lookup by name — the security property. Only a name that is byte-for-byte a registered
 * command resolves; anything else (injected/arbitrary text after `/`) returns `undefined` and thus
 * can never execute. No fuzzy match, no prefix acceptance, no `eval`.
 */
export function lookupCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** True when `text` is a slash-command line: it starts with `/` and is a single line. */
export function isCommandLine(text: string): boolean {
  return text.startsWith('/') && !text.includes('\n');
}

/**
 * The partial command token the user has typed after `/`, up to the first space. `/mo` → `mo`,
 * `/help me` → `help`, `/` → ``. Non-command lines yield ``.
 */
export function commandQuery(text: string): string {
  if (!isCommandLine(text)) return '';
  const afterSlash = text.slice(1);
  const space = afterSlash.indexOf(' ');
  return space === -1 ? afterSlash : afterSlash.slice(0, space);
}

/**
 * The commands whose name begins with `query` — the completion-menu contents. An empty query (just
 * `/`) lists everything. This is a PREFIX filter for DISPLAY only; it never executes anything.
 */
export function matchCommands(query: string): readonly SlashCommand[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}
