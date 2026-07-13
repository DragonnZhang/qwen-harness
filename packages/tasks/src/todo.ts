import { z } from 'zod';

/**
 * The turn-local todo checklist (WK-01/WK-02).
 *
 * This is DELIBERATELY a different system from the durable task graph. A todo is ephemeral working
 * memory for the current turn: an ordered list of short steps the agent shows the user while it
 * works. It has no owner, no dependencies, no persistence of its own, and no cross-turn identity.
 * It is plain data that the compaction system carries forward verbatim — it is never conflated with
 * a {@link Task}. Mutating a todo touches nothing in the durable graph, and vice versa (WK-02).
 *
 * `TodoWrite`-style bulk replace ({@link TodoList.set}) remains usable alongside the incremental
 * API, because that is the legacy shape callers already speak (WK-02).
 */

export const TODO_STATUSES = ['pending', 'in-progress', 'completed'] as const;
export const TodoStatusSchema = z.enum(TODO_STATUSES);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

/**
 * One checklist entry. `content` is the imperative label ("Add the migration"); `activeForm` is
 * the present-continuous label shown while it runs ("Adding the migration"). Carrying both means
 * the UI never has to string-munge one into the other (WK-01).
 */
export const TodoInputSchema = z.object({
  content: z.string().min(1),
  activeForm: z.string().min(1),
  status: TodoStatusSchema.default('pending'),
});
export type TodoInput = z.input<typeof TodoInputSchema>;

export interface Todo {
  /** Stable within the list, assigned in insertion order. Lets callers update by identity. */
  readonly id: number;
  readonly content: string;
  readonly activeForm: string;
  readonly status: TodoStatus;
  /** Explicit ordinal, so ordering never depends on array insertion accidents. */
  readonly order: number;
}

/** The projection the TUI renders (WK-01). Trusted-shape data, not the entries' raw storage. */
export interface TodoProjection {
  readonly items: readonly Todo[];
  /** The present-continuous label of the first in-progress item, for a status line. */
  readonly activeLabel: string | null;
  readonly counts: {
    readonly pending: number;
    readonly inProgress: number;
    readonly completed: number;
  };
}

export class TodoList {
  #items: Todo[] = [];
  #nextId = 1;

  /**
   * Bulk replace — the legacy `TodoWrite` semantics (WK-02). The whole list becomes exactly these
   * entries, re-numbered and re-ordered from scratch. Ids are NOT preserved across a `set`, because
   * a bulk replace is a new list, not an edit of the old one.
   */
  set(inputs: readonly TodoInput[]): void {
    this.#items = inputs.map((raw, index) => {
      const parsed = TodoInputSchema.parse(raw);
      return {
        id: this.#nextId++,
        content: parsed.content,
        activeForm: parsed.activeForm,
        status: parsed.status,
        order: index,
      };
    });
  }

  /** Append one entry to the end of the list. Returns its assigned id. */
  add(input: TodoInput): number {
    const parsed = TodoInputSchema.parse(input);
    const id = this.#nextId++;
    this.#items.push({
      id,
      content: parsed.content,
      activeForm: parsed.activeForm,
      status: parsed.status,
      order: this.#items.length,
    });
    return id;
  }

  /** Move an entry to a new status. Throws if the id is unknown — a silent no-op hides bugs. */
  updateStatus(id: number, status: TodoStatus): void {
    const validated = TodoStatusSchema.parse(status);
    const item = this.#items.find((t) => t.id === id);
    if (!item) throw new Error(`todo ${id} does not exist`);
    this.#replace({ ...item, status: validated });
  }

  /** Reorder the list to the given id sequence. Every current id must appear exactly once. */
  reorder(idsInOrder: readonly number[]): void {
    const current = new Set(this.#items.map((t) => t.id));
    const requested = new Set(idsInOrder);
    if (
      requested.size !== idsInOrder.length ||
      requested.size !== current.size ||
      [...current].some((id) => !requested.has(id))
    ) {
      throw new Error('reorder must list every current todo id exactly once');
    }
    const byId = new Map(this.#items.map((t) => [t.id, t]));
    this.#items = idsInOrder.map((id, index) => {
      const item = byId.get(id);
      if (!item) throw new Error(`todo ${id} does not exist`);
      return { ...item, order: index };
    });
  }

  #replace(next: Todo): void {
    this.#items = this.#items.map((t) => (t.id === next.id ? next : t));
  }

  /** The ordered entries. A copy, so a caller cannot mutate internal state. */
  list(): Todo[] {
    return [...this.#items].sort((a, b) => a.order - b.order);
  }

  /** The render projection for the TUI (WK-01). */
  projection(): TodoProjection {
    const items = this.list();
    const activeLabel = items.find((t) => t.status === 'in-progress')?.activeForm ?? null;
    return {
      items,
      activeLabel,
      counts: {
        pending: items.filter((t) => t.status === 'pending').length,
        inProgress: items.filter((t) => t.status === 'in-progress').length,
        completed: items.filter((t) => t.status === 'completed').length,
      },
    };
  }

  /**
   * A plain-data snapshot the compaction system carries across a compaction boundary (WK-01). It is
   * just the entries — no behavior, no hidden state — so it survives being serialized and restored.
   */
  snapshot(): readonly Todo[] {
    return this.list();
  }

  /** Rehydrate a list from a snapshot (e.g. after compaction), preserving ids and order. */
  static fromSnapshot(items: readonly Todo[]): TodoList {
    const list = new TodoList();
    list.#items = items.map((t, index) => ({ ...t, order: index }));
    list.#nextId = items.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    return list;
  }
}
