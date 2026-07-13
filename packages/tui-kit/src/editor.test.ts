import { describe, expect, it } from 'vitest';

import {
  backspace,
  bufferText,
  createEditor,
  cut,
  deleteForward,
  deleteSelection,
  historyNext,
  historyPrev,
  historySearch,
  insertText,
  moveBufferEnd,
  moveBufferStart,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  newline,
  paste,
  pasteRegister,
  redo,
  renderEditor,
  resolveEnter,
  submit,
  undo,
  vimKey,
} from './editor.ts';

describe('editor: basic text mutation', () => {
  it('inserts, deletes, and splits lines', () => {
    let s = createEditor();
    s = insertText(s, 'hello');
    expect(bufferText(s)).toBe('hello');
    expect(s.cursor).toEqual({ row: 0, col: 5 });

    s = backspace(s);
    expect(bufferText(s)).toBe('hell');

    s = newline(s);
    s = insertText(s, 'o');
    expect(bufferText(s)).toBe('hell\no');
    expect(s.cursor).toEqual({ row: 1, col: 1 });

    s = moveLeft(s);
    s = deleteForward(s);
    expect(bufferText(s)).toBe('hell\n');
  });
});

describe('editor: Unicode-correct cursor motion (UI-03)', () => {
  it('steps over CJK one grapheme at a time with width-two display', () => {
    let s = createEditor();
    s = insertText(s, '你好');
    expect(bufferText(s)).toBe('你好');
    expect(s.cursor.col).toBe(2);
    expect(renderEditor(s).cursor.displayCol).toBe(4);

    s = moveLeft(s);
    expect(s.cursor.col).toBe(1);
    expect(renderEditor(s).cursor.displayCol).toBe(2);
  });

  it('treats an emoji as a single cursor stop and a single backspace', () => {
    let s = createEditor();
    s = insertText(s, '👍');
    expect(s.cursor.col).toBe(1);
    expect(renderEditor(s).cursor.displayCol).toBe(2);
    s = backspace(s);
    expect(bufferText(s)).toBe('');
  });

  it('deletes an e+combining-accent as one grapheme', () => {
    let s = createEditor();
    s = insertText(s, 'e\u0301'); // e + COMBINING ACUTE ACCENT (two code points, one grapheme)
    expect(bufferText(s).length).toBe(2); // two code points stored
    expect(s.cursor.col).toBe(1); // but one cursor stop
    s = backspace(s);
    expect(bufferText(s)).toBe(''); // one backspace removes the whole grapheme
  });

  it('moves by Unicode words over "foo bar_baz"', () => {
    let s = createEditor();
    s = insertText(s, 'foo bar_baz');
    s = moveBufferStart(s);

    s = moveWordRight(s);
    expect(s.cursor.col).toBe(3); // end of "foo"
    s = moveWordRight(s);
    expect(s.cursor.col).toBe(11); // end of "bar_baz" (underscore is a word char)

    s = moveWordLeft(s);
    expect(s.cursor.col).toBe(4); // start of "bar_baz"
    s = moveWordLeft(s);
    expect(s.cursor.col).toBe(0); // start of "foo"
  });
});

describe('editor: bracketed paste is literal (UI-03)', () => {
  it('inserts a multiline paste as line breaks, never a submit', () => {
    let s = createEditor();
    s = paste(s, 'line one\nline two');
    expect(s.lines).toEqual(['line one', 'line two']);
    expect(s.cursor).toEqual({ row: 1, col: 8 });
  });

  it('stores a pasted control sequence verbatim but renders it inert', () => {
    let s = createEditor();
    s = paste(s, 'a\u001b[31mb');
    // Buffer keeps the raw bytes so editing is exact.
    expect(bufferText(s)).toContain('\u001b');
    // The render projection is SafeText: the escape is gone.
    const view = renderEditor(s);
    expect(view.lines[0]).not.toContain('\u001b');
    expect(view.lines[0]).not.toContain('[31m');
  });
});

describe('editor: selection, register, undo/redo', () => {
  it('selects with shift+motion and deletes the selection', () => {
    let s = createEditor();
    s = insertText(s, 'hello');
    s = moveBufferStart(s);
    s = moveRight(s, true);
    s = moveRight(s, true);
    s = moveRight(s, true);
    expect(s.anchor).toEqual({ row: 0, col: 0 });
    s = deleteSelection(s);
    expect(bufferText(s)).toBe('lo');
  });

  it('cuts and pastes through the register', () => {
    let s = createEditor();
    s = insertText(s, 'abcdef');
    s = moveBufferStart(s);
    s = moveRight(s, true);
    s = moveRight(s, true);
    s = moveRight(s, true);
    s = cut(s); // register = "abc"
    expect(bufferText(s)).toBe('def');
    s = moveBufferEnd(s);
    s = pasteRegister(s);
    expect(bufferText(s)).toBe('defabc');
  });

  it('round-trips undo and redo', () => {
    let s = createEditor();
    s = insertText(s, 'hello');
    s = insertText(s, ' world');
    expect(bufferText(s)).toBe('hello world');
    s = undo(s);
    expect(bufferText(s)).toBe('hello');
    s = undo(s);
    expect(bufferText(s)).toBe('');
    s = redo(s);
    expect(bufferText(s)).toBe('hello');
    s = redo(s);
    expect(bufferText(s)).toBe('hello world');
  });
});

describe('editor: history and reverse search (UI-03)', () => {
  it('navigates up/down and reverse-searches submitted entries', () => {
    let s = createEditor();
    s = insertText(s, 'first command');
    s = submit(s).state;
    s = insertText(s, 'second command');
    s = submit(s).state;
    expect(s.history).toEqual(['first command', 'second command']);

    s = historyPrev(s);
    expect(bufferText(s)).toBe('second command');
    s = historyPrev(s);
    expect(bufferText(s)).toBe('first command');
    s = historyNext(s);
    expect(bufferText(s)).toBe('second command');
    s = historyNext(s);
    expect(bufferText(s)).toBe(''); // back to the (empty) live draft

    const matches = historySearch(s, 'first');
    expect(matches).toEqual([{ index: 0, text: 'first command' }]);
  });

  it('stashes and restores a live draft while browsing history', () => {
    let s = createEditor();
    s = insertText(s, 'old');
    s = submit(s).state;
    s = insertText(s, 'draft in progress');
    s = historyPrev(s);
    expect(bufferText(s)).toBe('old');
    s = historyNext(s);
    expect(bufferText(s)).toBe('draft in progress');
  });

  it('reports submitted text and clears the buffer', () => {
    let s = createEditor();
    s = insertText(s, 'do the thing');
    const result = submit(s);
    expect(result.submitted).toBe('do the thing');
    expect(bufferText(result.state)).toBe('');
    expect(submit(result.state).submitted).toBeNull(); // empty buffer submits nothing
  });
});

describe('editor: configurable submit (UI-03)', () => {
  it('binds Enter vs Ctrl-Enter by config, not hardcoded', () => {
    const enter = createEditor({ submit: 'enter' }).config;
    expect(resolveEnter(enter, false)).toBe('submit');
    expect(resolveEnter(enter, true)).toBe('newline');

    const ctrl = createEditor({ submit: 'ctrl-enter' }).config;
    expect(resolveEnter(ctrl, false)).toBe('newline');
    expect(resolveEnter(ctrl, true)).toBe('submit');
  });
});

describe('editor: optional Vim normal mode (UI-03)', () => {
  it('starts in normal mode and handles motions and mode entry', () => {
    let s = createEditor({ vim: true });
    expect(s.vimMode).toBe('normal');

    s = vimKey(s, 'i'); // enter insert
    expect(s.vimMode).toBe('insert');
    s = insertText(s, 'hello world');
    s = vimKey(s, 'Escape');
    expect(s.vimMode).toBe('normal');

    s = vimKey(s, '0'); // line start
    expect(s.cursor.col).toBe(0);
    s = vimKey(s, 'w'); // word right
    expect(s.cursor.col).toBe(5);
    s = vimKey(s, '$'); // line end
    expect(s.cursor.col).toBe(11);
    s = vimKey(s, '0');
    s = vimKey(s, 'x'); // delete char under cursor
    expect(bufferText(s)).toBe('ello world');
  });

  it('is inert when vim is disabled', () => {
    let s = createEditor();
    s = insertText(s, 'abc');
    const before = bufferText(s);
    s = vimKey(s, 'x');
    expect(bufferText(s)).toBe(before);
  });
});
