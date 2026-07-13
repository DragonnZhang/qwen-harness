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
import { useState } from 'react';

import type { SafeText } from '@qwen-harness/protocol';
import type { EditorConfig, EditorState } from '@qwen-harness/tui-kit';
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
  busy = false,
  config,
  history = [],
  isActive = true,
}: {
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  busy?: boolean;
  config?: Partial<EditorConfig> | undefined;
  history?: readonly string[] | undefined;
  isActive?: boolean;
}): ReactElement {
  const [state, setState] = useState<EditorState>(() => withHistory(createEditor(config), history));
  // Ctrl-C on idle "arms" exit: the first press clears, the second (armed) press exits (UI-07).
  const [armed, setArmed] = useState(false);

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
            if (result.submitted !== null) onSubmit(result.submitted);
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
      {armed && <Text color="yellow">Press Ctrl-C again to exit</Text>}
      {state.config.vim && <Text dimColor>-- {state.vimMode} --</Text>}
    </Box>
  );
}
