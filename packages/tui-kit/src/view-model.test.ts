import { describe, expect, it } from 'vitest';

import {
  activeRow,
  applyItem,
  buildTranscript,
  completedRows,
  EMPTY_TRANSCRIPT,
} from './view-model.ts';

/**
 * Minimal item factories. `applyItem` reads item fields directly (it does not re-validate through
 * zod), so plain objects matching the protocol shape are sufficient — and keep the tests focused on
 * the projection, not on schema construction.
 */
let seq = 0;
function base(type, id, extra) {
  seq += 1;
  return { id, turnId: 't1', threadId: 'th1', seq, createdAt: 0, type, ...extra };
}
const user = (id, text) => base('user-message', id, { text });
const assistant = (id, text, complete) => base('assistant-message', id, { text, complete });
const toolCall = (id, name, argumentsJson) =>
  base('tool-call', id, { callId: 'c1', toolName: name, argumentsJson, arguments: null });
const toolResult = (id, preview, ok = true) =>
  base('tool-result', id, {
    callId: 'c1',
    toolName: 'shell',
    ok,
    preview,
    outputRef: null,
    truncated: false,
    durationMs: 12,
    errorCategory: null,
  });

describe('transcript view models (UI-01/UI-02)', () => {
  it('builds the right rows from a stream of items', () => {
    const state = buildTranscript([
      user('u1', 'hello'),
      assistant('a1', 'hi there', true),
      toolCall('tc1', 'shell', '{"cmd":"ls"}'),
      toolResult('tr1', 'file-a\nfile-b'),
    ]);
    expect(state.rows.map((r) => r.kind)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result',
    ]);
    expect(state.rows[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(state.rows[2]).toMatchObject({ kind: 'tool-call', toolName: 'shell' });
  });

  it('keeps completed rows stable and frozen while only the active row updates (UI-01)', () => {
    let state = applyItem(EMPTY_TRANSCRIPT, user('u1', 'question'));
    const completedUser = completedRows(state)[0];
    expect(Object.isFrozen(completedUser)).toBe(true);

    // Stream an assistant message in two deltas under the same id.
    state = applyItem(state, assistant('a1', 'par', false));
    expect(activeRow(state)?.kind).toBe('assistant');
    expect(activeRow(state)).toMatchObject({ text: 'par', streaming: true });
    expect(state.activeId).toBe('a1');

    const beforeUpdate = completedRows(state)[0];
    state = applyItem(state, assistant('a1', 'partial answer', false));
    const afterUpdate = completedRows(state)[0];

    // The completed user row is the SAME frozen object across the active update.
    expect(afterUpdate).toBe(beforeUpdate);
    expect(afterUpdate).toBe(completedUser);
    expect(activeRow(state)).toMatchObject({ text: 'partial answer' });

    // Completing the message finalises it and clears the active slot.
    state = applyItem(state, assistant('a1', 'partial answer done', true));
    expect(activeRow(state)).toBeNull();
    const finalAssistant = state.rows.find((r) => r.id === 'a1');
    expect(finalAssistant).toMatchObject({ completed: true, streaming: false });
    expect(Object.isFrozen(finalAssistant)).toBe(true);
  });

  it('makes tool output with ANSI/OSC inert SafeText (TL-11)', () => {
    const hostile = 'ok \u001b[31mRED\u001b[0m \u001b]0;title\u0007 \u0007done';
    const state = applyItem(EMPTY_TRANSCRIPT, toolResult('tr1', hostile));
    const row = state.rows[0];
    expect(row?.kind).toBe('tool-result');
    if (row?.kind === 'tool-result') {
      expect(row.preview).not.toContain('\u001b'); // no escape survives
      expect(row.preview).not.toContain('[31m'); // payload of the CSI is gone
      expect(row.preview).not.toContain('title'); // OSC payload gone
      expect(row.preview).toContain('RED'); // visible content remains
      expect(row.preview).toContain('done');
    }
  });

  it('projects a diff-shaped tool result into a diff row (UI-02)', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n');
    const state = applyItem(EMPTY_TRANSCRIPT, toolResult('tr1', diff));
    const row = state.rows[0];
    expect(row?.kind).toBe('diff');
    if (row?.kind === 'diff') {
      expect(row.diff.hunks).toHaveLength(1);
      expect(row.diff.hunks[0]?.lines.map((l) => l.kind)).toEqual(['context', 'remove', 'add']);
    }
  });

  it('projects reasoning-status as a progress row without content', () => {
    const status = base('reasoning-status', 'r1', { reasoningOccurred: true, reasoningTokens: 128 });
    const state = applyItem(EMPTY_TRANSCRIPT, status);
    expect(state.rows[0]).toMatchObject({ kind: 'progress', tokens: 128, detail: null });
  });

  it('applyItem is pure: the prior state is unchanged', () => {
    const first = applyItem(EMPTY_TRANSCRIPT, user('u1', 'a'));
    const second = applyItem(first, user('u2', 'b'));
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(2);
  });
});
