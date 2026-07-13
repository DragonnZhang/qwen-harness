/**
 * Transcript inspector (UI-09).
 *
 * A view OVER the transcript rows for expand/collapse, search, and filtering. It binds to the
 * public {@link TranscriptRow} projection, not to any event store, so a consumer can page, search,
 * and copy without touching internal storage (UI-09's decoupling requirement).
 *
 * Collapse state is keyed by row id and lives here as pure data; the fold in `view-model.ts` owns
 * the rows themselves. Search matches only `SafeText` content — it can never match into trusted
 * chrome, and every rendered match remains inert.
 */

import { rowSearchText } from './row-text.ts';
import type { TranscriptRow } from './view-model.ts';

export interface InspectorRow {
  readonly index: number;
  readonly row: TranscriptRow;
  readonly collapsed: boolean;
}

/**
 * Per-row expand/collapse state plus text search. Immutable operations: each mutator returns a new
 * inspector, so a renderer can diff old against new.
 */
export class TranscriptInspector {
  readonly #collapsed: ReadonlySet<string>;

  constructor(collapsed: ReadonlySet<string> = new Set()) {
    this.#collapsed = collapsed;
  }

  isCollapsed(id: string): boolean {
    return this.#collapsed.has(id);
  }

  collapse(id: string): TranscriptInspector {
    if (this.#collapsed.has(id)) return this;
    const next = new Set(this.#collapsed);
    next.add(id);
    return new TranscriptInspector(next);
  }

  expand(id: string): TranscriptInspector {
    if (!this.#collapsed.has(id)) return this;
    const next = new Set(this.#collapsed);
    next.delete(id);
    return new TranscriptInspector(next);
  }

  toggle(id: string): TranscriptInspector {
    return this.#collapsed.has(id) ? this.expand(id) : this.collapse(id);
  }

  /** Collapse every given row at once (e.g. "collapse all"). */
  collapseAll(rows: readonly TranscriptRow[]): TranscriptInspector {
    return new TranscriptInspector(new Set(rows.map((r) => r.id)));
  }

  /** Expand everything. */
  expandAll(): TranscriptInspector {
    return new TranscriptInspector(new Set());
  }

  /** Project rows with their index and collapse flag — the shape a virtualized list renders. */
  project(rows: readonly TranscriptRow[]): InspectorRow[] {
    return rows.map((row, index) => ({ index, row, collapsed: this.#collapsed.has(row.id) }));
  }

  /**
   * Row indices whose sanitized content contains `query` (case-insensitive). An empty query matches
   * nothing, so a cleared search box highlights nothing rather than everything.
   */
  search(rows: readonly TranscriptRow[], query: string): number[] {
    const needle = query.toLowerCase();
    if (needle === '') return [];
    const hits: number[] = [];
    rows.forEach((row, index) => {
      if (rowSearchText(row).toLowerCase().includes(needle)) hits.push(index);
    });
    return hits;
  }

  /** The rows themselves that match `query`, in order — a filtered projection (UI-09). */
  filter(rows: readonly TranscriptRow[], query: string): TranscriptRow[] {
    return this.search(rows, query)
      .map((index) => rows[index])
      .filter((row): row is TranscriptRow => row !== undefined);
  }
}
