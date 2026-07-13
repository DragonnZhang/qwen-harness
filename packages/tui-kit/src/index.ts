/**
 * @qwen-harness/tui-kit
 *
 * The RENDERER-NEUTRAL layer of the TUI (design.md §11, ADR 0004). It transforms typed protocol
 * events/items into renderable view models and manages editor state as pure data. It owns NO
 * terminal and no Ink components — those live in `apps/tui` and consume these projections. Keeping
 * the view models and the editor renderer-independent is the whole point: they are testable without
 * a terminal, and they are a PURE package (architecture rule 5) with no host I/O, clock, or RNG.
 *
 * The trust boundary runs through everything here (UI-02, TL-14):
 *
 *   - Untrusted content (model/tool/repo text) is `SafeText` — it has crossed `sanitize` and is
 *     inert. The renderer accepts only `SafeText` for content.
 *   - Framing (labels, the yolo banner) is `TrustedChrome` — a SEPARATE type the client owns and
 *     the only thing allowed to style the terminal. It is never derived from untrusted input.
 *
 * And the completed-vs-active split (UI-01): completed rows are frozen and stable so the classic
 * view prints them once; only the single active streaming row is re-rendered.
 */

// Unicode primitives (grapheme segmentation + terminal width).
export {
  toGraphemes,
  graphemeCount,
  graphemeWidth,
  stringWidth,
  sliceGraphemes,
} from './unicode.ts';

// Trusted chrome (the styled framing side of the trust boundary).
export { chrome, ROW_LABELS, YOLO_BANNER } from './chrome.ts';
export type { TrustedChrome } from './chrome.ts';

// Transcript view models (UI-01, UI-02).
export {
  EMPTY_TRANSCRIPT,
  applyItem,
  buildTranscript,
  completedRows,
  activeRow,
} from './view-model.ts';
export type {
  TranscriptState,
  TranscriptRow,
  TranscriptRowKind,
  UserRow,
  AssistantRow,
  ReasoningSummaryRow,
  ToolCallRow,
  ToolResultRow,
  DiffRow,
  ErrorRow,
  UsageRow,
  ProgressRow,
  ApprovalRow,
  CompactionRow,
  UserShellRow,
} from './view-model.ts';
export { rowSearchText } from './row-text.ts';

// Unified diff parsing (UI-02).
export { parseUnifiedDiff, looksLikeUnifiedDiff } from './diff.ts';
export type { ParsedDiff, DiffFile, DiffHunk, DiffLine, DiffLineKind } from './diff.ts';

// Markdown/code segmentation (UI-02).
export { segmentMarkdown, parseInline } from './markdown.ts';
export type { MarkdownBlock, InlineSpan } from './markdown.ts';

// Multiline editor state machine (UI-03).
export {
  DEFAULT_EDITOR_CONFIG,
  createEditor,
  bufferText,
  withHistory,
  insertText,
  paste,
  newline,
  backspace,
  deleteForward,
  selectedText,
  deleteSelection,
  clearSelection,
  copySelection,
  cut,
  pasteRegister,
  moveLeft,
  moveRight,
  moveUp,
  moveDown,
  moveLineStart,
  moveLineEnd,
  moveBufferStart,
  moveBufferEnd,
  moveWordLeft,
  moveWordRight,
  undo,
  redo,
  historyPrev,
  historyNext,
  historySearch,
  submit,
  resolveEnter,
  vimKey,
  renderEditor,
} from './editor.ts';
export type {
  EditorState,
  EditorConfig,
  EditorView,
  Cursor,
  VimMode,
  EnterAction,
  HistoryMatch,
} from './editor.ts';

// Transcript inspector (UI-09).
export { TranscriptInspector } from './inspector.ts';
export type { InspectorRow } from './inspector.ts';
