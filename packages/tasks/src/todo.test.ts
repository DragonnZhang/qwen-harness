import { describe, expect, it } from 'vitest';

import { TodoList } from './todo.ts';

/**
 * The turn-local todo checklist (WK-01/WK-02). These tests pin the ephemeral, in-memory contract:
 * bulk `TodoWrite` replace, incremental edits, ordering, the TUI projection, and compaction-safe
 * snapshotting. There is deliberately NO storage here — a todo owns no database.
 */
describe('TodoList (WK-01)', () => {
  it('bulk-replaces with legacy TodoWrite semantics (WK-02)', () => {
    const todos = new TodoList();
    todos.set([
      { content: 'Read the spec', activeForm: 'Reading the spec', status: 'completed' },
      { content: 'Write the code', activeForm: 'Writing the code', status: 'in-progress' },
      { content: 'Run the tests', activeForm: 'Running the tests' },
    ]);

    const items = todos.list();
    expect(items.map((t) => t.content)).toEqual([
      'Read the spec',
      'Write the code',
      'Run the tests',
    ]);
    expect(items.map((t) => t.status)).toEqual(['completed', 'in-progress', 'pending']);
    expect(items.map((t) => t.order)).toEqual([0, 1, 2]);
  });

  it('defaults a todo without an explicit status to pending', () => {
    const todos = new TodoList();
    todos.set([{ content: 'X', activeForm: 'Xing' }]);
    expect(todos.list()[0]?.status).toBe('pending');
  });

  it('adds and updates a single entry by id without disturbing the rest', () => {
    const todos = new TodoList();
    const a = todos.add({ content: 'A', activeForm: 'Aing' });
    const b = todos.add({ content: 'B', activeForm: 'Bing' });

    todos.updateStatus(b, 'in-progress');
    expect(todos.list().find((t) => t.id === a)?.status).toBe('pending');
    expect(todos.list().find((t) => t.id === b)?.status).toBe('in-progress');
  });

  it('throws on updating or reordering unknown ids rather than silently no-oping', () => {
    const todos = new TodoList();
    todos.add({ content: 'A', activeForm: 'Aing' });
    expect(() => todos.updateStatus(999, 'completed')).toThrow(/does not exist/);
    expect(() => todos.reorder([999])).toThrow(/every current todo id/);
  });

  it('reorders to an explicit id sequence', () => {
    const todos = new TodoList();
    const a = todos.add({ content: 'A', activeForm: 'Aing' });
    const b = todos.add({ content: 'B', activeForm: 'Bing' });
    const c = todos.add({ content: 'C', activeForm: 'Cing' });

    todos.reorder([c, a, b]);
    expect(todos.list().map((t) => t.id)).toEqual([c, a, b]);
    expect(todos.list().map((t) => t.order)).toEqual([0, 1, 2]);
  });

  it('projects the active present-continuous label and counts for the TUI', () => {
    const todos = new TodoList();
    todos.set([
      { content: 'A', activeForm: 'Aing', status: 'completed' },
      { content: 'B', activeForm: 'Building B', status: 'in-progress' },
      { content: 'C', activeForm: 'Cing' },
    ]);

    const projection = todos.projection();
    expect(projection.activeLabel).toBe('Building B');
    expect(projection.counts).toEqual({ pending: 1, inProgress: 1, completed: 1 });
  });

  it('reports no active label when nothing is in progress', () => {
    const todos = new TodoList();
    todos.set([{ content: 'A', activeForm: 'Aing' }]);
    expect(todos.projection().activeLabel).toBeNull();
  });

  it('survives a compaction snapshot -> restore round-trip preserving ids and order', () => {
    const todos = new TodoList();
    const a = todos.add({ content: 'A', activeForm: 'Aing' });
    const b = todos.add({ content: 'B', activeForm: 'Bing' });
    todos.updateStatus(a, 'completed');
    todos.reorder([b, a]);

    const restored = TodoList.fromSnapshot(todos.snapshot());
    expect(restored.list().map((t) => t.id)).toEqual([b, a]);
    expect(restored.list().find((t) => t.id === a)?.status).toBe('completed');

    // A restored list keeps allocating ids ABOVE the highest restored id (no collision).
    const c = restored.add({ content: 'C', activeForm: 'Cing' });
    expect(c).toBeGreaterThan(Math.max(a, b));
  });

  it('rejects an empty content or activeForm at the boundary', () => {
    const todos = new TodoList();
    expect(() => todos.add({ content: '', activeForm: 'x' })).toThrow();
    expect(() => todos.add({ content: 'x', activeForm: '' })).toThrow();
  });
});
