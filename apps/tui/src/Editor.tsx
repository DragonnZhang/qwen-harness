/**
 * The multiline input editor (UI-03, UI-07).
 *
 * All editing logic lives in `tui-kit`'s pure editor STATE MACHINE — this component only decodes Ink
 * key events into those pure transitions and renders the resulting `EditorView`. Because the buffer
 * lines come back as `SafeText`, a pasted escape sequence is inert; it can never style the terminal.
 *
 * Key semantics:
 *   - printable input inserts (a bracketed paste arrives as one multi-char `input` and is inserted
 *     literally — a pasted newline is a line break, never a submit);
 *   - Enter submits or inserts a newline per {@link resolveEnter} (configurable, never hardcoded);
 *   - arrows move; Ctrl/Alt+arrow is word motion; Up/Down at the buffer edge browse history;
 *   - Backspace deletes;
 *   - Ctrl-C interrupts active work; when idle it first clears the input, then a second press exits;
 *   - Esc interrupts active work.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactElement } from 'react';
import { useRef, useState } from 'react';

import type { PermissionProfile, SafeText } from '@qwen-harness/protocol';
import type { EditorConfig, EditorState } from '@qwen-harness/tui-kit';

import {
  commandQuery,
  isCommandLine,
  matchCommands,
  type CommandContext,
  type SlashCommand,
} from './commands.ts';
import type { Activity } from './types.ts';
import {
  backspace,
  bufferText,
  createEditor,
  deleteSelection,
  historyNext,
  historyPrev,
  insertText,
  moveBufferEnd,
  moveBufferStart,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  newline,
  renderEditor,
  resolveEnter,
  submit,
  toGraphemes,
  withHistory,
} from '@qwen-harness/tui-kit';

/** Select the whole buffer and delete it — clear without discarding history/config. */
function clearBuffer(state: EditorState): EditorState {
  return deleteSelection(moveBufferEnd(moveBufferStart(state), true));
}

function LineWithCursor({ line, col }: { line: SafeText; col: number }): ReactElement {
  const graphemes = toGraphemes(line);
  const before = graphemes.slice(0, col).join('');
  const at = graphemes[col] ?? ' ';
  const after = graphemes.slice(col + 1).join('');
  return (
    <Text>
      {before}
      <Text inverse>{at === '' ? ' ' : at}</Text>
      {after}
    </Text>
  );
}

export function Editor({
  onSubmit,
  onInterrupt,
  onExit,
  onCycleMode,
  busy = false,
  config,
  history = [],
  isActive = true,
  mode = 'ask',
  model,
  cwd,
}: {
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  onCycleMode?: (() => void) | undefined;
  busy?: boolean;
  config?: Partial<EditorConfig> | undefined;
  history?: readonly string[] | undefined;
  isActive?: boolean;
  /** Live status the slash commands read (UI-04). Optional so the editor renders standalone. */
  mode?: PermissionProfile;
  model?: SafeText | undefined;
  cwd?: SafeText | undefined;
}): ReactElement {
  const [state, setState] = useState<EditorState>(() => withHistory(createEditor(config), history));
  // Ctrl-C on idle "arms" exit: the first press clears, the second (armed) press exits (UI-07).
  const [armed, setArmed] = useState(false);
  // The highlighted row in the slash-command menu, and the transient info panel a command may open.
  // A ref mirrors `menuIndex` so the Enter handler reads the CURRENT highlight synchronously — a fast
  // Down-then-Enter must run the moved-to command, not the one selected before React committed the
  // arrow's re-render (that race made the run appear to ignore the arrow under load).
  const [menuIndex, setMenuIndex] = useState(0);
  const menuIndexRef = useRef(0);
  const setMenu = (next: number): void => {
    menuIndexRef.current = next;
    setMenuIndex(next);
  };
  const [notice, setNotice] = useState<readonly string[] | null>(null);

  // The slash-command menu is a pure function of the CURRENT buffer: it is open exactly when the
  // buffer is a single line starting with `/`. `matches` is the prefix-filtered completion list;
  // `selected` is the clamped highlight. Nothing here EXECUTES — execution is gated below on Enter.
  const currentText = bufferText(state);
  const menuOpen = isCommandLine(currentText);
  const matches = menuOpen ? matchCommands(commandQuery(currentText)) : [];
  const selected = matches.length > 0 ? Math.min(menuIndex, matches.length - 1) : -1;

  const activity: Activity = busy ? 'busy' : 'idle';
  const runCommand = (command: SlashCommand): void => {
    // A fresh panel per invocation: a command either replaces the notice (help/model/status) or
    // leaves it cleared (mode/quit act instead of print). Context = the app's REAL callbacks/state.
    setNotice(null);
    const ctx: CommandContext = {
      mode,
      model: model ?? ('(unknown)' as SafeText),
      cwd: cwd ?? ('(unknown)' as SafeText),
      activity,
      cycleMode: () => onCycleMode?.(),
      exit: onExit,
      notice: (lines) => setNotice(lines),
    };
    command.run(ctx);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        if (busy) {
          onInterrupt();
          return;
        }
        if (bufferText(state).length > 0) {
          setState(clearBuffer(state));
          setArmed(true);
          return;
        }
        if (armed) {
          onExit();
          return;
        }
        setArmed(true);
        return;
      }

      if (armed) setArmed(false);

      // SLASH-COMMAND MENU (UI-04). Active only while the buffer is a `/`-line WITH at least one
      // matching command. Up/Down/Tab move the highlight; Enter runs the HIGHLIGHTED registry object
      // (never the raw typed text); Esc closes the menu by clearing the buffer. A `/`-line with NO
      // match (e.g. `/notacommand`) falls through untouched — Enter there submits it as ordinary
      // text and nothing executes, which is the security property: injected text is not a command.
      if (menuOpen) {
        // Esc closes the menu by discarding the `/`-line — for ANY command line, including one with
        // no match (`/notacommand`), so an unknown command is dismissed cleanly, never run.
        if (key.escape) {
          setState(clearBuffer(state));
          setMenu(0);
          return;
        }
        if (matches.length > 0) {
          if (key.upArrow) {
            setMenu((menuIndexRef.current - 1 + matches.length) % matches.length);
            return;
          }
          if (key.downArrow || (key.tab && !key.shift)) {
            setMenu((menuIndexRef.current + 1) % matches.length);
            return;
          }
          if (key.return) {
            // Read the highlight from the ref, not the render-scoped `selected`, so a fast
            // Down-then-Enter runs the row the arrow moved to even if the re-render is mid-flight.
            const command = matches[Math.min(menuIndexRef.current, matches.length - 1)];
            if (command !== undefined) runCommand(command);
            setState(clearBuffer(state));
            setMenu(0);
            return;
          }
        }
      }

      // Shift+Tab cycles the approval mode (plan→ask→auto-accept-edits→yolo→plan). Ink decodes the
      // backtab sequence (ESC [ Z) as tab+shift; it carries no printable input, so it never inserts.
      if (key.tab && key.shift) {
        onCycleMode?.();
        return;
      }

      if (key.escape) {
        if (busy) onInterrupt();
        return;
      }

      // Buffer transitions use FUNCTIONAL updates so several inputs delivered before a re-render
      // (a fast typist or a paste split into events) compose from the latest committed state
      // instead of a stale render-time closure.
      if (key.return) {
        const wantNewline =
          resolveEnter(state.config, key.ctrl || key.meta || key.shift) === 'newline';
        if (wantNewline) {
          setState((prev) => newline(prev));
        } else {
          setState((prev) => {
            const result = submit(prev);
            if (result.submitted !== null) {
              setNotice(null);
              onSubmit(result.submitted);
            }
            return result.state;
          });
        }
        return;
      }

      if (key.backspace || key.delete) {
        setState((prev) => backspace(prev));
        return;
      }

      if (key.leftArrow) {
        setState((prev) => (key.ctrl || key.meta ? moveWordLeft(prev) : moveLeft(prev)));
        return;
      }
      if (key.rightArrow) {
        setState((prev) => (key.ctrl || key.meta ? moveWordRight(prev) : moveRight(prev)));
        return;
      }
      if (key.upArrow) {
        setState((prev) => (prev.cursor.row === 0 ? historyPrev(prev) : moveUp(prev)));
        return;
      }
      if (key.downArrow) {
        setState((prev) =>
          prev.cursor.row === prev.lines.length - 1 ? historyNext(prev) : moveDown(prev),
        );
        return;
      }

      if (input.length > 0 && !key.ctrl && !key.meta) {
        // Editing the filter restarts the highlight at the top of the freshly filtered list.
        setMenu(0);
        setState((prev) => insertText(prev, input));
      }
    },
    { isActive },
  );

  const view = renderEditor(state);
  return (
    <Box flexDirection="column">
      {view.lines.map((line, i) => (
        <Box key={i}>
          <Text color="cyan">{i === 0 ? '❯ ' : '  '}</Text>
          {i === view.cursor.row ? (
            <LineWithCursor line={line} col={view.cursor.col} />
          ) : (
            <Text>{line === '' ? ' ' : line}</Text>
          )}
        </Box>
      ))}
      {menuOpen && matches.length > 0 && (
        <Box flexDirection="column">
          {matches.map((command, i) => (
            <Box key={command.name}>
              <Text color={i === selected ? 'cyan' : 'gray'} inverse={i === selected}>
                {`/${command.name}`}
              </Text>
              <Text dimColor>{`  ${command.description}`}</Text>
            </Box>
          ))}
        </Box>
      )}
      {menuOpen && matches.length === 0 && (
        <Text dimColor>no matching command — press Enter to send as text</Text>
      )}
      {notice !== null && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          {notice.map((line, i) => (
            <Text key={i}>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
      )}
      {armed && <Text color="yellow">Press Ctrl-C again to exit</Text>}
      {state.config.vim && <Text dimColor>-- {state.vimMode} --</Text>}
    </Box>
  );
}
