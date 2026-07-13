/**
 * The injected item source (design.md §11, ADR 0004 consequence 1).
 *
 * The Ink app owns NO agent-loop state. It reads protocol {@link Item}s from a `RuntimeSource` and
 * projects them with `tui-kit`'s view models. In production the runtime supplies this source; in a
 * test a fake supplies a fixed or scripted list. That injection is what lets the whole UI render —
 * and be asserted on — without a live model or a terminal.
 */

import type { Item } from '@qwen-harness/protocol';

export interface RuntimeSource {
  /** The current, ordered item list. A streaming assistant item grows in place under one id. */
  getItems(): readonly Item[];
  /** Subscribe to changes; returns an unsubscribe. The listener re-reads {@link getItems}. */
  subscribe(listener: () => void): () => void;
}

/** A fixed, non-streaming source — the common unit-test shape. */
export function arraySource(items: readonly Item[]): RuntimeSource {
  return {
    getItems: () => items,
    subscribe: () => () => undefined,
  };
}

/** A source that can be driven after mount: `push` appends, `replace` upserts a streaming item. */
export interface MutableSource extends RuntimeSource {
  /** Append a new item (or replace an existing one with the same id, e.g. a streaming delta). */
  push(item: Item): void;
  /** Replace the whole list. */
  replace(items: readonly Item[]): void;
}

export function emitterSource(initial: readonly Item[] = []): MutableSource {
  let items: readonly Item[] = [...initial];
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    getItems: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(item) {
      const existing = items.findIndex((row) => row.id === item.id);
      items =
        existing >= 0 ? items.map((row, i) => (i === existing ? item : row)) : [...items, item];
      emit();
    },
    replace(next) {
      items = [...next];
      emit();
    },
  };
}
