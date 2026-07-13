/**
 * The multiline input editor as a PURE state machine (UI-03).
 *
 * There is no terminal here and no key decoding. An `EditorState` is plain, immutable data; every
 * operation is a pure function `(state, …) => EditorState`. That is what makes the editor testable
 * without a PTY, and it is also what makes undo trivial: the undo stack is just a bounded list of
 * previous states.
 *
 * What the editor gets right, and why:
 *
 *   - UNICODE. The cursor is a `(row, col)` where `col` is a GRAPHEME index, not a UTF-16 offset.
 *     你好 is two cursor stops of display-width two each; 👍 is one stop; e + combining accent is
 *     one stop. Motion, deletion, and width all go through {@link ./unicode.ts}.
 *   - BRACKETED PASTE. {@link paste} inserts text LITERALLY. A pasted newline becomes a line break
 *     in the buffer, never a submit; a pasted control byte is stored verbatim and only made inert
 *     at render time. The editor never interprets pasted bytes as commands (the paste threat).
 *   - CONFIGURABLE SUBMIT. Whether Enter submits or inserts a newline is a CONFIG flag
 *     ({@link EditorConfig.submit}), resolved by {@link resolveEnter} — never hardcoded.
 *   - HISTORY + REVERSE SEARCH. Submitted entries feed up/down navigation and a Ctrl-R style
 *     {@link historySearch}.
 *   - OPTIONAL VIM. A real (if compact) normal-mode command set behind {@link EditorConfig.vim}.
 *
 * The RENDER boundary: {@link renderEditor} returns display data — lines as `SafeText` (so a pasted
 * escape sequence can never style the terminal) plus the cursor's display column. The buffer itself
 * keeps raw text so editing stays exact; only the projection is sanitized.
 */

import type { SafeText } from '@qwen-harness/protocol';
import { sanitize } from '@qwen-harness/protocol';

import { graphemeCount, sliceGraphemes, stringWidth, toGraphemes } from './unicode.ts';

export type VimMode = 'insert' | 'normal';

export interface EditorConfig {
  /** `enter`: plain Enter submits, Ctrl+Enter inserts a newline. `ctrl-enter`: the reverse. */
  readonly submit: 'enter' | 'ctrl-enter';
  /** Upper bound on the undo stack, so a long session cannot grow memory without limit. */
  readonly maxUndo: number;
  /** Upper bound on retained submitted history. */
  readonly maxHistory: number;
  /** Enable Vim normal-mode bindings. When true the editor starts in normal mode. */
  readonly vim: boolean;
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  submit: 'enter',
  maxUndo: 200,
  maxHistory: 1000,
  vim: false,
};

/** A cursor position. `col` is a grapheme index within `lines[row]`, never a UTF-16 offset. */
export interface Cursor {
  readonly row: number;
  readonly col: number;
}

interface Snapshot {
  readonly lines: readonly string[];
  readonly cursor: Cursor;
  readonly anchor: Cursor | null;
}

export interface EditorState {
  readonly lines: readonly string[];
  readonly cursor: Cursor;
  /** Selection anchor; the selection spans anchor..cursor. Null when nothing is selected. */
  readonly anchor: Cursor | null;
  /** The yank/cut register — internal clipboard, distinct from a bracketed paste from the OS. */
  readonly register: string;
  readonly undo: readonly Snapshot[];
  readonly redo: readonly Snapshot[];
  readonly history: readonly string[];
  /** Index into `history` while browsing, or null when editing the live draft. */
  readonly historyIndex: number | null;
  /** The live buffer stashed while browsing history, restored on returning past the newest entry. */
  readonly draft: string | null;
  readonly config: EditorConfig;
  readonly vimMode: VimMode;
}

// ---------------------------------------------------------------------------------------------
// Construction & inspection
// ---------------------------------------------------------------------------------------------

export function createEditor(config: Partial<EditorConfig> = {}): EditorState {
  const merged: EditorConfig = {
    submit: config.submit ?? DEFAULT_EDITOR_CONFIG.submit,
    maxUndo: config.maxUndo ?? DEFAULT_EDITOR_CONFIG.maxUndo,
    maxHistory: config.maxHistory ?? DEFAULT_EDITOR_CONFIG.maxHistory,
    vim: config.vim ?? DEFAULT_EDITOR_CONFIG.vim,
  };
  return {
    lines: [''],
    cursor: { row: 0, col: 0 },
    anchor: null,
    register: '',
    undo: [],
    redo: [],
    history: [],
    historyIndex: null,
    draft: null,
    config: merged,
    vimMode: merged.vim ? 'normal' : 'insert',
  };
}

/** The full buffer as one string, lines joined by `\n`. */
export function bufferText(state: EditorState): string {
  return state.lines.join('\n');
}

/** Seed submitted history (e.g. on session resume). Does not touch the live buffer. */
export function withHistory(state: EditorState, entries: readonly string[]): EditorState {
  return { ...state, history: [...entries] };
}

// ---------------------------------------------------------------------------------------------
// Low-level buffer edit
// ---------------------------------------------------------------------------------------------

function lineGraphemes(state: EditorState, row: number): string[] {
  return toGraphemes(state.lines[row] ?? '');
}

function lineLen(state: EditorState, row: number): number {
  return graphemeCount(state.lines[row] ?? '');
}

function lastRow(state: EditorState): number {
  return state.lines.length - 1;
}

/** Order two cursors so `start` precedes `end` in the buffer. */
function ordered(a: Cursor, b: Cursor): [Cursor, Cursor] {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
  return [b, a];
}

/**
 * Replace the buffer range `[start, end)` with `insert`, returning the new lines and the cursor
 * position at the end of the inserted text. `insert` may contain newlines, which become line breaks.
 */
function replaceRange(
  lines: readonly string[],
  start: Cursor,
  end: Cursor,
  insert: string,
): { lines: string[]; cursor: Cursor } {
  const startGraphemes = toGraphemes(lines[start.row] ?? '');
  const endGraphemes = toGraphemes(lines[end.row] ?? '');
  const before = sliceGraphemes(startGraphemes, 0, start.col);
  const after = sliceGraphemes(endGraphemes, end.col);
  const parts = insert.split('\n');
  const result = lines.slice(0, start.row);

  if (parts.length === 1) {
    const only = parts[0] ?? '';
    result.push(before + only + after);
    result.push(...lines.slice(end.row + 1));
    return { lines: result, cursor: { row: start.row, col: graphemeCount(before + only) } };
  }

  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  result.push(before + first);
  for (let i = 1; i < parts.length - 1; i += 1) result.push(parts[i] ?? '');
  result.push(last + after);
  result.push(...lines.slice(end.row + 1));
  return {
    lines: result,
    cursor: { row: start.row + parts.length - 1, col: graphemeCount(last) },
  };
}

function bounded<T>(items: readonly T[], max: number): T[] {
  return items.length <= max ? [...items] : items.slice(items.length - max);
}

function snapshot(state: EditorState): Snapshot {
  return { lines: state.lines, cursor: state.cursor, anchor: state.anchor };
}

/** Commit a buffer change: push the prior state to undo, clear redo, and leave history browsing. */
function commit(
  state: EditorState,
  next: { lines: string[]; cursor: Cursor; anchor: Cursor | null },
): EditorState {
  return {
    ...state,
    lines: next.lines,
    cursor: next.cursor,
    anchor: next.anchor,
    undo: bounded([...state.undo, snapshot(state)], state.config.maxUndo),
    redo: [],
    historyIndex: null,
    draft: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Text mutation
// ---------------------------------------------------------------------------------------------

/** Insert text at the cursor, replacing the selection first if one exists. Newlines are literal. */
export function insertText(state: EditorState, text: string): EditorState {
  const [start, end] = state.anchor ? ordered(state.anchor, state.cursor) : [state.cursor, state.cursor];
  const next = replaceRange(state.lines, start, end, text);
  return commit(state, { ...next, anchor: null });
}

/**
 * Insert a bracketed paste. Identical to {@link insertText}: the text goes in LITERALLY, so a pasted
 * newline is a line break and a pasted control byte is stored verbatim — never interpreted as a
 * command or a submit. This distinct name documents the paste threat at the call site.
 */
export function paste(state: EditorState, text: string): EditorState {
  return insertText(state, text);
}

/** Insert a newline (the explicit Enter-inserts-newline action). */
export function newline(state: EditorState): EditorState {
  return insertText(state, '\n');
}

/** Delete backward: the selection, else the grapheme before the cursor, else join the prior line. */
export function backspace(state: EditorState): EditorState {
  if (state.anchor) return deleteSelection(state);
  const { row, col } = state.cursor;
  if (col > 0) {
    const next = replaceRange(state.lines, { row, col: col - 1 }, { row, col }, '');
    return commit(state, { ...next, anchor: null });
  }
  if (row > 0) {
    const start: Cursor = { row: row - 1, col: lineLen(state, row - 1) };
    const next = replaceRange(state.lines, start, { row, col: 0 }, '');
    return commit(state, { ...next, anchor: null });
  }
  return state;
}

/** Delete forward: the selection, else the grapheme at the cursor, else join the next line. */
export function deleteForward(state: EditorState): EditorState {
  if (state.anchor) return deleteSelection(state);
  const { row, col } = state.cursor;
  if (col < lineLen(state, row)) {
    const next = replaceRange(state.lines, { row, col }, { row, col: col + 1 }, '');
    return commit(state, { ...next, anchor: null });
  }
  if (row < lastRow(state)) {
    const next = replaceRange(state.lines, { row, col }, { row: row + 1, col: 0 }, '');
    return commit(state, { ...next, anchor: null });
  }
  return state;
}

// ---------------------------------------------------------------------------------------------
// Selection & register
// ---------------------------------------------------------------------------------------------

/** The selected text, or '' when nothing is selected. */
export function selectedText(state: EditorState): string {
  if (!state.anchor) return '';
  const [start, end] = ordered(state.anchor, state.cursor);
  if (start.row === end.row) {
    return sliceGraphemes(lineGraphemes(state, start.row), start.col, end.col);
  }
  const parts: string[] = [sliceGraphemes(lineGraphemes(state, start.row), start.col)];
  for (let r = start.row + 1; r < end.row; r += 1) parts.push(state.lines[r] ?? '');
  parts.push(sliceGraphemes(lineGraphemes(state, end.row), 0, end.col));
  return parts.join('\n');
}

/** Delete the current selection (no-op when there is none). */
export function deleteSelection(state: EditorState): EditorState {
  if (!state.anchor) return state;
  const [start, end] = ordered(state.anchor, state.cursor);
  const next = replaceRange(state.lines, start, end, '');
  return commit(state, { ...next, anchor: null });
}

/** Drop the selection without changing the buffer. */
export function clearSelection(state: EditorState): EditorState {
  return state.anchor ? { ...state, anchor: null } : state;
}

/** Copy (yank) the selection into the register. */
export function copySelection(state: EditorState): EditorState {
  if (!state.anchor) return state;
  return { ...state, register: selectedText(state) };
}

/** Cut the selection: copy it to the register, then delete it. */
export function cut(state: EditorState): EditorState {
  if (!state.anchor) return state;
  return deleteSelection(copySelection(state));
}

/** Paste the register at the cursor (distinct from an OS bracketed {@link paste}). */
export function pasteRegister(state: EditorState): EditorState {
  return insertText(state, state.register);
}

// ---------------------------------------------------------------------------------------------
// Cursor motion. Every motion takes `select`: true extends the selection, false clears it.
// ---------------------------------------------------------------------------------------------

function moveTo(state: EditorState, target: Cursor, select: boolean): EditorState {
  const anchor = select ? (state.anchor ?? state.cursor) : null;
  return { ...state, cursor: target, anchor };
}

export function moveLeft(state: EditorState, select = false): EditorState {
  const { row, col } = state.cursor;
  if (col > 0) return moveTo(state, { row, col: col - 1 }, select);
  if (row > 0) return moveTo(state, { row: row - 1, col: lineLen(state, row - 1) }, select);
  return moveTo(state, state.cursor, select);
}

export function moveRight(state: EditorState, select = false): EditorState {
  const { row, col } = state.cursor;
  if (col < lineLen(state, row)) return moveTo(state, { row, col: col + 1 }, select);
  if (row < lastRow(state)) return moveTo(state, { row: row + 1, col: 0 }, select);
  return moveTo(state, state.cursor, select);
}

export function moveUp(state: EditorState, select = false): EditorState {
  const { row, col } = state.cursor;
  if (row === 0) return moveTo(state, { row: 0, col: 0 }, select);
  return moveTo(state, { row: row - 1, col: Math.min(col, lineLen(state, row - 1)) }, select);
}

export function moveDown(state: EditorState, select = false): EditorState {
  const { row, col } = state.cursor;
  if (row >= lastRow(state)) return moveTo(state, { row, col: lineLen(state, row) }, select);
  return moveTo(state, { row: row + 1, col: Math.min(col, lineLen(state, row + 1)) }, select);
}

export function moveLineStart(state: EditorState, select = false): EditorState {
  return moveTo(state, { row: state.cursor.row, col: 0 }, select);
}

export function moveLineEnd(state: EditorState, select = false): EditorState {
  return moveTo(state, { row: state.cursor.row, col: lineLen(state, state.cursor.row) }, select);
}

export function moveBufferStart(state: EditorState, select = false): EditorState {
  return moveTo(state, { row: 0, col: 0 }, select);
}

export function moveBufferEnd(state: EditorState, select = false): EditorState {
  const row = lastRow(state);
  return moveTo(state, { row, col: lineLen(state, row) }, select);
}

/** A grapheme that belongs to a "word": a Unicode letter or number, or an underscore. */
function isWordGrapheme(grapheme: string): boolean {
  return grapheme === '_' || /\p{L}|\p{N}/u.test(grapheme);
}

export function moveWordRight(state: EditorState, select = false): EditorState {
  const graphemes = lineGraphemes(state, state.cursor.row);
  let i = state.cursor.col;
  if (i >= graphemes.length) {
    if (state.cursor.row < lastRow(state)) return moveTo(state, { row: state.cursor.row + 1, col: 0 }, select);
    return moveTo(state, state.cursor, select);
  }
  while (i < graphemes.length && !isWordGrapheme(graphemes[i] ?? '')) i += 1;
  while (i < graphemes.length && isWordGrapheme(graphemes[i] ?? '')) i += 1;
  return moveTo(state, { row: state.cursor.row, col: i }, select);
}

export function moveWordLeft(state: EditorState, select = false): EditorState {
  const graphemes = lineGraphemes(state, state.cursor.row);
  let i = state.cursor.col;
  if (i <= 0) {
    if (state.cursor.row > 0) {
      return moveTo(state, { row: state.cursor.row - 1, col: lineLen(state, state.cursor.row - 1) }, select);
    }
    return moveTo(state, state.cursor, select);
  }
  while (i > 0 && !isWordGrapheme(graphemes[i - 1] ?? '')) i -= 1;
  while (i > 0 && isWordGrapheme(graphemes[i - 1] ?? '')) i -= 1;
  return moveTo(state, { row: state.cursor.row, col: i }, select);
}

// ---------------------------------------------------------------------------------------------
// Undo / redo — a bounded stack of prior states (UI-03).
// ---------------------------------------------------------------------------------------------

export function undo(state: EditorState): EditorState {
  if (state.undo.length === 0) return state;
  const prev = state.undo[state.undo.length - 1];
  if (prev === undefined) return state;
  return {
    ...state,
    lines: prev.lines,
    cursor: prev.cursor,
    anchor: prev.anchor,
    undo: state.undo.slice(0, -1),
    redo: bounded([...state.redo, snapshot(state)], state.config.maxUndo),
  };
}

export function redo(state: EditorState): EditorState {
  if (state.redo.length === 0) return state;
  const next = state.redo[state.redo.length - 1];
  if (next === undefined) return state;
  return {
    ...state,
    lines: next.lines,
    cursor: next.cursor,
    anchor: next.anchor,
    redo: state.redo.slice(0, -1),
    undo: bounded([...state.undo, snapshot(state)], state.config.maxUndo),
  };
}

// ---------------------------------------------------------------------------------------------
// History (up/down + reverse search) and submit
// ---------------------------------------------------------------------------------------------

function loadBuffer(state: EditorState, text: string, extra: Partial<EditorState>): EditorState {
  const lines = text.split('\n');
  const row = lines.length - 1;
  return { ...state, lines, cursor: { row, col: graphemeCount(lines[row] ?? '') }, anchor: null, ...extra };
}

/** Navigate to an older history entry (Ctrl-P / Up), stashing the live draft on first step. */
export function historyPrev(state: EditorState): EditorState {
  if (state.history.length === 0) return state;
  const index = state.historyIndex === null ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
  const draft = state.historyIndex === null ? bufferText(state) : state.draft;
  return loadBuffer(state, state.history[index] ?? '', { historyIndex: index, draft });
}

/** Navigate to a newer entry (Ctrl-N / Down); past the newest, restore the stashed draft. */
export function historyNext(state: EditorState): EditorState {
  if (state.historyIndex === null) return state;
  const index = state.historyIndex + 1;
  if (index > state.history.length - 1) {
    return loadBuffer(state, state.draft ?? '', { historyIndex: null, draft: null });
  }
  return loadBuffer(state, state.history[index] ?? '', { historyIndex: index, draft: state.draft });
}

export interface HistoryMatch {
  readonly index: number;
  readonly text: string;
}

/**
 * Ctrl-R reverse search: entries containing `query` (case-insensitive), most recent first. A pure
 * query over history — the caller drives the incremental UI.
 */
export function historySearch(state: EditorState, query: string): HistoryMatch[] {
  const needle = query.toLowerCase();
  const matches: HistoryMatch[] = [];
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    const entry = state.history[i] ?? '';
    if (needle === '' || entry.toLowerCase().includes(needle)) matches.push({ index: i, text: entry });
  }
  return matches;
}

function appendHistory(history: readonly string[], text: string, max: number): string[] {
  // Deduplicate consecutive identical submissions — a repeated command is one history entry.
  if (history.length > 0 && history[history.length - 1] === text) return [...history];
  return bounded([...history, text], max);
}

/**
 * Submit the buffer. Returns the submitted text (null when the buffer was empty) and a fresh editor
 * whose buffer is cleared, undo/redo reset, and history extended with the submission.
 */
export function submit(state: EditorState): { state: EditorState; submitted: string | null } {
  const text = bufferText(state);
  const isEmpty = text.length === 0;
  const history = isEmpty ? [...state.history] : appendHistory(state.history, text, state.config.maxHistory);
  const next: EditorState = {
    ...state,
    lines: [''],
    cursor: { row: 0, col: 0 },
    anchor: null,
    undo: [],
    redo: [],
    history,
    historyIndex: null,
    draft: null,
    vimMode: state.config.vim ? 'normal' : 'insert',
  };
  return { state: next, submitted: isEmpty ? null : text };
}

// ---------------------------------------------------------------------------------------------
// Configurable submit
// ---------------------------------------------------------------------------------------------

export type EnterAction = 'submit' | 'newline';

/**
 * Resolve what the Enter key does, given the config and whether a modifier (Ctrl) is held. This is
 * the ONLY place the submit binding lives — a client asks here rather than hardcoding a key.
 */
export function resolveEnter(config: EditorConfig, withModifier: boolean): EnterAction {
  if (config.submit === 'enter') return withModifier ? 'newline' : 'submit';
  return withModifier ? 'submit' : 'newline';
}

// ---------------------------------------------------------------------------------------------
// Optional Vim normal mode (UI-03)
// ---------------------------------------------------------------------------------------------

function setMode(state: EditorState, mode: VimMode): EditorState {
  return { ...state, vimMode: mode };
}

/**
 * Interpret one key in Vim normal mode. A compact but real subset: motions (h/j/k/l, w/b, 0/$),
 * edits (x, D), and mode entry (i/a/A/o). No-op unless `config.vim` is set and the editor is in
 * normal mode. Typing itself still flows through {@link insertText}; this handles the command keys.
 */
export function vimKey(state: EditorState, key: string): EditorState {
  if (!state.config.vim) return state;
  if (key === 'Escape') return setMode(state, 'normal');
  if (state.vimMode !== 'normal') return state;

  switch (key) {
    case 'h':
      return moveLeft(state);
    case 'l':
      return moveRight(state);
    case 'j':
      return moveDown(state);
    case 'k':
      return moveUp(state);
    case 'w':
      return moveWordRight(state);
    case 'b':
      return moveWordLeft(state);
    case '0':
      return moveLineStart(state);
    case '$':
      return moveLineEnd(state);
    case 'x':
      return deleteForward(state);
    case 'D':
      return deleteSelection(moveLineEnd(state, true));
    case 'i':
      return setMode(state, 'insert');
    case 'a':
      return setMode(moveRight(state), 'insert');
    case 'A':
      return setMode(moveLineEnd(state), 'insert');
    case 'o':
      return setMode(newline(moveLineEnd(state)), 'insert');
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Render projection — the data the terminal draws.
// ---------------------------------------------------------------------------------------------

export interface EditorView {
  /** Each buffer line, sanitized to `SafeText` so a pasted escape sequence cannot style the terminal. */
  readonly lines: readonly SafeText[];
  /** Cursor row, grapheme column, and DISPLAY column (accounts for CJK/emoji width). */
  readonly cursor: { readonly row: number; readonly col: number; readonly displayCol: number };
  readonly selection: { readonly start: Cursor; readonly end: Cursor } | null;
  readonly vimMode: VimMode;
}

export function renderEditor(state: EditorState): EditorView {
  const lines = state.lines.map((l) => sanitize(l, { origin: 'user', multiline: false }).text);
  const prefix = sliceGraphemes(lineGraphemes(state, state.cursor.row), 0, state.cursor.col);
  const selection = state.anchor
    ? (() => {
        const [start, end] = ordered(state.anchor, state.cursor);
        return { start, end };
      })()
    : null;
  return {
    lines,
    cursor: { row: state.cursor.row, col: state.cursor.col, displayCol: stringWidth(prefix) },
    selection,
    vimMode: state.vimMode,
  };
}
