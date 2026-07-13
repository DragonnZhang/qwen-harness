/**
 * Transcript view models (UI-01, UI-02).
 *
 * This is the renderer-neutral projection layer. It folds a stream of protocol {@link Item}s into
 * an ordered list of {@link TranscriptRow}s that an Ink (or any) renderer draws. It owns no
 * terminal, so it is fully testable as data.
 *
 * TWO invariants define the module:
 *
 *   1. THE TRUST BOUNDARY (UI-02, TL-14). Every field that carries model/tool/repository text is
 *      `SafeText`: it has crossed `sanitize` with the correct origin and is inert. Framing —
 *      row labels, the yolo banner — is `TrustedChrome`, a separate type that is NEVER derived from
 *      an item's content. A tool result cannot become a label; a label cannot carry tool bytes.
 *
 *   2. COMPLETED IS STABLE, ACTIVE IS LIVE (UI-01). A completed row is frozen and keeps its object
 *      identity for the rest of the session, so a renderer can print it to scrollback ONCE and
 *      never touch it again. Only the single active row — the assistant message (or reasoning
 *      summary) still streaming — is replaced as new deltas arrive. `applyItem` reuses every
 *      existing frozen row by reference, so {@link completedRows} returns stable objects across
 *      calls while {@link activeRow} moves. That is what lets the classic view avoid re-rendering
 *      unbounded history.
 */

import type { Item, SafeText } from '@qwen-harness/protocol';
import { sanitize } from '@qwen-harness/protocol';

import { ROW_LABELS, type TrustedChrome } from './chrome.ts';
import { looksLikeUnifiedDiff, parseUnifiedDiff, type ParsedDiff } from './diff.ts';

// ---------------------------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------------------------

interface RowBase {
  readonly id: string;
  /** Ordinal within the turn, from the source item — never inferred from array position. */
  readonly seq: number;
  readonly label: TrustedChrome;
  /** False ONLY for a still-streaming assistant/reasoning row. Everything else is born complete. */
  readonly completed: boolean;
}

export interface UserRow extends RowBase {
  readonly kind: 'user';
  readonly text: SafeText;
}

export interface AssistantRow extends RowBase {
  readonly kind: 'assistant';
  readonly text: SafeText;
  /** True while the model is still streaming this message; the row will be replaced on each delta. */
  readonly streaming: boolean;
}

export interface ReasoningSummaryRow extends RowBase {
  readonly kind: 'reasoning-summary';
  readonly text: SafeText;
  readonly streaming: boolean;
}

export interface ToolCallRow extends RowBase {
  readonly kind: 'tool-call';
  readonly callId: string;
  readonly toolName: SafeText;
  readonly argsPreview: SafeText;
}

export interface ToolResultRow extends RowBase {
  readonly kind: 'tool-result';
  readonly callId: string;
  readonly toolName: SafeText;
  readonly ok: boolean;
  readonly preview: SafeText;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly errorCategory: SafeText | null;
}

export interface DiffRow extends RowBase {
  readonly kind: 'diff';
  readonly callId: string;
  readonly toolName: SafeText;
  readonly diff: ParsedDiff;
}

export interface ErrorRow extends RowBase {
  readonly kind: 'error';
  readonly category: SafeText;
  readonly message: SafeText;
  readonly retryable: boolean;
  readonly requestId: string | null;
}

export interface UsageRow extends RowBase {
  readonly kind: 'usage';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
}

export interface ProgressRow extends RowBase {
  readonly kind: 'progress';
  readonly detail: SafeText | null;
  readonly tokens: number | null;
}

export interface ApprovalRow extends RowBase {
  readonly kind: 'approval';
  readonly decision: 'allow' | 'deny' | 'ask' | 'passthrough';
  readonly scope: 'once' | 'session' | 'rule' | null;
  readonly normalizedAction: SafeText;
  readonly actorLabel: SafeText | null;
}

export interface CompactionRow extends RowBase {
  readonly kind: 'compaction';
  readonly trigger: 'proactive' | 'reactive-overflow' | 'manual';
  readonly summary: SafeText;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface UserShellRow extends RowBase {
  readonly kind: 'user-shell';
  readonly command: SafeText;
  readonly exitCode: number | null;
  readonly output: SafeText;
  readonly truncated: boolean;
}

export type TranscriptRow =
  | UserRow
  | AssistantRow
  | ReasoningSummaryRow
  | ToolCallRow
  | ToolResultRow
  | DiffRow
  | ErrorRow
  | UsageRow
  | ProgressRow
  | ApprovalRow
  | CompactionRow
  | UserShellRow;

export type TranscriptRowKind = TranscriptRow['kind'];

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface TranscriptState {
  readonly rows: readonly TranscriptRow[];
  /** Id of the single live row (a streaming assistant/reasoning message), or null. */
  readonly activeId: string | null;
}

export const EMPTY_TRANSCRIPT: TranscriptState = Object.freeze({
  rows: Object.freeze([]) as readonly TranscriptRow[],
  activeId: null,
});

/** Completed rows, in order — stable frozen objects safe to render once and leave alone (UI-01). */
export function completedRows(state: TranscriptState): readonly TranscriptRow[] {
  return state.rows.filter((row) => row.completed);
}

/** The single live row a renderer must keep re-drawing, or null when nothing is streaming (UI-01). */
export function activeRow(state: TranscriptState): TranscriptRow | null {
  if (state.activeId === null) return null;
  return state.rows.find((row) => row.id === state.activeId) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------------------------

/**
 * Fold one item into the transcript, returning a NEW state. Existing rows are reused by reference,
 * so completed rows keep their identity (UI-01). A streaming assistant/reasoning item upserts the
 * active row; every other item — and the completing delta of a streaming one — produces a frozen
 * completed row.
 */
export function applyItem(state: TranscriptState, item: Item): TranscriptState {
  const built = buildRow(item);
  const rows = [...state.rows];
  const existing = rows.findIndex((row) => row.id === built.id);
  if (existing >= 0) {
    rows[existing] = built;
  } else {
    rows.push(built);
  }

  // A live row makes itself active; a completed row that finalises the current active clears it.
  let activeId = state.activeId;
  if (!built.completed) {
    activeId = built.id;
  } else if (activeId === built.id) {
    activeId = null;
  }

  return { rows, activeId };
}

/**
 * Fold a whole sequence of items — the common "rebuild from history" path.
 *
 * This does NOT simply fold `applyItem`, and that is the point. `applyItem` is correct for the
 * INCREMENTAL case: it copies the row array so each state is immutable, and it looks up the target
 * row with a linear scan. Both are fine for one item. Folding it over a whole history makes each of
 * them quadratic, and the performance gate caught exactly that — rebuilding a 10,000-row transcript
 * took **17.8 seconds**, which is what a user resuming a long session would have sat through before
 * seeing a single row. Nothing in the per-frame numbers hinted at it; the frame cost was 1.2 ms.
 *
 * So the bulk path accumulates once: a single array, and a Map from row id to position so an update
 * to an existing row is O(1) instead of a scan. The observable semantics are identical to folding
 * `applyItem`, and `view-model.test.ts` asserts that equivalence on a real item sequence so the two
 * can never drift apart.
 */
export function buildTranscript(items: Iterable<Item>): TranscriptState {
  const rows: TranscriptRow[] = [];
  const positionById = new Map<string, number>();
  let activeId: string | null = null;

  for (const item of items) {
    const built = buildRow(item);
    const at = positionById.get(built.id);
    if (at !== undefined) {
      rows[at] = built;
    } else {
      positionById.set(built.id, rows.length);
      rows.push(built);
    }

    // Identical to `applyItem`: a live row becomes active; a completed row that finalises the
    // current active one clears it.
    if (!built.completed) {
      activeId = built.id;
    } else if (activeId === built.id) {
      activeId = null;
    }
  }

  return { rows, activeId };
}

// ---------------------------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------------------------

function modelText(text: string): SafeText {
  return sanitize(text, { origin: 'model' }).text;
}

function toolText(text: string, maxLength: number): SafeText {
  return sanitize(text, { origin: 'tool', maxLength }).text;
}

function line(
  text: string,
  origin: 'model' | 'tool' | 'provider' | 'user',
  maxLength = 200,
): SafeText {
  return sanitize(text, { origin, multiline: false, maxLength }).text;
}

function buildRow(item: Item): TranscriptRow {
  switch (item.type) {
    case 'user-message':
      return frozen<UserRow>({
        kind: 'user',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.user,
        completed: true,
        text: sanitize(item.text, { origin: 'user' }).text,
      });

    case 'assistant-message':
      return frozen<AssistantRow>({
        kind: 'assistant',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.assistant,
        completed: item.complete,
        streaming: !item.complete,
        text: modelText(item.text),
      });

    case 'reasoning-summary':
      return frozen<ReasoningSummaryRow>({
        kind: 'reasoning-summary',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.reasoningSummary,
        completed: item.complete,
        streaming: !item.complete,
        text: modelText(item.summary),
      });

    case 'reasoning-status':
      return frozen<ProgressRow>({
        kind: 'progress',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.reasoningStatus,
        completed: true,
        detail: null,
        tokens: item.reasoningTokens,
      });

    case 'tool-call':
      return frozen<ToolCallRow>({
        kind: 'tool-call',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.toolCall,
        completed: true,
        callId: item.callId,
        toolName: line(item.toolName, 'model'),
        argsPreview: toolText(previewArgs(item.arguments, item.argumentsJson), 2000),
      });

    case 'tool-result': {
      const preview = toolText(item.preview, 4000);
      if (looksLikeUnifiedDiff(item.preview)) {
        return frozen<DiffRow>({
          kind: 'diff',
          id: item.id,
          seq: item.seq,
          label: ROW_LABELS.diff,
          completed: true,
          callId: item.callId,
          toolName: line(item.toolName, 'model'),
          diff: parseUnifiedDiff(item.preview),
        });
      }
      return frozen<ToolResultRow>({
        kind: 'tool-result',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.toolResult,
        completed: true,
        callId: item.callId,
        toolName: line(item.toolName, 'model'),
        ok: item.ok,
        preview,
        truncated: item.truncated,
        durationMs: item.durationMs,
        errorCategory: item.errorCategory === null ? null : line(item.errorCategory, 'tool'),
      });
    }

    case 'error':
      return frozen<ErrorRow>({
        kind: 'error',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.error,
        completed: true,
        category: line(item.category, 'provider'),
        message: sanitize(item.message, { origin: 'provider' }).text,
        retryable: item.retryable,
        requestId: item.requestId,
      });

    case 'usage':
      return frozen<UsageRow>({
        kind: 'usage',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.usage,
        completed: true,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        totalTokens: item.totalTokens,
        reasoningTokens: item.reasoningTokens,
        cachedInputTokens: item.cachedInputTokens,
      });

    case 'approval':
      return frozen<ApprovalRow>({
        kind: 'approval',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.approval,
        completed: true,
        decision: item.decision,
        scope: item.scope,
        normalizedAction: line(item.normalizedAction, 'tool', 400),
        actorLabel: item.actor.label === undefined ? null : line(item.actor.label, 'user'),
      });

    case 'compaction':
      return frozen<CompactionRow>({
        kind: 'compaction',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.compaction,
        completed: true,
        trigger: item.trigger,
        summary: modelText(item.summary),
        tokensBefore: item.tokensBefore,
        tokensAfter: item.tokensAfter,
      });

    case 'user-shell':
      return frozen<UserShellRow>({
        kind: 'user-shell',
        id: item.id,
        seq: item.seq,
        label: ROW_LABELS.userShell,
        completed: true,
        command: line(item.command, 'user', 400),
        exitCode: item.exitCode,
        output: toolText(item.output, 4000),
        truncated: item.truncated,
      });
  }
}

/** A compact, single-ish-line rendering of tool arguments for the call preview. */
function previewArgs(args: Record<string, unknown> | null, raw: string): string {
  if (args !== null) {
    try {
      return JSON.stringify(args);
    } catch {
      // Arguments contained something non-serialisable (a cycle); fall back to the raw JSON string.
      return raw;
    }
  }
  return raw;
}

/**
 * Deep-freeze a row so neither a renderer nor a later fold can mutate a completed projection.
 * Frozen-in-place identity is exactly what makes completed rows stable across `applyItem` (UI-01).
 */
function frozen<T extends TranscriptRow>(row: T): T {
  deepFreeze(row);
  return row;
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}
